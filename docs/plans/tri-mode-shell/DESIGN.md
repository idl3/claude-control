# Tri-Mode Shell — Baking the Cockpit Server into the Tauri Desktop App

**Status:** Design / go-no-go. Not an implementation.
**Author:** 100x-officer (Opus)
**Date:** 2026-07-20
**Scope:** Assess and design packaging that lets one Claude Control desktop app run as
(a) Server+Client on the primary device, (b) Client-only on secondary devices (today's
behavior), and (c) headless Server-only on a UI-less box.

---

## 1. Problem statement

The Claude Control **server** (`server.js` + `lib/*.js`, SPA in `web/dist`) today runs as a
launchd agent (`com.ernest.claude-control`, port 4317) installed from a git checkout via
`bin/install-service.sh`. The **desktop app** (`app/`, Tauri v2, branch `feat/desktop-app-spike`)
is a thin WKWebView shell that prompts for a tailnet URL and redirects — pure client, no server.

The ask: can **one Tauri app** subsume all three deployment shapes, so that installing the
`.app` is the whole story on the primary Mac (server + UI), stays exactly today's thin client on
secondary devices, and also serves a headless box?

The tension this design resolves: the server's entire *value* is reading the **host's** real
tmux sessions and `~/.claude/projects` — it is inherently host-coupled, not portable payload.
"Baking the server" therefore does not make it run *anywhere*; it changes the **install and
lifecycle vehicle**, trading `git clone + npm i + install-service.sh` for an app bundle. The
design question is which couplings survive that move, and whether a GUI app bundle is the right
vehicle for the headless case (spoiler: for mode (c) it is not — see §5/§6).

---

## 2. Investigated facts (file:line)

### 2.1 Server runtime dependencies (classified)

**Node package deps** — `package.json:51-56`:

| Dep | Kind | Classification |
|---|---|---|
| `node-pty@^1.1.0` | **Native C++ addon** | **Bundleable** — ships prebuilt N-API binaries |
| `web-push@^3.6.7` | Pure JS (VAPID via node crypto) | Bundleable |
| `ws@^8.21.1` | Pure JS | Bundleable |
| `zod@^4.4.3` | Pure JS | Bundleable |

- `node-pty` is the **only** native module and the single hardest packaging fact. Verified: it
  ships **prebuilt binaries** at `node_modules/node-pty/prebuilds/{darwin-arm64,darwin-x64,win32-*}/`
  (`pty.node` + `spawn-helper`); its `install` hook is `node scripts/prebuild.js || node-gyp
  rebuild`, i.e. prebuild-first, compile-fallback. On a matching arch **no compile is needed** —
  the `.node` is loaded via `process.dlopen` from a real file path. This is decisive: it favors a
  packaging option that keeps `node_modules` as real files over one that embeds them in a single
  executable.
- Runtime: **Node >= 20**, ESM (`package.json:45-47`, `"type":"module"`). `total node_modules ≈ 70 MB`.
- `node-pty` drives the terminal + agent mirror: one `tmux attach` pty per session
  (`lib/pty-bridge.js:1-16`). If `node-pty` fails to load, terminal + Cmd+J agent view die.

**External binaries spawned at runtime** (all resolved from host, never bundled meaningfully):

| Binary | Resolver | Classification |
|---|---|---|
| `tmux` | `resolveTmuxBin()` probes `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/usr/bin/tmux`, `COCKPIT_TMUX`, login-shell `command -v` (`lib/tmux.js:31-67`) | **Must-exist-on-host** |
| `claude` CLI | `resolveClaudeBin()` probes config, `which claude`, `~/.local/bin`, homebrew, `/usr/local`, `/usr/bin` (`lib/claude-cli.js:54-83`) | Must-exist-on-host (optional; degrades) |
| `codex`, MLX, ffmpeg/whisper, `tailscale` | various | Must-exist-on-host / optional |
| `lsof`, `ps`, `git` | system | Must-exist-on-host |

