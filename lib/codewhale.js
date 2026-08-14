/**
 * CodeWhale TUI harness adapter.
 *
 * Phase 0 intentionally owns only the terminal-backed surface: identify a
 * CodeWhale process and build the command typed into its tmux pane. Native
 * Runtime HTTP/SSE support belongs in a separate transcript/controller adapter
 * so this module never pretends terminal capture is a structured transcript.
 */

function basename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop();
}

/**
 * True when a ps row belongs to a CodeWhale CLI/TUI process. Restrict argv
 * matching to the executable position (or the node wrapper's script position)
 * so a short-lived command such as `rg codewhale` cannot temporarily turn an
 * ordinary terminal into a CodeWhale session.
 */
export function matchesProcess(comm, args = '') {
  if (basename(comm) === 'codewhale') return true;
  const parts = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (basename(parts[0]) === 'codewhale') return true;
  return basename(parts[0]) === 'node' && basename(parts[1]) === 'codewhale';
}

/**
 * Build the interactive CodeWhale launch string typed into an already-cwd'd
 * tmux pane. `command` is operator-owned config and may be a shell alias;
 * `prompt` is always shell-quoted and follows `--` so dash-prefixed prompts
 * cannot be parsed as CLI flags.
 */
export function buildTuiLaunchCommand({ command = 'codewhale', prompt = '', quote }) {
  const launch = String(command || '').trim() || 'codewhale';
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) return launch;
  if (typeof quote !== 'function') throw new TypeError('quote is required when prompt is present');
  return `${launch} -- ${quote(text)}`;
}
