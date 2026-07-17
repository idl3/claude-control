#!/usr/bin/env bash
# =============================================================================
# claude-control — one-shot installer for a clean macOS/Linux machine.
#
# Installs prerequisites (Node >=20 + tmux), installs the published
# @idl3/claude-control npm package globally, bootstraps ~/.claude-control
# (generates a token + a minimal config), and starts the server on port 4317
# as a launchd service (macOS) — mirroring the reference deployment.
#
# Idempotent + safe to re-run: existing tokens/configs are preserved, and each
# prerequisite is only installed when missing.
#
# Usage:
#   scripts/install.sh                 # published @latest, token auth, launchd
#   scripts/install.sh --no-service    # install + bootstrap, but don't start a service
#   scripts/install.sh --foreground    # start via nohup instead of launchd (fallback)
#   scripts/install.sh --tokenless     # don't generate a token (tailnet-only auth)
#
# Env overrides:
#   CC_PACKAGE_SPEC   npm spec to install (default: @idl3/claude-control@latest)
#   CLAUDE_CONTROL_PORT   server port (default: 4317)
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Config + flags
# -----------------------------------------------------------------------------
PKG_SPEC="${CC_PACKAGE_SPEC:-@idl3/claude-control@latest}"
PORT="${CLAUDE_CONTROL_PORT:-4317}"
CONFIG_DIR="$HOME/.claude-control"
TOKEN_FILE="$CONFIG_DIR/token"
CONFIG_FILE="$CONFIG_DIR/config.json"
LOG_DIR="$CONFIG_DIR/logs"

START_MODE="service"   # service | foreground | none
GEN_TOKEN=1
PROJECT_DIR=""   # set by configure_project_dir()
INTERACTIVE=0    # 1 when stdin is a TTY (configure_project_dir() prompted)

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-service) START_MODE="none" ;;
    --foreground) START_MODE="foreground" ;;
    --tokenless)  GEN_TOKEN=0 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"

# -----------------------------------------------------------------------------
# Homebrew (used when already present; bootstrapped best-effort for tmux only)
# -----------------------------------------------------------------------------
load_brew() {
  if command -v brew >/dev/null 2>&1; then return 0; fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$b" ]; then eval "$("$b" shellenv)"; return 0; fi
  done
  return 1
}

bootstrap_brew() {
  # Only attempted as a fallback for tmux. Homebrew's installer needs sudo to
  # create its prefix on a clean machine; over a non-interactive SSH session
  # that fails fast (rather than hanging), and we degrade to a documented
  # manual step. Never fatal.
  [ "$OS" = "Darwin" ] || return 1
  log "attempting non-interactive Homebrew install (needed for tmux)…"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    </dev/null >/dev/null 2>&1 || true
  load_brew
}

# -----------------------------------------------------------------------------
# Node >=20  — prefer an existing node, then brew, then nvm (sudo-free fallback)
# -----------------------------------------------------------------------------
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ]
}

install_node_via_nvm() {
  log "installing Node LTS via nvm (no sudo required)…"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts >/dev/null
  # Make the nvm node the default so the launchd service resolves a stable path.
  nvm alias default 'lts/*' >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
}

ensure_node() {
  if node_ok; then ok "node $(node -v) already present"; return; fi
  if load_brew; then
    log "installing Node via Homebrew…"
    brew install node
  else
    install_node_via_nvm
  fi
  node_ok || die "node >=20 still not on PATH after install"
  ok "node $(node -v) / npm $(npm -v)"
}

# -----------------------------------------------------------------------------
# tmux — required to drive real sessions (server boots + health passes without it)
# -----------------------------------------------------------------------------
ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then ok "tmux $(tmux -V) already present"; return; fi
  if load_brew || bootstrap_brew; then
    log "installing tmux via Homebrew…"
    if brew install tmux >/dev/null 2>&1; then ok "tmux $(tmux -V)"; return; fi
  fi
  if [ "$OS" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
    sudo apt-get install -y tmux >/dev/null 2>&1 && { ok "tmux $(tmux -V)"; return; }
  fi
  warn "tmux not installed automatically — the server will run and pass health"
  warn "checks, but you must 'brew install tmux' (macOS) / 'apt install tmux'"
  warn "(Linux) to see and drive live Claude sessions."
}

