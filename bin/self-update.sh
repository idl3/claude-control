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
PORT="${CLAUDE_CONTROL_PORT:-4317}"

# Triggered detached from the UI (or launchd), this can run under a stripped PATH
# where `node`/`npm` aren't found — the restart then silently no-ops AND the
# `npm install` steps below fail, leaving deps (e.g. `ws`) missing so the next
# boot crashes with ERR_MODULE_NOT_FOUND. Make node/npm resolvable across
# Homebrew, standard installs, and nvm (whose bins live outside any of those).
# ponytail: sources nvm + globs its newest version; fnm users set CLAUDE_CONTROL_NODE.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
if ! command -v node >/dev/null 2>&1; then
  _nvm_node="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$_nvm_node" ] && export PATH="$(dirname "$_nvm_node"):$PATH"
fi
NODE_BIN="${CLAUDE_CONTROL_NODE:-$(command -v node || true)}"

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

  if [ -z "$NODE_BIN" ]; then
    echo "FATAL: node not found on PATH (set CLAUDE_CONTROL_NODE) — server NOT restarted"
    exit 1
  fi
  nohup "$NODE_BIN" "$ROOT/server.js" > "$DATA_DIR/server.log" 2>&1 </dev/null &
  echo "restarted server pid $! (node: $NODE_BIN)"
} >> "$LOG" 2>&1
