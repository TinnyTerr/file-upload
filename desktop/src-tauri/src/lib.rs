use std::path::PathBuf;
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            stop_watching
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