# -----------------------------------------------------------------------------
# Install the published package
# -----------------------------------------------------------------------------
install_pkg() {
  log "installing $PKG_SPEC globally…"
  npm install -g "$PKG_SPEC"
  # npm's global bin dir may not be on PATH yet in this shell.
  local gbin
  gbin="$(npm prefix -g 2>/dev/null)/bin"
  case ":$PATH:" in *":$gbin:"*) : ;; *) export PATH="$gbin:$PATH" ;; esac
  hash -r 2>/dev/null || true
  command -v claude-control >/dev/null 2>&1 \
    || die "claude-control not on PATH after install (looked in $gbin)"
  ok "claude-control $(claude-control --version) on PATH ($(command -v claude-control))"
}

# -----------------------------------------------------------------------------
# Primary project folder — asked once, interactively, so the FDA check below
# (and the starter config's defaultCwd) reflect where this operator actually
# works. Piped/non-interactive installs (curl | bash, CI, SSH with no TTY)
# skip the prompt and fall back to the same default without blocking.
# -----------------------------------------------------------------------------
configure_project_dir() {
  local default_dir="$HOME/Projects"
  if [ -t 0 ]; then
    INTERACTIVE=1
    local input=""
    printf '\033[1;36m▸ Primary project folder? [%s]: \033[0m' "$default_dir"
    IFS= read -r input || true
    input="${input:-$default_dir}"
    case "$input" in
      "~")   input="$HOME" ;;
      "~/"*) input="$HOME/${input#\~/}" ;;
    esac
    PROJECT_DIR="$input"
  else
    INTERACTIVE=0
    PROJECT_DIR="$default_dir"
  fi
}

