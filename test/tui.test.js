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

test('prettyModel shortens transcript model ids', () => {
  assert.equal(prettyModel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(prettyModel('claude-sonnet-4-6'), 'Sonnet 4.6');
  assert.equal(prettyModel(null), null);
  assert.equal(prettyModel('weird-id'), 'weird-id');
});
