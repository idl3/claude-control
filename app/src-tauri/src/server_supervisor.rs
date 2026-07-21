// Tri-mode Phase 1: adopt-or-spawn supervision of the cockpit server
// (docs/plans/tri-mode-shell/DESIGN.md §4.2, §6 Phase 1).
//
// Adopt-first is load-bearing: the server's reap-siblings SIGTERMs any other
// `node server.js` bound to the SAME port (lib/reap-siblings.js), so the app
// must never spawn beside a healthy listener. We probe first; only a dead port
// gets a spawn. Supervision restarts with capped exponential backoff, logs to
// ~/.claude-control/logs/app-server.log, and kills the child on app exit so no
// orphan is left for a later launchd boot to fight.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Supervisor {
    child: Mutex<Option<Child>>,
    shutting_down: AtomicBool,
}

#[derive(serde::Serialize)]
pub struct StartResult {
    pub url: String,
    /// true = an already-running server was adopted; false = we spawned one.
    pub adopted: bool,
}

#[derive(serde::Serialize)]
pub struct Status {
    pub healthy: bool,
    pub supervised: bool,
    pub port: u16,
    pub checkout: Option<String>,
    pub log_path: String,
}

fn data_dir() -> PathBuf {
    dirs_home().join(".claude-control")
}

fn dirs_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

/// Optional app config at ~/.claude-control/app.json:
/// { "serverCheckout": "/path/to/claude-cockpit", "serverPort": 4317 }
fn app_config() -> serde_json::Value {
    fs::read_to_string(data_dir().join("app.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

pub fn configured_port() -> u16 {
    app_config()
        .get("serverPort")
        .and_then(|v| v.as_u64())
        .map(|p| p as u16)
        .unwrap_or(4317)
}

/// Resolve the server checkout: explicit config wins; else the conventional
/// clone location, accepted only if it actually contains server.js.
fn resolve_checkout() -> Option<PathBuf> {
    if let Some(p) = app_config().get("serverCheckout").and_then(|v| v.as_str()) {
        let p = PathBuf::from(p);
        if p.join("server.js").is_file() {
            return Some(p);
        }
    }
    let conventional = dirs_home().join("Projects/claude-cockpit");
    if conventional.join("server.js").is_file() {
        return Some(conventional);
    }
    None
}

fn log_path() -> PathBuf {
    data_dir().join("logs/app-server.log")
}

fn read_token() -> Option<String> {
    let t = fs::read_to_string(data_dir().join("token")).ok()?;
    let t = t.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn server_url(port: u16) -> String {
    match read_token() {
        // ?token= is migrated into localStorage and stripped by the SPA
        // (web/src/lib/auth.ts migrateLegacyUrlToken).
        Some(t) => format!("http://127.0.0.1:{port}/?token={t}"),
        None => format!("http://127.0.0.1:{port}/"),
    }
}

/// Plain-TCP HTTP probe: anything answering with an HTTP status line counts.
/// No HTTP-client dependency; 4317 speaks plain HTTP locally.
pub fn probe(port: u16, timeout: Duration) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    if s
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(s.read(&mut buf), Ok(n) if n >= 8 && buf.starts_with(b"HTTP/"))
}

impl Supervisor {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> Status {
        let port = configured_port();
        Status {
            healthy: probe(port, Duration::from_millis(800)),
            supervised: self.child.lock().unwrap().is_some(),
            port,
            checkout: resolve_checkout().map(|p| p.display().to_string()),
            log_path: log_path().display().to_string(),
        }
    }

    /// Adopt-or-spawn. Returns the URL the webview should load.
    pub fn start(self: &Arc<Self>) -> Result<StartResult, String> {
        let port = configured_port();
        if probe(port, Duration::from_millis(1200)) {
            return Ok(StartResult {
                url: server_url(port),
                adopted: true,
            });
        }
        self.spawn_once(port)?;
        // Wait for the freshly-spawned server to come up.
        for _ in 0..70 {
            std::thread::sleep(Duration::from_millis(300));
            if probe(port, Duration::from_millis(500)) {
                return Ok(StartResult {
                    url: server_url(port),
                    adopted: false,
                });
            }
        }
        Err(format!(
            "server did not become healthy on 127.0.0.1:{port} within 21s — see {}",
            log_path().display()
        ))
    }

    fn spawn_once(self: &Arc<Self>, port: u16) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap();
        if guard.is_some() {
            return Ok(()); // already supervising (probably still booting)
        }
        let checkout = resolve_checkout().ok_or_else(|| {
            "no server checkout found — set serverCheckout in ~/.claude-control/app.json"
                .to_string()
        })?;
        let child = spawn_server(&checkout, port)?;
        eprintln!(
            "[supervisor] spawned node server.js (pid {}) on port {port} from {}",
            child.id(),
            checkout.display()
        );
        *guard = Some(child);
        drop(guard);

        // Watcher: restart on unexpected exit with capped exponential backoff;
        // a healthy 60s run resets the backoff.
        let sup = Arc::clone(self);
        std::thread::spawn(move || sup.watch(checkout, port));
        Ok(())
    }

    fn watch(self: Arc<Self>, checkout: PathBuf, port: u16) {
        // Poll try_wait() so the child lock is only ever held momentarily —
        // a blocking wait() under the mutex would deadlock shutdown().
        let mut backoff = Duration::from_secs(1);
        let mut started = std::time::Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(500));
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            let exited = {
                let mut guard = self.child.lock().unwrap();
                match guard.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(status)) => {
                            *guard = None;
                            Some(status.to_string())
                        }
                        Ok(None) => None, // still running
                        Err(_) => {
                            *guard = None;
                            Some("wait error".into())
                        }
                    },
                    // shutdown() took the child; nothing left to watch
                    None => return,
                }
            };
            let Some(code) = exited else { continue };
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(1); // healthy run — reset backoff
            }
            eprintln!(
                "[supervisor] server exited ({code}) — restarting in {}s",
                backoff.as_secs()
            );
            std::thread::sleep(backoff);
            backoff = (backoff * 2).min(Duration::from_secs(30));
            if self.shutting_down.load(Ordering::SeqCst) {
                return;
            }
            match spawn_server(&checkout, port) {
                Ok(c) => {
                    eprintln!("[supervisor] respawned server (pid {})", c.id());
                    started = std::time::Instant::now();
                    *self.child.lock().unwrap() = Some(c);
                }
                Err(e) => {
                    eprintln!("[supervisor] respawn failed: {e}");
                    return;
                }
            }
        }
    }

    /// SIGTERM the supervised child (graceful — matches what reap-siblings
    /// sends) and stop restarting. Called from the app's exit hook.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Some(child) = self.child.lock().unwrap().take() {
            let pid = child.id().to_string();
            let _ = Command::new("/bin/kill").args(["-TERM", &pid]).status();
        }
    }
}

