#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Disposable Phase-A adoption spike: a native WKWebView shell whose only job is to
// load the already-shipped Claude Control SPA (frontendDist -> ../dist/index.html,
// which redirects to your tailnet URL). No custom commands, no IPC — the SPA runs
// exactly as it does in a browser.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Claude Control spike");
}
