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

- Child-webview absolute positioning is not fully honored, so the tab bar may render at the bottom and pointer events may not reach it.
- The `+` button's URL input is now an inline `.url-bar` overlay inside the 38 px tab bar, so clipping is fixed, but pointer events still may not reach the tab-bar webview on Linux.
- To exercise `open_browser_tab`, `activate_browser_tab`, `close_browser_tab`, and `shell_action` without tab-bar clicks, inject a timed test harness into `app/dist/tabs.html` (the tab-bar webview has the `allow-browser-tabs` permission).
- To verify `ResourceHud` hiding and SPA event dispatch, force `data-native-shell="true"` in `web/dist/index.html` and add a debug overlay; `WebviewBuilder::user_agent` may or may not take effect on Linux depending on the Tauri/wry version.
- WebKitGTK caches `tabs.html` aggressively. If edits to `app/dist/tabs.html` do not appear, delete `~/.local/share/com.ernest.claude-control.spike` before launch; if the cache still persists, load the file under a new name (e.g., `tabs3.html`) and update `app/src-tauri/src/tabs.rs` to match.
- `tabs.rs` `sync_tab_bar` must pass `window.updateTabs(list, activeId)` as two separate JSON arguments; passing a single JSON-array tuple makes `tabs.html` render empty tab buttons with no titles or active highlight.
