---
name: Testing the Tauri desktop shell for Claude Control
description: |
  How to build, launch, and end-to-end test the Tauri desktop shell in
  /home/ubuntu/repos/claude-control, including native tab-bar verification
  and Linux-specific workarounds.
---

# Testing the Tauri desktop shell for Claude Control

## Devin secrets needed

None. The test runs entirely against the local checkout and a local `node server.js`.

## Build

1. Build the SPA: `cd /home/ubuntu/repos/claude-control/web && npm run build`
2. Build the Tauri binary: `cd /home/ubuntu/repos/claude-control/app/src-tauri && cargo build`

## Launch the local SPA server

Run `node server.js` from the repo root. It serves `web/dist` on `http://127.0.0.1:4317/`.

## Auto-connect the splash

The splash is `app/dist/index.html`. For hands-off testing, set `CONFIGURED` to the local SPA:

```javascript
const CONFIGURED = "http://127.0.0.1:4317/";
```

Then rebuild `cargo build` so the edited splash is embedded.

## Clear WebKit storage between runs

```bash
rm -rf ~/.local/share/com.ernest.claude-control.spike
mkdir -p ~/.local/share/com.ernest.claude-control.spike
```

Tauri/WebKitGTK caches `index.html` aggressively; clearing this directory is the fastest way to pick up changes to `app/dist/index.html` and `tabs.html`.

## Run the desktop app

```bash
cd /home/ubuntu/repos/claude-control
./app/src-tauri/target/debug/claude-control-spike
```

On Linux you may need to disable the WebKit sandbox:

```bash
WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 ./app/src-tauri/target/debug/claude-control-spike
```

## Known Linux limitations and workarounds

- On Linux, child webviews are now reparented into a `gtk::Fixed` container and sized/moved to bounds in `tabs.rs`. This makes the tab bar a thin 38 px header at the top and lets the SPA/URL content fill the rest of the window.
- The `+` button's URL input is an inline `.url-bar` overlay inside the 38 px tab bar, so it is not clipped.
- Pointer events still may not reach the tab-bar webview on Linux, even with the GTK layout fix; be ready to fall back to a timed test harness in a temporary copy of `app/dist/tabs.html` (the tab-bar webview has the `allow-browser-tabs` permission).
- To verify `ResourceHud` hiding and SPA event dispatch, you can rely on the `navigator.userAgent.includes('ClaudeControlShell/')` check in `web/dist/index.html`; `WebviewBuilder::user_agent` does propagate the `ClaudeControlShell/` token. For tests, forcing `data-native-shell="true"` and adding a debug overlay is still useful.
- WebKitGTK caches `tabs.html` aggressively. If edits to `app/dist/tabs.html` do not appear, delete `~/.local/share/com.ernest.claude-control.spike` before launch; if the cache still persists, load the file under a new name (e.g., `tabs3.html`) and update `app/src-tauri/src/tabs.rs` to match.
- `tabs.rs` `sync_tab_bar` must pass `window.updateTabs(list, activeId)` as two separate JSON arguments; passing a single JSON-array tuple makes `tabs.html` render empty tab buttons with no titles or active highlight.
