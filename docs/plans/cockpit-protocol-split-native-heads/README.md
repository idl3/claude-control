# cockpit-protocol-split-native-heads

Epic: one versioned protocol (zod, lib/protocol/) serving web + native heads; ttyd → in-process PTY bridge + in-app xterm.js; tmux control-mode replaces scraping; Tauri v2 macOS head. Plan: `~/.claude/plans/cockpit-protocol-split-native-heads.md` (pass 3, confidence 98). Design: `docs/design/cockpit-protocol-split-native-heads.md`.

| Phase | Tracker | Gate |
|---|---|---|
| A — PTY terminal + protocol seed + ttyd kill + A-spike | [phase-a-tasks.md](./phase-a-tasks.md) | M0 pre-gates; M1 AC1/AC2; M1.5 spike verdict |
| B — Control-mode integration | [phase-b-tasks.md](./phase-b-tasks.md) | pre-B spike GO; M2 AC4 |
| C — Protocol cutover + cache + handshake | [phase-c-tasks.md](./phase-c-tasks.md) | M3 AC3/AC5 |
| D — Minimal Tauri head | [phase-d-tasks.md](./phase-d-tasks.md) | M4/M5 AC6 |

## Out of scope
Harness app-server transport migration; olam adapter implementation; multi-host federation; scoped tokens; predictive echo (tripwire-gated); QUIC/WebTransport; iOS native; menubar/Raycast heads.