`tmux` is **deliberately never bundled**: the sessions being watched are the user's real,
host-global tmux server. A bundled tmux would attach to a different socket and see nothing. This
is why the launchd install pins `TMUX_TMPDIR` so the service's tmux finds the login session's
socket (`bin/install-service.sh:38-47`).

**Filesystem couplings** (all under `$HOME`, host-owned) — `server.js:105-160`:

- `~/.claude/projects` (`PROJECTS`) — transcript source; the whole point (`server.js:117-118`). **Must-exist-on-host.**
- `~/.claude-control/` (`DATA`) — `token`, `media/`, `uploads/`, `pins.json`, `icon.png`, `present/`, `logs/`, `update.log`. **Config/state**, created by server.
- `~/.codex/sessions` (`server.js:125-126`) — codex transcripts.
- tmux socket dir via `TMUX_TMPDIR`.

**Environment / launchd assumptions:**

- Config via `CLAUDE_CONTROL_*` with `COCKPIT_*` fallback (`server.js:90-91`). Port 4317, host
  `127.0.0.1` (`server.js:115-116`).
- **Token**: `CLAUDE_CONTROL_TOKEN` env → else persisted `~/.claude-control/token` → else
  **tokenless** (`server.js:105-112,138`; `lib/auth.js:1-16,32-41`). A freshly spawned server
  reads the **same** token file → same auth, **no new provisioning needed**.
- launchd plist injects `PATH` (so tmux resolves under the stripped launchd PATH), `TMUX_TMPDIR`,
  `HOME`, `PORT`, `TOKEN` (`bin/install-service.sh:59-86`). Tokenless-by-default; Tailscale
  `serve` exposes it on the tailnet (`:91-97`).
- **Full Disk Access**: a launchd service has no FDA, so panes get "Operation not permitted" on
  `~/Documents` etc. until FDA is granted **to the node binary** (`bin/install-service.sh:117-127`).
  A `.app` that spawns node inherits the **app's** TCC identity instead — see §7 risk 4.

### 2.2 Collision + lifecycle machinery already in the server

- **`reap-siblings`** (`lib/reap-siblings.js:92-117`, port-scoping note `:15-33`): at boot the
  server SIGTERMs any *other* `node server.js` process **bound to the same port** (confirmed via
  `lsof`, not env/cmdline). Same-script-but-different-port instances are **left alone**. Escape
  hatch `CLAUDE_CONTROL_NO_REAP=1`. **Direct consequence:** if the app spawns its own server on
  4317 while the launchd instance runs, one reaps the other → flapping outage. Adopt-first
  (below) is the mitigation.
- **Update model is git-based**: `self-update.sh` does `git pull --ff-only` + `npm install` +
  `npm run build` + relaunch (`bin/self-update.sh:37-61`); `version.js` computes
  "update available" by comparing HEAD against `origin/<branch>` and states plainly *"claude-control
  is distributed as a git checkout and updates via git pull"* (`lib/version.js:1-13,86-106`). A
  baked (non-git) server makes `self-update.sh` no-op ("not a git checkout — skipping") — the
  update path **must** be replaced for baked mode.
- **Entry points**: `server.js` runs `main()` when executed directly; `bin/cli.js`
  `start` imports and calls `main()` (`bin/cli.js:80-90`). `bin/cli.js` already wraps
  `install-service` (`:57`). npm `bin: claude-control → bin/cli.js` (`package.json:19-21`),
  `files` allow-list already packages `server.js`, `lib/`, `web/dist/`, `bin/` for `npm publish`
  (`package.json:22-32`).

### 2.3 Tauri shell today

- `tauri.conf.json`: identifier `com.ernest.claude-control.spike`, `frontendDist ../dist` (the
  splash), single window, UA carries `ClaudeControlShell/0.0.1` (SPA sniffs this — see
  `web/src/lib/nativeShell.ts`, on `feat/native-shell`), `csp null`, bundle targets `["app","dmg"]`.
  **No** `externalBin`, **no** `resources`, **no** plugins configured (`tauri.conf.json:5-37`).
