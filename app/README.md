# Claude Control — desktop app (Phase-A adoption spike)

A **disposable** native macOS shell that wraps the already-shipped Claude Control
web SPA in a WKWebView. Its only job: answer one question before we invest in a
real native head — **do you actually reach for a native app, or keep using the browser?**

- **Zero backend change.** The shell navigates to your `*.ts.net` Claude Control URL, an
  origin `server.js` already allows (`isAllowedOrigin`, server.js:314). Nothing on
  the server changes for this spike.
- **Zero SPA change.** It loads the same deployed SPA you use in a browser today.
- **Throwaway by design.** If the signal is negative, `rm -rf app/` and we keep web.

The real head (offline cache, global hotkeys, native notifications, signed
auto-update) is **Phase B** — only built if this spike earns it.

---

## 1. Install the toolchain (one-time)

Run these yourself in the session — prefix with `!` so the output lands here:

```bash
# Xcode Command Line Tools (provides the linker + system WKWebView headers)
! xcode-select --install    # skip if already installed

# Rust via rustup
! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
! source "$HOME/.cargo/env"

# Tauri v2 CLI
! cargo install tauri-cli --version '^2.0.0' --locked
```

Verify: `! cargo tauri --version` should print a `2.x` version.

## 2. Run it (daily-drive mode)

```bash
! cd app && cargo tauri dev
```

First launch shows a one-time prompt for your Claude Control URL — paste your tailnet
address and hit **Save & open**:

- **Recommended (HTTPS):** `https://<host>.ts.net/` — set up once with
  `tailscale serve --bg 4317`. HTTPS is needed for the mic to work
  (secure-context requirement; see the main README).
- Or plain: `http://<host>.ts.net:4317/`

The URL is stored locally, so subsequent launches go straight in. To hard-code it
instead of the prompt, set `CONFIGURED` at the top of `dist/index.html`.

`cargo tauri dev` needs no app icons. The first Rust build takes a few minutes;
after that it's instant.

## 3. (Optional) Build a real `.app` to keep in your Dock

```bash
# generate icons once from any square PNG (≥512px)
! cd app && cargo tauri icon path/to/icon.png
# then build the bundle
! cargo tauri build
```

Output: `app/src-tauri/target/release/bundle/macos/Claude Control.app` (drag to
`/Applications`) and a `.dmg`. Unsigned — Gatekeeper will ask you to allow it the
first time (right-click → Open). Signing/notarization is a Phase-B concern.

---

## What this measures (the adoption gate)

The shell keeps a **native-opens** counter (shown on the splash, stored on the
wrapper's local origin — separate from the SPA's own storage). It counts how
often you launched the native app. The signal is deliberately lightweight:
compare that count against how often you still open the browser.

- **Gate (OQ16): ≥30% of week-2 session-opens via the app** → build the Phase-B
  head. Week 1 is discarded as novelty.
- **Below 30% in week 2** → negative signal; the desktop app shrinks or dies, and
  we keep web as the first-class surface.

A precise server-side counter isn't built here on purpose — the server logs no
WS-connect user-agent today, and adding that is a Phase-B item, not something a
throwaway spike should touch.

## Teardown

```bash
git checkout main && git branch -D feat/desktop-app-spike   # if abandoning
# or just: rm -rf app/
```

## Files

- `dist/index.html` — the wrapper page (splash + first-run URL prompt + counter + redirect). The only real code here.
- `src-tauri/tauri.conf.json` — Tauri v2 config; `frontendDist: ../dist`, one 1280×860 window, CSP off (wrapper).
- `src-tauri/src/main.rs` — 6-line Tauri bootstrap, no custom commands/IPC.
- `src-tauri/Cargo.toml`, `build.rs`, `capabilities/default.json` — standard Tauri v2 scaffold.

> If your installed Tauri version rejects a field in `tauri.conf.json`, regenerate
> a known-good scaffold with `cargo tauri init` inside `app/` (point *frontend dist*
> at `../dist`, *dev server* at nothing), then re-apply `dist/index.html`.
