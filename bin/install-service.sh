#!/usr/bin/env bash
# Install claude-control as a launchd service: auto-start on login, restart on
# crash, reading a persisted token so the phone URL stays stable across reboots.
# Idempotent — safe to re-run after pulling updates.
set -euo pipefail

LABEL="com.ernest.claude-control"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="$HOME/.claude-control"
TOKEN_FILE="$CONFIG_DIR/token"
LOG_DIR="$CONFIG_DIR/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CLAUDE_CONTROL_PORT:-4317}"

mkdir -p "$CONFIG_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"

# Token: reuse the existing one (keeps the bookmarked URL valid); else generate.
# Create the file with 0600 from the start (umask) so the secret is never briefly
# world-readable between creation and chmod.
if [ ! -s "$TOKEN_FILE" ]; then
  ( umask 077; node -e "console.log(require('crypto').randomBytes(16).toString('hex'))" > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  echo "generated a new token at $TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

# launchd runs with a minimal PATH — resolve absolute binaries and a PATH that
# lets the server find tmux.
NODE_BIN="$(command -v node)"
TMUX_BIN="$(command -v tmux 2>/dev/null || echo /opt/homebrew/bin/tmux)"
TMUX_DIR="$(dirname "$TMUX_BIN")"
SVC_PATH="$TMUX_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# launchd gives a LaunchAgent a different $TMPDIR than the login session, so the
# bundled tmux can't find the running server's socket (-> 0 sessions). Pin
# TMUX_TMPDIR to where the socket actually lives.
TMUX_TMPDIR_VAL="$("$TMUX_BIN" display-message -p '#{socket_path}' 2>/dev/null | sed -E 's#/tmux-[0-9]+/[^/]+$##')"
if [ -z "$TMUX_TMPDIR_VAL" ]; then
  for d in /private/tmp /tmp "${TMPDIR:-}"; do
    [ -n "$d" ] && [ -S "$d/tmux-$(id -u)/default" ] && { TMUX_TMPDIR_VAL="$d"; break; }
  done
fi
TMUX_TMPDIR_VAL="${TMUX_TMPDIR_VAL:-/tmp}"
echo "tmux socket dir: $TMUX_TMPDIR_VAL"

# Build the web bundle if absent (server falls back to public/ otherwise).
if [ ! -f "$REPO/web/dist/index.html" ]; then
  echo "building web bundle…"; (cd "$REPO" && npm run build)
fi

# Stop any manually-launched server already holding the port.
EXISTING="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$EXISTING" ]; then echo "stopping existing server (pid $EXISTING)"; kill $EXISTING 2>/dev/null || true; sleep 1; fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_CONTROL_TOKEN</key><string>$TOKEN</string>
    <key>CLAUDE_CONTROL_PORT</key><string>$PORT</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$SVC_PATH</string>
    <key>TMUX_TMPDIR</key><string>$TMUX_TMPDIR_VAL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Expose over Tailscale (tailnet-only HTTPS). Harmless if already configured.
if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --bg --https=443 "localhost:$PORT" >/dev/null 2>&1 || true
fi

HOSTDNS="$(tailscale status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write((JSON.parse(d).Self?.DNSName||"").replace(/\.$/,""))}catch{}})' 2>/dev/null || true)"

echo ""
echo "✓ claude-control installed as $LABEL (auto-starts on login, restarts on crash)"
echo "  logs:  $LOG_DIR/{out,err}.log"
echo "  token: $TOKEN_FILE"
if [ -n "$HOSTDNS" ]; then
  echo "  phone: https://$HOSTDNS/?token=$TOKEN"
else
  echo "  local: http://127.0.0.1:$PORT/?token=$TOKEN"
fi