- `Cargo.toml`: `tauri v2`, `serde_json`, macOS `objc2` stack for notifications. **No**
  `tauri-plugin-shell`, `-updater`, `-cli`, or `-single-instance` (`Cargo.toml:10-18`).
- `main.rs`: thin — one `notify_session` command + `UNUserNotificationCenter` click delegate,
  gated on `is_bundled()` (`app/src-tauri/src/main.rs:27-31,136-164`). No server supervision, no
  tray, no CLI parsing, no window-less path.
- Capabilities: `default.json` + `remote-spa.json` (remote-origin IPC for `*.ts.net`).

### 2.4 Verified Tauri v2 packaging facts (recon, cited)

- **Sidecar** (`externalBin`): binaries must be **target-triple-suffixed**
  (`…-aarch64-apple-darwin`), spawned via `app.shell().sidecar("name")` (Rust) or
  `Command.sidecar()` (JS). **The docs do NOT state whether Tauri kills the sidecar on app exit**
  → must supervise + kill explicitly. [v2.tauri.app/develop/sidecar/]
- **Resources** (`bundle.resources`): folder notation (`"some-folder/"`) copies recursively,
  resolved at runtime via `app.path().resolve(x, BaseDirectory::Resource)`. Documented and stable.
  [v2.tauri.app/develop/resources/]
- **Updater** (`tauri-plugin-updater`): replaces the **entire app bundle** (`myapp.app.tar.gz`).
  **No differential / per-resource / per-sidecar patch mechanism exists** — updating a baked server
  = shipping a whole new `.app`. [v2.tauri.app/plugin/updater/]
- **Single-instance** (`tauri-plugin-single-instance`): real; prevents a second app instance
  double-spawning a server. [v2.tauri.app/plugin/single-instance/]
- **Tray**: `TrayIconBuilder` documented — but **menubar-only / no-main-window** and macOS
  `ActivationPolicy::Accessory` (dock hiding) are **not in official docs** (community-only), and
  the CLI plugin doc says nothing about **headless launch**. Headless-in-Tauri is an
  undocumented path. [v2.tauri.app/learn/system-tray/, /plugin/cli/]
- **macOS signing**: main-bundle signing/notarization documented; **sidecar-specific** signing is
  community-only (unsigned sidecar → Gatekeeper block; a SEA/pkg binary needs manual
  `codesign`). [v2.tauri.app/distribute/sign/macos/]

---

## 3. Candidate architectures

All three keep **Client-only (mode b) byte-identical to today** (WKWebView → tailnet URL). They
differ only in how a **local server** is delivered for mode (a).

### Option A — SEA/pkg-compiled sidecar (`externalBin`)

Compile `server.js` + `lib` + deps into a single executable (Node SEA, `pkg`, or `bun build
--compile`), ship as a target-triple sidecar, spawn/kill from Rust.

- **Pros:** self-contained; no system Node required on host.
- **Cons:** **node-pty is a native addon** — SEA cannot embed `.node` files; you ship `pty.node`
  + `spawn-helper` beside the binary and `dlopen` them, per-arch, fighting the tool's asset
  model. The sidecar binary **must be individually codesigned + notarized** or Gatekeeper blocks
  it (recon: community-confirmed failure mode). Two arch builds. Highest build-system risk for the
  least benefit on a fleet that already has Node.

### Option B — Bundled resources + system Node (`bundle.resources`) ← recommended bake

Ship the `npm pack` file set (`server.js`, `lib/`, `web/dist/`, `bin/`, `node_modules/`) as Tauri
**resources**. At runtime Rust resolves the resource dir and spawns **system `node`** (resolved
exactly like `install-service.sh` does) against `server.js`, with env (`PATH`, `TMUX_TMPDIR`,
`HOME`, token). `node-pty`'s **prebuilt N-API** `pty.node` rides in `node_modules` — no compile.

- **Pros:** matches how the server already ships (`files` list is the same); native-module pain
  disappears (prebuilt N-API is ABI-stable across Node 20+); nothing extra to codesign beyond the
  `.node`/`spawn-helper` (which are signed as part of the bundle); simplest, lowest-risk bake.
