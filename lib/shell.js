/**
 * lib/shell.js — per-session "sister" shell panes for the composer's terminal
 * mode (>_). Each Claude session gets its OWN scratch shell, created on demand
 * as a pane in that session's window (so it shares the window and inherits the
 * cwd), and reused thereafter. Marked with the pane option `@cc_shell` so it can
 * be found again. It's a real PTY (tmux), so interactive flows (npm login,
 * prompts, OTP) work.
 *
 * Security: same posture as the rest of the app — WS traffic is token-gated and
 * bound to 127.0.0.1 / the tailnet; this is no broader than the existing ttyd
 * escape hatch. Commands run as the server user.
 */
import * as tmux from './tmux.js';
import { readConfig } from './config.js';

/** "0:1.2" → "0:1" (drop the pane index to address the window). */
function windowOf(target) {
  return String(target || '').replace(/\.\d+$/, '');
}

/**
 * Opinionated, deterministic 6-char pairing hash (FNV-1a → base36). Seeded by
 * the agent window's stable tmux id (`@N`), so the same window always yields the
 * same hash — the agent + its shell window pair as `<hash>-agent` / `<hash>-term`.
 *
 * @param {string} seed  stable window identity (tmux window_id, e.g. "@5")
 * @returns {string} six lowercase base36 chars
 */
export function pairHash(seed) {
  let h = 0x811c9dc5;
  const s = String(seed);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

/** Window names for an agent/term pair given the agent window's stable id. */
export function pairNames(windowId) {
  const hash = pairHash(windowId);
  return { hash, agentName: `${hash}-agent`, termName: `${hash}-term` };
}

/** Find the reusable sister-shell pane for a term window name (pure selector). */
export function findSisterPane(panes, termName) {
  return (
    (panes || []).find(
      (p) => p.ccShell && p.windowName === termName && tmux.isValidTarget(p.target),
    ) || null
  );
}

// Control keys the UI may send (mirrors the `promptkey` allow-list philosophy —
// the command body goes through send-keys -l as literal text; only these named
// keys are interpreted). The set is generated but still a closed allow-list:
// every value is a known tmux send-keys token, so no arbitrary key-name injection.
// Covers the on-screen key bar (arrows / Tab / Esc / Ctrl-* / Home / End / paging)
// so a phone keyboard can reach keys it can't physically produce.
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');
const NAMED_KEYS = [
  'Enter', 'Tab', 'BTab', 'Escape', 'BSpace', 'DC', 'IC', 'Space',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
];
// Navigation keys with every Ctrl/Meta/Shift modifier combination, so a hardware
// keyboard (e.g. iPad Magic Keyboard) can send Opt+Arrow word-jumps, Shift+Arrow
// selection, etc. Prefix order is C-,M-,S- (matches the frontend navToken).
const NAV_KEYS = ['Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PPage', 'NPage'];
const NAV_PREFIXES = ['', 'C-', 'M-', 'S-', 'C-M-', 'C-S-', 'M-S-', 'C-M-S-'];
const NAV_COMBOS = NAV_KEYS.flatMap((k) => NAV_PREFIXES.map((p) => p + k));

export const SHELL_KEYS = new Set([
  ...NAMED_KEYS,
  ...NAV_COMBOS, // Up/Down/.../NPage with C-/M-/S- combinations
  ...ALPHA.map((c) => `C-${c}`), // C-a .. C-z
  ...ALPHA.map((c) => `M-${c}`), // M-a .. M-z (Option/Meta)
]);

/**
 * Ensure the sister shell pane for a session exists; return its target.
 *
 * The shell lives in its OWN tmux window — `<hash>-term` — NOT a split of the
 * agent's window. A side-by-side split halves the agent pane's columns, which
 * wraps the TUI and starves question/picker parsing; a separate window keeps the
 * agent pane full width. The two windows pair by a 6-char hash derived from the
 * agent window's stable tmux id: the agent window is renamed `<hash>-agent` (once,
 * on first `>_` use — a later `/rename` then sticks because the term window now
 * exists and we early-return before re-touching the name), and the shell window
 * is `<hash>-term`, marked `@cc_shell` for reuse.
 *
 * @param {string} sessionTarget  e.g. "0:1.1" (the Claude pane)
 * @param {string} [cwd]
 * @returns {Promise<string>} sister shell pane target
 */
export async function ensureSessionShell(sessionTarget, cwd) {
  const win = windowOf(sessionTarget);
  const dir = typeof cwd === 'string' && cwd ? cwd : readConfig().defaultCwd;

  let panes = [];
  try {
    panes = await tmux.listPanes();
  } catch {
    // degraded: no pane list — fall through and create against `win`.
  }

  const agentPane = panes.find((p) => windowOf(p.target) === win) || null;
  const { agentName, termName } = pairNames(agentPane?.windowId || win);

  // Reuse the existing paired term window's shell pane.
  const sister = findSisterPane(panes, termName);
  if (sister) return sister.target;

  // First `>_` for this agent: pair the windows by hash. Rename the agent window
  // `<hash>-agent` (best-effort), then create the SEPARATE `<hash>-term` window so
  // the agent pane keeps the FULL window width.
  if (agentPane && win && tmux.isValidTarget(`${win}.0`)) {
    try {
      await tmux.renameWindow(win, agentName);
    } catch {
      // non-fatal: pairing is a nicety, the shell still works unnamed.
    }
  }
  const target = await tmux.createWindow({ cwd: dir, name: termName });
  if (!tmux.isValidTarget(target)) throw new Error('shell: invalid pane target');
  await tmux.setPaneOption(target, '@cc_shell', '1');
  return target;
}

/** Run a command line (literal text + Enter) in the session's sister shell. */
export async function shellInput(sessionTarget, cwd, line) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendText(target, String(line ?? ''));
}

/** Forward literal keystroke text (NO Enter) for raw passthrough typing. */
export async function shellText(sessionTarget, cwd, text) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendLiteral(target, String(text ?? ''));
}

/** Send one allow-listed control key (e.g. C-c). Throws on anything else. */
export async function shellKey(sessionTarget, cwd, key) {
  if (!SHELL_KEYS.has(key)) throw new Error('key not allowed');
  const target = await ensureSessionShell(sessionTarget, cwd);
  await tmux.sendRawKeys(target, [key]);
}

/** Capture the sister shell pane WITH ANSI escapes for the colored live view. */
export async function shellCapture(sessionTarget, cwd, lines = 200) {
  const target = await ensureSessionShell(sessionTarget, cwd);
  const n = Math.max(1, Math.min(10000, Number(lines) || 200));
  // escapes=true (keep ANSI colors), join=true (rejoin soft-wrapped lines so
  // URLs split across narrow pane columns are reconstructed as single <a> tags).
  return tmux.capturePane(target, n, true, true);
}
