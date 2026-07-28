import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTuiStatus, prettyModel, resolveModelLabel } from '../lib/tui.js';

test('parseTuiStatus extracts ctx% and model from a real status line', () => {
  const line = '    /claude-cockpit Opus 4.8 (1M context) ctx:35%         Remote Control active';
  const r = parseTuiStatus(line);
  assert.equal(r.ctxPct, 35);
  assert.equal(r.model, 'Opus 4.8 (1M context)');
});

test('parseTuiStatus tolerates a missing ctx indicator', () => {
  const r = parseTuiStatus('/olam-wt/rm-docker-world on  feat/x Opus 4.8 (1M context)');
  assert.equal(r.ctxPct, null);
  assert.equal(r.model, 'Opus 4.8 (1M context)');
});

test('parseTuiStatus handles ANSI and absent fields', () => {
  const r = parseTuiStatus('\x1b[2m some shell output \x1b[0m');
  assert.equal(r.ctxPct, null);
  assert.equal(r.model, null);
});

test('parseTuiStatus rejects out-of-range ctx', () => {
  assert.equal(parseTuiStatus('ctx:250%').ctxPct, null);
});

test('parseTuiStatus flags thinking when the working line is present', () => {
  const capture = [
    '> some prompt text',
    '',
    '✻ Cogitating… (12s · ↑ 3.2k tokens · esc to interrupt)',
  ].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, true);
});

test('parseTuiStatus flags thinking from the loader+timer (no "esc to interrupt")', () => {
  // High-effort / sub-agent states show the spinner + live timer but omit the
  // "esc to interrupt" hint. The "verb… (Ns" pattern must still read as working.
  const capture = '✛ Hyperspacing… (20s · still thinking with high effort)';
  assert.equal(parseTuiStatus(capture).thinking, true);
});

test('parseTuiStatus does NOT flag thinking on the idle "Brewed for" summary', () => {
  assert.equal(parseTuiStatus('✻ Brewed for 8h 2m 53s · 1 shell still running').thinking, false);
});

test('parseTuiStatus does not flag thinking at an idle prompt', () => {
  const capture = [
    '/claude-cockpit Opus 4.8 (1M context) ctx:35%      Remote Control active',
    '',
    '> ',
  ].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, false);
});

test('parseTuiStatus does NOT flag thinking on the AskUserQuestion picker (esc to cancel)', () => {
  const capture = [
    'Which option do you want?',
    '  1. Yes',
    '  2. No',
    '',
    '(↑↓ to select · enter to confirm · esc to cancel)',
  ].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, false);
});

// Regression: stale working lines in scrollback history must NOT keep the
// rainbow animation alive after generation ends.
//
// _pollThinking captures 26 lines (visible + history) so parsePanePrompt can
// find question pickers. If the full 26-line capture is scanned for thinking
// signals, a completed-turn working line that has scrolled into history — but
// is still within the 26-line window — would keep reporting thinking:true.
// The fix restricts the thinking scan to the last THINKING_SCAN_LINES (8).
test('parseTuiStatus does NOT flag thinking when working line is only in scrollback history', () => {
  // Simulates a post-completion pane: 20 lines of "above-visible" scrollback
  // (including a stale working line from the previous turn), followed by the
  // newly rendered answer and idle status bar.
  const staleHistory = [
    // older content above the visible area — scrollback history
    '> write me a poem',
    '',
    '✻ Cogitating… (3s · esc to interrupt)',
    ...Array(17).fill(''),
  ];
  const visibleArea = [
    'Here is a short poem for you:',
    '',
    '  Roses are red',
    '  Violets are blue',
    '',
    '/my-project Sonnet 4.6 (200k context) ctx:12%',
    '> ',
  ];
  const capture = [...staleHistory, ...visibleArea].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, false);
});

test('parseTuiStatus does NOT flag thinking when WORKING_TIMER_RE line is only in scrollback history', () => {
  // Same scenario but the stale line matches the loader+timer regex (no "esc to interrupt").
  const staleHistory = [
    '> explain async/await',
    '✛ Hyperspacing… (20s · still thinking with high effort)',
    ...Array(18).fill(''),
  ];
  const visibleArea = [
    'Async/await is syntactic sugar over Promises.',
    '',
    '/my-project Opus 4.8 (1M context) ctx:8%',
    '> ',
  ];
  const capture = [...staleHistory, ...visibleArea].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, false);
});

test('parseTuiStatus STILL flags thinking when working line is in the visible bottom 8 lines', () => {
  // The thinking signal must still fire when the working line is within the
  // visible (bottom 8) rows — i.e. generation is truly in progress.
  const capture = [
    ...Array(20).fill(''),  // padding to simulate a tall pane
    '> some prompt text',
    '',
    '✻ Cogitating… (12s · ↑ 3.2k tokens · esc to interrupt)',
    '',
    '',
  ].join('\n');
  assert.equal(parseTuiStatus(capture).thinking, true);
});

