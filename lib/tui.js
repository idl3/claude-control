// lib/tui.js — parse the Claude Code TUI status line from a capture-pane dump.
//
// The bottom of a Claude session renders a status line such as:
//   /claude-cockpit Opus 4.8 (1M context) ctx:35%      Remote Control active
// and a title rule line such as:
//   ───────────────────── auto-cleanup-uploads ──
// We extract the model label, the context-remaining percentage, and whether
// Claude is actively generating ("esc to interrupt" working line). All fields
// are optional — older/narrower panes may omit them.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CTX_RE = /ctx:\s*(\d+)\s*%/i;
const MODEL_RE = /\b(Opus|Sonnet|Haiku)\s+[\d.]+(?:\s*\([^)]*\))?/i;
// Claude is actively generating when the TUI shows the working line. Two signals:
//  1) "esc to interrupt" (the classic interruptible working line), OR
//  2) the loader+timer: a verb ending in "…" followed by a "(Ns" elapsed counter,
//     e.g. "✛ Hyperspacing… (20s · still thinking…)". This catches sub-agent /
//     high-effort states that omit "esc to interrupt".
// Neither matches the AskUserQuestion picker ("esc to cancel") nor the idle
// "Brewed for 8h" summary (no "…(Ns").
//
// IMPORTANT: these are only tested against the LAST THINKING_SCAN_LINES lines of
// the capture. _pollThinking captures 26 lines (visible + scrollback history) so
// that parsePanePrompt can find question pickers. Scanning the full 26 lines for
// thinking signals causes false positives: a completed-turn working line that has
// scrolled into history (but is still within the 26-line window) keeps matching
// after generation ends. Limiting to the bottom 8 lines covers the entire visible
// Claude TUI status area while excluding stale scrollback content.
const THINKING_RE = /esc to interrupt/i;
const WORKING_TIMER_RE = /…\s*\(\s*\d+\s*[smh]\b/;
const THINKING_SCAN_LINES = 8;
// Auto/manual compaction renders a distinct working line ("Compacting
// conversation…"). It can run for many seconds with no other output, so without
// a dedicated signal the UI looks hung. Treated as a busy sub-state of thinking.
const COMPACTING_RE = /compacting\b/i;

/**
 * @param {string} capture  raw `tmux capture-pane -p` output (ANSI ok)
 * @returns {{ ctxPct: number|null, model: string|null, thinking: boolean, compacting: boolean }}
 */
export function parseTuiStatus(capture) {
  const text = String(capture || '').replace(ANSI_RE, '');

  let ctxPct = null;
  const ctxMatch = text.match(CTX_RE);
  if (ctxMatch) {
    const n = Number(ctxMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 100) ctxPct = n;
  }

  let model = null;
  const modelMatch = text.match(MODEL_RE);
  if (modelMatch) model = modelMatch[0].replace(/\s+/g, ' ').trim();

  // Restrict the thinking-signal scan to the bottom THINKING_SCAN_LINES lines so
  // that stale working/timer lines in the scrollback history (above the visible
  // area) do not produce a false positive after generation ends.
  const lines = text.split('\n');
  const tail = lines.slice(-THINKING_SCAN_LINES).join('\n');
  const compacting = COMPACTING_RE.test(tail);
  // Compaction IS a busy state — fold it into thinking so the rail still reads
  // "working" even if the compaction line omits "esc to interrupt".
  const thinking = compacting || THINKING_RE.test(tail) || WORKING_TIMER_RE.test(tail);

  return { ctxPct, model, thinking, compacting };
}

/**
 * Prettify a transcript model id (e.g. "claude-opus-4-8") into a short label
 * ("Opus 4.8"). Falls back to the raw id when the shape is unfamiliar.
 *
 * @param {string|null} modelId
 * @returns {string|null}
 */
export function prettyModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  const m = modelId.match(/(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    return `${family} ${m[2]}.${m[3]}`;
  }
  return modelId;
}
