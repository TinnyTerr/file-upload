use std::{env, fs};

// SENTRY_DSN_DESKTOP comes from the repo-root .env (the process environment
// wins). Baked in at compile time; absent = Sentry off.
fn main() {
    println!("cargo:rerun-if-env-changed=SENTRY_DSN_DESKTOP");
    println!("cargo:rerun-if-changed=../../.env");
    let dsn = env::var("SENTRY_DSN_DESKTOP").ok().or_else(|| {
        fs::read_to_string("../../.env").ok().and_then(|f| {
            f.lines().find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == "SENTRY_DSN_DESKTOP")
                    .then(|| v.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            })
        })
    });
    if let Some(dsn) = dsn.filter(|d| !d.is_empty()) {
        println!("cargo:rustc-env=SENTRY_DSN_DESKTOP={dsn}");
    }
    tauri_build::build()
}