- **Cons:** requires **system Node >= 20** on the host. On the **primary dev Mac this is a given**
  (it runs Claude Code). Larger bundle (~70 MB node_modules). Server updates are whole-`.app`
  releases via the Tauri updater (coarse vs git-pull).

### Option C — Supervise the existing checkout (adopt-or-spawn), no bake

Don't package the server at all. The app **detects** a healthy server on `127.0.0.1:4317` and
**adopts** it (client-only against localhost); if none, it spawns `node <resolved-checkout>/server.js`
as a supervised child. Keeps the git-checkout + `git pull` update model fully intact.

- **Pros:** **zero** packaging/signing work for the server; update model unchanged; validates the
  entire process model (health-probe, spawn, supervise, restart, log surface, token, kill-on-exit)
  **without touching packaging**. Ships in one session.
- **Cons:** does not remove the "clone + npm i somewhere" step — but on the primary device that
  step **already happened** (the launchd instance exists). This is really "the app becomes a smart
  supervisor + client," which is the correct **first** increment toward Option B.

---

## 4. Recommended architecture

**Conditional GO, re-scoped.** Reject the literal "one `.app`, three modes" framing. Adopt:

> **One server core, two delivery vehicles.**
> - **Tauri app = Client-first, with an optional supervised local server** for modes (a) and (b).
>   Reach the bake via Option C (supervise) → then Option B (resources + system Node).
> - **Headless mode (c) stays OFF Tauri** — it is served better by the *existing*
>   `npm i -g @idl3/claude-control` + `claude-control install-service` (launchd), plus a new
>   systemd unit for Linux. Same server code, different vehicle. (Rationale: §5/§6.)

### 4.1 Mode matrix

| | (a) Server+Client (primary) | (b) Client-only (secondary) | (c) Headless server-only |
|---|---|---|---|
| **Vehicle** | Tauri `.app` | Tauri `.app` (unchanged) | **Not Tauri** — npm CLI + launchd/systemd |
| **Server** | Adopt healthy `:4317`; else spawn+supervise (C → baked B) | none | `claude-control` service |
| **UI load** | WKWebView → server's own SPA at `127.0.0.1:4317/` | WKWebView → tailnet URL (today) | none |
| **Mode select** | first-run + "Run local server" affordance / `--server` intent | default (no server) | install script |
| **Auth** | reuse persisted `~/.claude-control/token` (or tokenless localhost) | tailnet token prompt (today) | token file / tokenless |
| **Update** | Tauri updater (whole `.app`) once baked; git-pull while on C | app store / updater | `npm i -g` / `git pull` |
| **Collision** | **adopt-first**; never spawn on an occupied healthy port | n/a | launchd/systemd owns it |

### 4.2 Key design decisions (with rationale)

1. **Adopt-first, never double-spawn.** The app health-probes `GET http://127.0.0.1:4317/` (a
   cheap version/health endpoint) with a short timeout. Healthy → **adopt** (client-only against
   it), spawn nothing. This sidesteps `reap-siblings` entirely (`lib/reap-siblings.js`): the app
   only spawns when **nothing** healthy is listening. If the operator wants an app-*owned* server
   while launchd also runs, use a **distinct port** (e.g. 4318) — never fight over 4317.

2. **In Server+Client, load the SERVER's SPA, not the bundled splash.** The WKWebView points at
   `127.0.0.1:4317/`, so the rendered UI version **always matches the server it talks to**. The
   bundled `../dist` splash is only the bootstrap/mode-picker. This eliminates SPA version skew by
   construction (see §7 risk 3).

3. **Token provisioning is nearly free.** A spawned server reads the same
   `~/.claude-control/token` (`server.js:105-112`); the localhost WKWebView uses the same token.
   New install with no token file → tokenless on the `127.0.0.1` bind (safe). The app may also
   write the token file / inject `CLAUDE_CONTROL_TOKEN` when spawning.

