#!/usr/bin/env bash
# Remove the claude-control launchd service. Leaves the token + uploads intact.
set -euo pipefail

LABEL="com.ernest.claude-control"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${CLAUDE_CONTROL_PORT:-4317}"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✓ removed $LABEL"
else
  echo "service not installed ($PLIST not found)"
fi

# Optional: stop tailscale serve for this port.
if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --https=443 off >/dev/null 2>&1 || true
  echo "  tailscale serve stopped"
fi
echo "  (token + uploads under ~/.claude-control are left in place)"