pub(crate) fn spawn_server(checkout: &PathBuf, port: u16) -> Result<Child, String> {
    let logs = log_path();
    if let Some(dir) = logs.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let open_log = || {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&logs)
            .map_err(|e| format!("cannot open {}: {e}", logs.display()))
    };
    // A Finder-launched app inherits a bare PATH; the server needs brew's
    // node + tmux. Prepend the conventional tool dirs.
    let path = format!(
        "/opt/homebrew/bin:/usr/local/bin:{}/.local/bin:{}",
        dirs_home().display(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".into())
    );
    Command::new("/usr/bin/env")
        .arg("node")
        .arg("server.js")
        .current_dir(checkout)
        .env("PATH", path)
        // Post-rename (#363) the server reads CLAUDE_CONTROL_<X> only — a bare
        // PORT is silently ignored and the server would bind its 4317 default.
        .env("CLAUDE_CONTROL_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(open_log()?))
        .stderr(Stdio::from(open_log()?))
        .spawn()
        .map_err(|e| format!("failed to spawn node server.js: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal fixture standing in for server.js: honors CLAUDE_CONTROL_PORT
    /// (the real server's post-#363 env contract — bare PORT is ignored there)
    /// and answers HTTP. Testing supervisor mechanics against the real
    /// claude-control server would mutate the live registry/tmux state — the
    /// fixture keeps tests inert.
    fn fixture_checkout() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cc-sup-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("server.js"),
            "require('http').createServer((q,s)=>s.end('ok'))\n  .listen(Number(process.env.CLAUDE_CONTROL_PORT||0),'127.0.0.1');\n",
        )
        .unwrap();
        dir
    }

    #[test]
    fn probe_dead_port_is_false() {
        assert!(!probe(59999, Duration::from_millis(300)));
    }

    #[test]
    fn spawn_serves_and_dies_on_sigterm() {
        let checkout = fixture_checkout();
        let port = 59321;
        let mut child = spawn_server(&checkout, port).expect("spawn");
        let healthy = (0..50).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            probe(port, Duration::from_millis(300))
        });
        assert!(healthy, "fixture server never answered on {port}");
        // kill-on-exit path: SIGTERM (what shutdown() sends) must end it.
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        let gone = (0..30).any(|_| {
            std::thread::sleep(Duration::from_millis(100));
            matches!(child.try_wait(), Ok(Some(_)))
        });
        assert!(gone, "child survived SIGTERM");
        assert!(!probe(port, Duration::from_millis(300)), "port still serving after kill");
        let _ = fs::remove_dir_all(checkout);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    /// Adopt-path verification against a REAL healthy server on the configured
    /// port (this dev machine's launchd instance). Ignored by default: only
    /// meaningful where a live server is expected. Run: cargo test -- --ignored
    #[test]
    #[ignore]
    fn adopts_live_server_without_spawning() {
        let sup = Supervisor::new();
        let res = sup.start().expect("start");
        assert!(res.adopted, "expected adoption of the live server, not a spawn");
        assert!(res.url.starts_with("http://127.0.0.1:"));
        assert!(
            !sup.status().supervised,
            "adopt path must not leave a supervised child"
        );
    }
}