4. **Explicit supervision + kill-on-exit.** Tauri does **not** document sidecar/child teardown
   (recon gap). The Rust supervisor owns: spawn with correct env, restart-on-crash with backoff,
   surface `stdout/stderr` to a log the UI can open, and **kill the child on app exit / window
   close** (avoid orphans that `reap-siblings` would later fight). Add
   `tauri-plugin-single-instance` so a second app launch focuses the first rather than
   double-spawning.

5. **Headless is a parallel track, not a Tauri mode.** A GUI `.app` implies dock/login-item/window
   lifecycle; windowless + `ActivationPolicy::Accessory` + headless launch are **undocumented** in
   Tauri v2 (recon). A headless box (possibly Linux, possibly no GUI login session) is served
   correctly today by `install-service.sh` (launchd) — extend with a systemd unit. Forcing this
   into Tauri is pure cost (§7 risk 5).

---

## 5. Is a Tauri `.app` the right vehicle for headless (mode c)? — No.

Honest assessment, as the brief demands:

- The server already publishes as an npm package with a `claude-control` bin and a `files`
  allow-list that packs exactly what's needed (`package.json:19-32`). `npm i -g @idl3/claude-control
  && claude-control install-service` is a **complete** headless install today (`bin/cli.js:57`,
  `bin/install-service.sh`).
- Tauri buys headless **nothing**: no window is wanted, notifications are irrelevant, and the
  window-less/tray/accessory paths are undocumented (recon). It would *add* an app bundle,
  code-signing, and a GUI runtime to a box that wants none of them.
- **Boundary:** headless = the existing CLI + a new `systemd` unit (Linux) alongside the launchd
  path (macOS). The Tauri app and the headless install **share the one server codebase**; they are
  two vehicles, not two servers.

Design the boundary accordingly: keep `server.js`/`lib` vehicle-agnostic (it already is — every
coupling is env/config driven), and let each vehicle own only its lifecycle glue.

---

## 6. Phased implementation plan (single-session phases)

**Phase 1 — Supervisor + adopt-or-spawn (Option C). No packaging.** *(one session)*
- Add `tauri-plugin-shell` + `tauri-plugin-single-instance` (`Cargo.toml`, capabilities).
- Rust: health-probe `127.0.0.1:4317`; **adopt** if healthy (navigate WKWebView to it); else
  resolve `node` + checkout path and **spawn** `node server.js` with env (`PATH`, `TMUX_TMPDIR`,
  `HOME`, token); supervise (restart+backoff), surface logs, **kill-on-exit**.
- Front-of-app mode picker: Client-only (default, today's tailnet flow, **untouched**) vs "Run
  local server". `--server` launch intent for muscle-memory.
- Verify: (1) client-only unchanged; (2) adopt path never triggers `reap-siblings`; (3) spawn path
  boots, serves, and dies with the app (no orphan).

**Phase 2 — Bake the server as `bundle.resources` (Option B).** *(one session)*
- Build step: `npm pack` file set (`server.js`, `lib/`, `web/dist/`, `bin/`, `node_modules/`) → 
  `src-tauri/resources/server/`. Add to `bundle.resources`.
- Rust: resolve resource dir via `BaseDirectory::Resource`, spawn system `node` against it (same
  supervisor as Phase 1, just a different `server.js` path).
- Codesign `node_modules/node-pty/prebuilds/darwin-arm64/{pty.node,spawn-helper}` as part of the
  bundle; smoke-test a **pty attach** (terminal + Cmd+J agent mirror) on a clean machine.
- Wire `tauri-plugin-updater` for app+server as one artifact. Neuter in-UI "Update now" for baked
  mode (it would `git pull`-fail) → route to the Tauri updater.
- Verify: fresh `.app` on a machine with **no checkout** runs Server+Client end-to-end.

**Phase 3 — SEA/pkg sidecar (Option A). Deferred / gated.** *(only if a target host lacks Node)*
- Compile server to a sidecar, ship `pty.node`+`spawn-helper` alongside, codesign+notarize.
- **Likely YAGNI** for an all-Apple-Silicon, Node-present fleet. Gate on Open Question 1.

**Parallel track — Headless (mode c), not Tauri.** *(small, independent)*
- Keep `npm i -g` + `install-service.sh` (launchd). Add a `systemd` unit template for Linux boxes.
- No Tauri work.

---

## 7. Risks (severity P0–P3 × likelihood)

| # | Risk | Sev × Likelihood | Mitigation |
|---|---|---|---|
| 1 | App spawns its own server on 4317 while launchd runs → `reap-siblings` SIGTERMs the **live** service → outage (`lib/reap-siblings.js:92-117`) | **P1 × likely** (without adopt-first) → **unlikely** with it | **Adopt-first**; only spawn when nothing healthy on port; app-owned server uses a distinct port |
| 2 | `node-pty` native `.node` fails to load from bundled resources (arch/ABI, macOS quarantine, unsigned `.node`/`spawn-helper` exec bit) → terminal + agent mirror dead | **P1 × possible** | Ship prebuilt N-API (`prebuilds/darwin-arm64`, verified present); codesign `.node`+`spawn-helper`; CI smoke-test pty attach per arch |
| 3 | Tauri updater is whole-bundle only (recon) → server updates decouple from git-pull cadence; skew between baked server and a co-resident git checkout | **P2 × possible** | Adopt-first (one server at a time); WKWebView loads the **server's** SPA so UI never skews; updater owns the baked path, `git pull` owns the checkout path — never both |
| 4 | FDA/TCC: app-spawned `node` inherits the `.app`'s TCC identity; panes can't read `~/Documents` until FDA granted to Claude Control.app (`bin/install-service.sh:117-127`) | **P2 × likely** (one-time UX cost, not a defect) | First-run FDA prompt + doc; note a signed `.app` is a *cleaner* TCC grant target than a raw node binary |
| 5 | Headless-in-Tauri over-reach: build windowless/tray/accessory server mode that launchd/systemd does better; those paths are **undocumented** in Tauri v2 (recon) | **P2 × likely** (if taken literally) | Scope mode (c) **out** of Tauri (§5) |
| 6 | SEA sidecar (Option A only): unsigned sidecar → Gatekeeper block; native-addon embedding fights the toolchain | **P2 × likely** (Option A) | Choose Option B (no shipped binary); defer A behind Open Q1 |
| 7 | Scope creep vs the 2-week adoption gate | **P2 × possible** | Phase 1 ships standalone value (supervisor) without any packaging; bake is Phase 2 |

Probability-lens gate: risks 1 and 2 are the load-bearing ones (≥ gate); both are fully
mitigable in-design. Nothing here is a Halt-N/Halt-B — the premise (bake for a/b, not c) holds.

---

## 8. Open questions (gated on the operator)

1. **Fleet composition** — are all target devices Apple Silicon with system Node ≥ 20 present? If
   yes, Option B is sufficient and **Phase 3 (SEA sidecar) is dropped**. If any target lacks Node,
   Phase 3 comes back into scope.
2. **Primary-device ownership** — in Server+Client, **adopt** the launchd instance (recommended)
   or have the app **replace** launchd (uninstall the agent on first run and own the lifecycle)?
   Adopt is lower-risk; replace is cleaner long-term.
3. **Headless in scope now?** Recommend **defer** to the parallel non-Tauri track. Confirm.
4. **Signing** — is an Apple Developer ID cert available to notarize the `.app` (and, for Phase 3,
   the sidecar)? Distribution beyond this machine requires it.
5. **Update cadence** — acceptable that baked-server updates ship as whole-`.app` releases via the
   Tauri updater (coarse), replacing the current per-commit `git pull` (`bin/self-update.sh`)?

---

## 9. Go / no-go

**GO** — with the re-scope in §4: bake the server into the Tauri app for modes (a) and (b) via
**supervise-then-bake** (Option C → Option B), and **NO-GO on forcing mode (c) headless into
Tauri** — keep it on the existing npm/launchd (+ new systemd) vehicle. Start with Phase 1
(supervisor + adopt-or-spawn), which delivers Server+Client on the primary device **without any
packaging or update-model change**, and is fully reversible.