# Resolve a path to its physical (symlink-free) form without relying on GNU
# `readlink -f` (macOS's BSD readlink doesn't support it). Works even when
# the path (or part of it) doesn't exist yet — walks up to the nearest
# existing ancestor, resolves that, and reattaches the missing remainder.
resolve_path() {
  local p="$1"
  case "$p" in
    /*)    : ;;
    "~")   p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
    *)     p="$PWD/$p" ;;
  esac
  p="${p%/}"
  [ -z "$p" ] && p="/"
  local remainder="" cur="$p"
  while [ ! -e "$cur" ] && [ "$cur" != "/" ]; do
    remainder="/$(basename "$cur")$remainder"
    cur="$(dirname "$cur")"
  done
  if [ -e "$cur" ]; then
    cur="$(cd "$cur" 2>/dev/null && pwd -P)" || cur="$p"
  fi
  printf '%s%s' "$cur" "$remainder"
}

# True (exit 0) when $1 resolves under a macOS TCC-protected location that a
# launchd-spawned node has no Full Disk Access to by default.
fda_required_for() {
  local resolved_dir resolved_root root
  resolved_dir="$(resolve_path "$1")"
  for root in "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads" "$HOME/Library/Mobile Documents"; do
    resolved_root="$(resolve_path "$root")"
    case "$resolved_dir" in
      "$resolved_root"|"$resolved_root"/*) return 0 ;;
    esac
  done
  return 1
}

# -----------------------------------------------------------------------------
# Bootstrap ~/.claude-control — token + minimal config (the package does NOT
# auto-generate either; a clean machine defaults to tokenless with no config).
# -----------------------------------------------------------------------------
gen_token() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24; return; fi
  node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))'
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

bootstrap_data() {
  mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$CONFIG_DIR/media" "$CONFIG_DIR/panes"
  chmod 700 "$CONFIG_DIR" 2>/dev/null || true

  if [ "$GEN_TOKEN" = "1" ]; then
    if [ -s "$TOKEN_FILE" ]; then
      ok "token already present ($TOKEN_FILE) — preserved"
    else
      gen_token > "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      ok "generated auth token → $TOKEN_FILE"
    fi
  fi

  if [ ! -f "$CONFIG_FILE" ]; then
    # defaultCwd: the chosen project folder when it already exists, else $HOME
    # (server.js/lib/config.js reads this as the cwd new sessions launch in).
    local default_cwd="$HOME"
    [ -n "$PROJECT_DIR" ] && [ -d "$PROJECT_DIR" ] && default_cwd="$PROJECT_DIR"
    # Minimal, valid config; server merges its own defaults over anything absent.
    cat > "$CONFIG_FILE" <<JSON
{
  "launchCommand": "claude",
  "defaultCwd": "$(json_escape "$default_cwd")"
}
JSON
    chmod 600 "$CONFIG_FILE"
    ok "wrote starter config → $CONFIG_FILE"
  else
    ok "config already present ($CONFIG_FILE) — preserved"
  fi
}

# -----------------------------------------------------------------------------
# Start the server
# -----------------------------------------------------------------------------
start_service() {
  log "installing launchd service (auto-start on login, restart on crash)…"
  CLAUDE_CONTROL_PORT="$PORT" claude-control install-service
  # A LaunchAgent loaded from a non-interactive SSH session doesn't always start
  # immediately (there's no Aqua/login session for RunAtLoad to fire into).
  # kickstart forces it once, now — harmless when it already started.
  if [ "$OS" = "Darwin" ]; then
    launchctl kickstart -k "gui/$(id -u)/com.ernest.claude-control" >/dev/null 2>&1 || true
  fi
}

start_foreground() {
  log "starting server in the background via nohup on port $PORT…"
  local node_bin server_js
  node_bin="$(command -v node)"
  server_js="$(npm root -g)/@idl3/claude-control/server.js"
  [ -f "$server_js" ] || die "cannot locate server.js at $server_js"
  local token=""
  [ -s "$TOKEN_FILE" ] && token="$(cat "$TOKEN_FILE")"
  CLAUDE_CONTROL_PORT="$PORT" CLAUDE_CONTROL_TOKEN="$token" \
    TMUX_TMPDIR="${TMUX_TMPDIR:-/private/tmp}" \
    nohup "$node_bin" "$server_js" >"$LOG_DIR/out.log" 2>"$LOG_DIR/err.log" &
  ok "server pid $! (logs: $LOG_DIR/{out,err}.log)"
}

verify_health() {
  local token="" auth=()
  [ -s "$TOKEN_FILE" ] && { token="$(cat "$TOKEN_FILE")"; auth=(-H "Authorization: Bearer $token"); }
  log "waiting for http://127.0.0.1:$PORT/api/health …"
  local code=000
  for _ in $(seq 1 30); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" \
      "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] && break
    sleep 1
  done
  if [ "$code" = "200" ]; then
    ok "health check: HTTP $code"
  else
    warn "health check returned HTTP $code (see $LOG_DIR/err.log)"
    return 1
  fi
}

# -----------------------------------------------------------------------------
# Optional post-install steps — neither is needed for the server or web UI to
# work; both are macOS-only conveniences for edge cases. Never fatal, never
# blocks the install.
# -----------------------------------------------------------------------------
tailscale_dnsname() {
  command -v tailscale >/dev/null 2>&1 || return 1
  local json
  json="$(tailscale status --json 2>/dev/null)" || return 1
  printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const n = j.Self && j.Self.DNSName;
        if (n) process.stdout.write(String(n).replace(/\.$/, ""));
      } catch (e) {}
    });
  ' 2>/dev/null
}

print_fda_status() {
  local node_bin="$1"
  if [ "$INTERACTIVE" = "1" ]; then
    if fda_required_for "$PROJECT_DIR"; then
      printf '\033[1;33m'
      echo "     ⚠ REQUIRED for your project folder:"
      echo "     ⚠   $PROJECT_DIR"
      echo "     ⚠ macOS treats this as a TCC-protected location (Documents, Desktop,"
      echo "     ⚠ Downloads, or iCloud Drive). claude-control runs as a launchd service,"
      echo "     ⚠ which does NOT inherit your terminal's Full Disk Access grant — agents"
      echo "     ⚠ will hit \"Operation not permitted\" reading files there until this is fixed."
      echo "     ⚠"
      echo "     ⚠ Fix: System Settings → Privacy & Security → Full Disk Access → + →"
      echo "     ⚠ press ⌘⇧G, paste this exact node path, add it, and toggle it on:"
      echo "     ⚠   $node_bin"
      echo "     ⚠"
      echo "     ⚠ Then restart the service:"
      echo "     ⚠   launchctl kickstart -k gui/$(id -u)/com.ernest.claude-control"
      printf '\033[0m'
    else
      printf '     \033[1;32m✓ FDA not required for %s\033[0m\n' "$PROJECT_DIR"
    fi
  else
    echo "     only if your agents/sessions read macOS-protected folders"
    echo "     (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive). Ordinary dev"
    echo "     work under ~/Projects etc. does NOT need this — skip it."
    echo "     If you hit it: System Settings → Privacy & Security → Full Disk Access"
    echo "     → + → ⌘⇧G → paste this exact node path → enable it:"
    echo "       $node_bin"
    echo "     Then restart the service so node relaunches with the grant:"
    echo "       launchctl kickstart -k gui/$(id -u)/com.ernest.claude-control"
    echo "     (why + full walkthrough: README → \"macOS Full Disk Access\")"
  fi
}

print_optional_next_steps() {
  [ "$OS" = "Darwin" ] || return 0
  local node_bin ts_host
  node_bin="$(command -v node)"
  ts_host="$(tailscale_dnsname || true)"

  echo ""
  ok "optional next steps — skip what doesn't apply; the server + web UI already work fully without them"
  echo ""
  echo "  1) Full Disk Access"
  print_fda_status "$node_bin"
  echo ""
  echo "  2) Tailscale HTTPS — optional pretty URL. Remote access already works"
  echo "     right now with no extra setup:"
  if [ -n "$ts_host" ]; then
    echo "       http://$ts_host:$PORT/"
  else
    echo "       http://<this-host>.<your-tailnet>.ts.net:$PORT/   (run 'tailscale status' for the exact name)"
  fi
  echo "     …or an SSH tunnel, no Tailscale required:"
  echo "       ssh -L 4318:localhost:$PORT <user>@<host> -N   # then open http://localhost:4318"
  echo "     For a tidy https://<host>/ URL instead of the .ts.net:$PORT form: enable"
  echo "     MagicDNS + HTTPS Certificates once in the Tailscale admin console, then:"
  echo "       tailscale serve --https=443 http://localhost:$PORT"
  echo ""
}

# -----------------------------------------------------------------------------
# Run
# -----------------------------------------------------------------------------
log "claude-control installer — package: $PKG_SPEC, port: $PORT, mode: $START_MODE"
configure_project_dir
ensure_node
ensure_tmux
install_pkg
bootstrap_data

case "$START_MODE" in
  service)    start_service; verify_health || true ;;
  foreground) start_foreground; verify_health || true ;;
  none)       log "skipping server start (--no-service)" ;;
esac

echo ""
ok "done."
echo "  data dir:  $CONFIG_DIR"
if [ "$GEN_TOKEN" = "1" ] && [ -s "$TOKEN_FILE" ]; then
  echo "  token:     $(cat "$TOKEN_FILE")   (enter at the login prompt, or append ?token=… once)"
else
  echo "  auth:      TOKENLESS (relies on 127.0.0.1 bind + tailnet ACL)"
fi
echo "  local URL: http://127.0.0.1:$PORT/"
echo "  health:    curl -H \"Authorization: Bearer <token>\" http://127.0.0.1:$PORT/api/health"

print_optional_next_steps
