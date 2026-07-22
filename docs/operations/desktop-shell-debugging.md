# Desktop shell (Tauri) — debugging & testing strategy

The desktop app is a Tauri v2 WKWebView shell around the SPA (`app/`). Being a
native app, neither browser devtools nor the web test stack reach it directly.
This is the map of what does.

## Live debugging the shell's webview

Two independent ways in, both giving the full Safari Web Inspector (console,
elements, network, the works) against the running app:

1. **Devtools feature (baked in):** `app/src-tauri/Cargo.toml` enables
   `tauri = { features = ["devtools"] }` — right-click → *Inspect Element*
   works even in release builds.
2. **Safari attach (no rebuild needed):**
   ```
   defaults write com.ernest.claude-control.spike WebKitDeveloperExtras -bool true
   ```
   then relaunch the app; it appears under Safari → Develop → <machine name>.
   Works on any WKWebView app, including builds that predate the devtools flag.

The Rust side logs to stderr (visible when launched from a terminal:
`"/Applications/Claude Control.app/Contents/MacOS/claude-control-spike"`), and
the supervised local server logs to `~/.claude-control/logs/app-server.log`.

## The lesson that prompted this doc: native seams eat web events

Session-rail drag-and-drop silently broke in the shell while working in every
browser. Root cause was not web code: Tauri's `dragDropEnabled` window option
(default **true**) installs a native NSView drag handler that **disables DOM
drag-and-drop entirely** — dragstart fires, but dragover/drop are consumed
before WKWebView sees them (tauri-apps/tauri#14373, #6695). Fix:
`"dragDropEnabled": false` in the window config (both `tauri.conf.json` and
`tauri.macos.conf.json` — the macOS overlay's `windows` array *replaces* the
base one). Config only — the Rust `WebviewWindowBuilder.drag_and_drop(false)`
path is broken upstream (#13761). Tradeoff: Tauri's native file-drop events
(`onDragDropEvent`) stop firing; the SPA uses HTML5 drop for uploads anyway,
so DOM handling is what we want.

The class of bug to internalize: **anything involving native input seams
(drag-drop, IME, context menus, file pickers, notifications, window chrome)
can differ between the shell and Safari — even though the engine is the same.**
Web-level tests cannot see these seams.

## Testing strategy (what runs where)

| Layer | Tool | Covers |
|---|---|---|
| SPA logic + components | vitest (existing suite) | everything engine-agnostic |
| Engine parity (Safari family) | Playwright **webkit** project against the served SPA | WebKit-specific web behavior (layout, CSS, JS APIs) |
| Shell Rust logic | `cargo test` in `app/src-tauri` (supervisor fixture + live tests) | probe/spawn/supervise/kill |
| Native seams (this doc's bug class) | **no automated option on macOS** — see below | drag-drop, notifications, chrome, IME |

**Why no WebDriver E2E:** Tauri's official E2E path (`tauri-driver`) supports
Linux (WebKitWebDriver) and Windows (Edge Driver) but **not macOS** — wry's
WKWebView exposes no WebDriver endpoint there. Until that changes, macOS shell
coverage is:

1. **Playwright-webkit** for everything web-visible (same engine, no shell).
2. **`cargo test`** for shell logic (keep new Rust behavior fixture-tested).
3. **A manual smoke checklist** for native seams, run after shell-affecting
   changes: window drag (HUD), traffic lights, rail row drag→drop on a group
   header, composer file drop, a notification click deep-link, splash Esc,
   local-server mode start/adopt.
4. Web Inspector attach (above) when a seam misbehaves.

If macOS WebDriver lands upstream, revisit; an AppleScript/XCUITest harness is
possible but has poor cost/benefit for a single-operator app today.
