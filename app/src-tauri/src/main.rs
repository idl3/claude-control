#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Native shell for the Claude Control SPA (desktop spike, Phase-B features).
// Loads ../dist (splash → tailnet URL redirect) and owns the two things a
// WKWebView page cannot do itself:
//  - native notifications (WKWebView has no Web Push / Notification API)
//  - notification-click deep-links back into the SPA
// The SPA calls `notify_session` over remote-origin IPC (capabilities/
// remote-spa.json); clicks land in a UNUserNotificationCenter delegate that
// focuses the window and sets `location.hash = encodeURIComponent(sessionId)` —
// the SPA's existing hashchange router opens the session (mirrors sw.js).

#[cfg(target_os = "macos")]
mod notifications {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{ns_string, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationResponse, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use tauri::Manager;

    // UNUserNotificationCenter aborts in a non-bundled process (cargo tauri dev
    // runs the bare target/debug binary): notifications are release-.app-only.
    pub fn is_bundled() -> bool {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false)
    }

    pub struct Ivars {
        app: tauri::AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "CCNotificationDelegate"]
        #[ivars = Ivars]
        pub struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::Block<dyn Fn()>,
            ) {
                let session_id: Option<String> = unsafe {
                    let content = response.notification().request().content();
                    let user_info = content.userInfo();
                    let key: &AnyObject = ns_string!("sessionId").as_ref();
                    let val: Option<Retained<AnyObject>> =
                        msg_send![&*user_info, objectForKey: key];
                    val.and_then(|v| v.downcast::<NSString>().ok().map(|s| s.to_string()))
                };
                if let Some(sid) = session_id {
                    let app = self.ivars().app.clone();
                    let _ = app.clone().run_on_main_thread(move || {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.set_focus();
                            // encodeURIComponent to mirror App.tsx's own hash writes
                            // (session ids can contain '%', e.g. tmux pane ids).
                            if let Ok(json) = serde_json::to_string(&sid) {
                                let _ = w.eval(format!(
                                    "location.hash = encodeURIComponent({json})"
                                ));
                            }
                        }
                    });
                }
                completion.call(());
            }
        }
    );

    impl Delegate {
        fn new(app: tauri::AppHandle) -> Retained<Self> {
            let this = Self::alloc().set_ivars(Ivars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// Request authorization + install the click delegate. Call once at setup,
    /// from the main thread, only when bundled.
    pub fn init(app: tauri::AppHandle) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let opts = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;
        let auth_block =
            block2::StackBlock::new(|_granted: Bool, _err: *mut NSError| {}).copy();
        center.requestAuthorizationWithOptions_completionHandler(opts, &auth_block);

        let delegate = Delegate::new(app);
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly; keep it alive for the app's
        // lifetime.
        std::mem::forget(delegate);
    }

    pub fn notify(session_id: &str, title: &str, body: &str) {
        unsafe {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(body));
            let user_info: Retained<NSDictionary> = msg_send![
                objc2::class!(NSDictionary),
                dictionaryWithObject: &*NSString::from_str(session_id),
                forKey: ns_string!("sessionId")
            ];
            content.setUserInfo(&user_info);
            // Unique id per delivery; nil trigger = deliver immediately.
            let ident = NSString::from_str(&format!(
                "cc-{}-{}",
                session_id,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));
            let request =
                UNNotificationRequest::requestWithIdentifier_content_trigger(&ident, &content, None);
            center.addNotificationRequest_withCompletionHandler(&request, None);
        }
    }
}

mod server_supervisor;

use std::sync::Arc;

use server_supervisor::Supervisor;

/// Tri-mode Phase 1 (docs/plans/tri-mode-shell/DESIGN.md §6): adopt a healthy
/// local server, or spawn+supervise one from the git checkout. Async +
/// spawn_blocking because the spawn path blocks up to ~21s waiting for health.
#[tauri::command]
async fn start_local_server(
    sup: tauri::State<'_, Arc<Supervisor>>,
) -> Result<server_supervisor::StartResult, String> {
    let sup = Arc::clone(sup.inner());
    tauri::async_runtime::spawn_blocking(move || sup.start())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn local_server_status(
    sup: tauri::State<'_, Arc<Supervisor>>,
) -> Result<server_supervisor::Status, String> {
    let sup = Arc::clone(sup.inner());
    tauri::async_runtime::spawn_blocking(move || sup.status())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn notify_session(session_id: String, title: String, body: String) {
    #[cfg(target_os = "macos")]
    {
        if notifications::is_bundled() {
            notifications::notify(&session_id, &title, &body);
        } else {
            eprintln!("[shell] notify_session (dev, unbundled — skipped): {session_id}: {title}: {body}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (session_id, title, body);
    }
}

fn main() {
    let supervisor = Supervisor::new();
    let exit_supervisor = Arc::clone(&supervisor);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch → focus the existing window instead of a second
            // shell double-spawning a server (DESIGN.md §4.2 decision 4).
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(supervisor)
        .invoke_handler(tauri::generate_handler![
            notify_session,
            start_local_server,
            local_server_status
        ])
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            if notifications::is_bundled() {
                notifications::init(_app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Claude Control shell")
        .run(move |_app, event| {
            // Kill-on-exit: never leave an orphaned server for a later
            // launchd boot's reap-siblings to fight.
            if let tauri::RunEvent::Exit = event {
                exit_supervisor.shutdown();
            }
        });
}
