#!/usr/bin/env bash
#
# claude-control self-update — invoked by POST /api/update (the in-UI "Update
# now" button). Pulls the latest source, reinstalls deps, rebuilds the web
# bundle, then restarts the server in place. Runs DETACHED from the server it
# restarts, so killing the old process can't kill this script.
#
# Inherits the server's env (token/port/host), so the relaunched server keeps
# the same configuration. All output goes to the update log.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

DATA_DIR="${CLAUDE_CONTROL_DATA:-$HOME/.claude-control}"
mkdir -p "$DATA_DIR"
LOG="$DATA_DIR/update.log"
PORT="${CLAUDE_CONTROL_PORT:-${COCKPIT_PORT:-4317}}"

{
  echo "=== self-update $(date) (port $PORT) ==="

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git pull --ff-only && echo "git pull ok" || echo "git pull skipped/failed"
  else
    echo "not a git checkout — skipping git pull"
  fi

  npm install --no-audit --no-fund && echo "root deps ok" || echo "root deps failed"
  ( cd web && npm install --no-audit --no-fund && npm run build ) \
    && echo "web build ok" || echo "web build failed"

  # Restart: stop whatever holds the port, then relaunch with the inherited env.
  OLD="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$OLD" ]; then kill $OLD 2>/dev/null || true; fi
  for _ in 1 2 3 4 5 6; do
    lsof -ti tcp:"$PORT" >/dev/null 2>&1 || break
    sleep 1
  done

  nohup node "$ROOT/server.js" > "$DATA_DIR/server.log" 2>&1 </dev/null &
  echo "restarted server pid $!"
} >> "$LOG" 2>&1
