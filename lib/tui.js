// lib/tui.js — parse the Claude Code TUI status line from a capture-pane dump.
//
// The bottom of a Claude session renders a status line such as:
//   /claude-cockpit Opus 4.8 (1M context) ctx:35%      Remote Control active
// and a title rule line such as:
//   ───────────────────── auto-cleanup-uploads ──
// We extract the model label, the context-remaining percentage, and (best
// effort) the title. All fields are optional — older/narrower panes may omit them.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CTX_RE = /ctx:\s*(\d+)\s*%/i;
const MODEL_RE = /\b(Opus|Sonnet|Haiku)\s+[\d.]+(?:\s*\([^)]*\))?/i;

/**
 * @param {string} capture  raw `tmux capture-pane -p` output (ANSI ok)
 * @returns {{ ctxPct: number|null, model: string|null }}
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

  return { ctxPct, model };
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