test('prettyModel shortens transcript model ids', () => {
  assert.equal(prettyModel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(prettyModel('claude-sonnet-4-6'), 'Sonnet 4.6');
  // Claude 5 family: undotted versions + `fable`. These previously fell through
  // and returned the RAW id, which also cost them their context window
  // (sessions.js resolves the window from this label).
  assert.equal(prettyModel('claude-fable-5'), 'Fable 5');
  assert.equal(prettyModel('claude-opus-5'), 'Opus 5');
  assert.equal(prettyModel('claude-sonnet-5'), 'Sonnet 5');
  assert.equal(prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  // Unfamiliar shapes still fall back to the raw id.
  assert.equal(prettyModel('weird-thing'), 'weird-thing');
  assert.equal(prettyModel(null), null);
  assert.equal(prettyModel('weird-id'), 'weird-id');
});

test('parseTuiStatus flags errored on an API error while idle', () => {
  const cap = [
    'Some earlier output.',
    '',
    'API Error: Server is temporarily limiting requests (not your usage limit) · Type 2b rate limited. Please try again later.',
    '',
    '> ',
  ].join('\n');
  const r = parseTuiStatus(cap);
  assert.equal(r.errored, true);
  assert.equal(r.thinking, false);
});

test('parseTuiStatus does NOT flag errored while the agent is still working', () => {
  // An error string scrolling by mid-generation must not trip the stall flag.
  const cap = [
    'thinking about API Error handling in the code',
    '✛ Working… (12s · esc to interrupt)',
  ].join('\n');
  const r = parseTuiStatus(cap);
  assert.equal(r.thinking, true);
  assert.equal(r.errored, false);
});

test('parseTuiStatus: ordinary prose mentioning errors does not trip errored', () => {
  const r = parseTuiStatus('Here is how to handle an error gracefully in your code.');
  assert.equal(r.errored, false);
});

// Regression: a narrow/wrapped tmux pane clips the status line mid-token. A
// real 81-column capture ("Opus 4.…") produces a half-parsed model, because
// MODEL_RE's [\d.]+ swallows the trailing dot but stops before the "…" that
// follows it. This is the raw mechanism that produced "Opus 4." in the rail —
// resolveModelLabel() (below) is what turns this parse result into a correct
// display label; parseTuiStatus itself is unchanged and still extracts the
// clipped text verbatim.
test('parseTuiStatus documents the clipped-pane mechanism: a wrapped status line yields a bare-dot model', () => {
  const line = '    /pleri-org/olam-wt/claudex-plan on  fix/billed-key-429-passthrough Opus 4.…';
  const r = parseTuiStatus(line);
  assert.equal(r.model, 'Opus 4.');
});

test('resolveModelLabel prefers the fallback when the TUI label ends in a bare trailing dot (clip lands mid minor-version)', () => {
  assert.equal(resolveModelLabel('Opus 4.', 'Opus 4.8'), 'Opus 4.8');
});

test('resolveModelLabel prefers the fallback when the TUI label is a strict prefix of it (clip lands before the dot)', () => {
  assert.equal(resolveModelLabel('Opus 4', 'Opus 4.8'), 'Opus 4.8');
});

test('resolveModelLabel falls back to null when the TUI label is truncated and no fallback is available', () => {
  assert.equal(resolveModelLabel('Opus 4.', null), null);
});

test('resolveModelLabel still prefers the TUI label when it carries extra decoration the fallback lacks (no precedence regression)', () => {
  assert.equal(resolveModelLabel('Opus 4.8 (1M context)', 'Opus 4.8'), 'Opus 4.8 (1M context)');
});

test('resolveModelLabel returns the fallback outright when there is no TUI label', () => {
  assert.equal(resolveModelLabel(null, 'Opus 4.8'), 'Opus 4.8');
});

test('resolveModelLabel returns null when neither source is available', () => {
  assert.equal(resolveModelLabel(null, null), null);
});

test('resolveModelLabel does NOT treat an exact match as truncated (whole-number family label)', () => {
  assert.equal(resolveModelLabel('Opus 5', 'Opus 5'), 'Opus 5');
});

test('resolveModelLabel does NOT treat a genuinely different (non-prefix) label as truncated', () => {
  // "Sonnet 4.6" is not a prefix of "Opus 4.8" (nor vice versa) — a stale/
  // mismatched cached label from a model switch is a different bug, out of
  // scope here; this only guards the SAME-family clip case.
  assert.equal(resolveModelLabel('Sonnet 4.6', 'Opus 4.8'), 'Sonnet 4.6');
});
