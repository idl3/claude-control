import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTuiStatus, prettyModel } from '../lib/tui.js';

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
  assert.equal(prettyModel(null), null);
  assert.equal(prettyModel('weird-id'), 'weird-id');
});
