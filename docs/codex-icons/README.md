# Codex Icon Parity — Live Screenshots

These screenshots are live-rendered proof that PR #62 correctly uses the Codex
mark (not the Claude robot head) in both the session rail and the session-page
Working indicator.

## Screenshots

### `rail-codex-logo.png`

The `[data-kind="codex"]` session row in the rail, showing the Codex mark
alongside the session name. Captured from the running instance at
`http://127.0.0.1:4319/?token=audit123` with the `codex-audit:1.1` pane.

SVG path verified: `d` attribute starts with `M8.086` (official Codex mark).

### `working-indicator-codex.png`

The `.working-indicator` element on the Codex session page while Codex is
actively generating. Shows the Codex mark next to "Working..." text.

SVG path verified: `d` attribute starts with `M8.086` (official Codex mark,
not the Claude robot — confirms icon parity between idle rail icon and active
working state).

## Capture details

- Captured via Playwright (deviceScaleFactor 2) against PR #62 built bundle
- Codex CLI session: tmux target `codex-audit:1.1`, kind=codex
- Both `.working-claude` (icon span) and `.pane-icon[data-kind="codex"]` (rail
  icon) render the same `M8.086…` path
- Captured on the `feat/codex-polish` branch
