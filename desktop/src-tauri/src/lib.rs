use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// Matches the client's `CHUNK_BYTES` in `downloadCore.ts`, so a resumed
/// download lines up on the same offsets the server already saw.
const CHUNK_BYTES: u64 = 8 * 1024 * 1024;

struct AppState {
    http: reqwest::Client,
    server_url: Mutex<Option<String>>,
    csrf_token: Mutex<Option<String>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FsChange {
    path: String,
    kind: String,
}

#[tauri::command]
fn set_server_url(state: State<AppState>, url: String) {
    *state.server_url.lock().unwrap() = Some(url);
}

#[derive(Serialize)]
struct LoginResult {
    status: String,
}

// mirrors the shape of POST /api/auth/login's response closely enough for a
// basic login (mfa_required flows aren't handled here yet)
#[tauri::command]
async fn login(state: State<'_, AppState>, username: String, password: String) -> Result<LoginResult, String> {
    let base = state
        .server_url
        .lock()
        .unwrap()
        .clone()
        .ok_or("server url not set")?;

    let resp = state
        .http
        .post(format!("{base}/api/auth/login"))
        .json(&serde_json::json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("login failed: {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(token) = body.get("csrf_token").and_then(|v| v.as_str()) {
        *state.csrf_token.lock().unwrap() = Some(token.to_string());
    }

    Ok(LoginResult {
        status: body
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("ok")
            .to_string(),
    })
}

#[tauri::command]
fn watch_folder(app: tauri::AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let app_handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        let kind = format!("{:?}", event.kind);
        for p in event.paths {
            let _ = app_handle.emit(
                "fs-change",
                FsChange {
                    path: p.to_string_lossy().to_string(),
                    kind: kind.clone(),
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&PathBuf::from(&path), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

#[tauri::command]
fn stop_watching(state: State<AppState>) {
    *state.watcher.lock().unwrap() = None;
}

/// `~/Downloads/fileupload`, created on first use. A user who never picks a
/// folder still gets a stable, predictable place for synced files to land.
#[tauri::command]
fn default_download_dir(app: tauri::AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("fileupload");
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base.to_string_lossy().to_string())
}

/// Raw passthrough of `GET /api/directories?scope=all&type=files` — the
/// frontend renders whatever shape the server returns rather than this side
/// re-declaring the file row type.
#[tauri::command]
async fn list_files(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let base = state
        .server_url
        .lock()
        .unwrap()
        .clone()
        .ok_or("server url not set")?;

    let resp = state
        .http
        .get(format!("{base}/api/directories?scope=all&type=files"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("listing failed: {}", resp.status()));
    }
    resp.json().await.map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: i64,
    downloaded: u64,
    total: u64,
}

/// Only `none`/`server` mode can be fetched here: `client`/`sealed` bytes are
/// ciphertext the server never held a key for, and decrypting them needs the
/// browser's WebCrypto worker, not this process.
#[tauri::command]
async fn download_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
    slug: String,
    original_filename: String,
    encryption_mode: String,
    access_key: Option<String>,
    dest_dir: Option<String>,
) -> Result<String, String> {
    if encryption_mode == "client" || encryption_mode == "sealed" {
        return Err(
            "end-to-end encrypted files can only be downloaded from the browser, which holds the key"
                .into(),
        );
    }

    let base = state
        .server_url
        .lock()
        .unwrap()
        .clone()
        .ok_or("server url not set")?;

    let dir = match dest_dir {
        Some(d) => {
            fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            PathBuf::from(d)
        }
        None => PathBuf::from(default_download_dir(app.clone())?),
    };

    // The filename is server-supplied metadata, not a path -- take only its
    // final component so it can't climb out of `dir`.
    let safe_name = PathBuf::from(&original_filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("file-{id}"));

    let final_path = dir.join(&safe_name);
    let part_path = dir.join(format!("{safe_name}.part"));

    let url = format!("{base}/file/{slug}/raw");
    let mut req_base = state.http.get(&url);
    if let Some(key) = &access_key {
        if encryption_mode == "server" {
            req_base = req_base.query(&[("ek", key)]);
        }
    }

    let mut downloaded = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .open(&part_path)
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(downloaded))
        .map_err(|e| e.to_string())?;

    let mut total: u64 = 0;
    loop {
        let range = format!(
            "bytes={}-{}",
            downloaded,
            downloaded + CHUNK_BYTES - 1
        );
        let resp = req_base
            .try_clone()
            .ok_or("request not cloneable")?
            .header("Range", range)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("download failed: {}", resp.status()));
        }

        let ranged = resp.status().as_u16() == 206;
        if let Some(cr) = resp
            .headers()
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.rsplit('/').next())
            .and_then(|s| s.parse::<u64>().ok())
        {
            total = cr;
        } else if let Some(len) = resp.content_length() {
            total = len;
        }

        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        let got = bytes.len() as u64;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        downloaded += got;

        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                id,
                downloaded,
                total,
            },
        );

        // A plain 200 (no ranges: a transformed blob, or a limited-use link)
        // is already the whole file in one shot -- same rule downloadCore.ts
        // applies in the browser.
        if !ranged || got == 0 || downloaded >= total {
            break;
        }
    }

    drop(file);
    fs::rename(&part_path, &final_path).map_err(|e| e.to_string())?;
    Ok(final_path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Held for the life of the app so queued events flush on drop. No DSN at
    // build time = disabled client, every call a no-op.
    let _sentry = sentry::init((
        option_env!("SENTRY_DSN_DESKTOP").unwrap_or(""),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            send_default_pii: false,
            ..Default::default()
        },
    ));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState {
            http: reqwest::Client::builder()
                .cookie_store(true)
                .build()
                .expect("failed to build http client"),
            server_url: Mutex::new(None),
            csrf_token: Mutex::new(None),
            watcher: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_server_url,
            login,
            watch_folder,
            stop_watching,
            default_download_dir,
            list_files,
            download_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
