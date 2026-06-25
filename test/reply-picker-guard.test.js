import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefuseSendForPicker } from '../lib/picker-send-guard.js';

// A minimal non-null parsed picker to stand in for a real parsePanePrompt result.
const PICKER = { question: 'Choose an option', options: ['Yes', 'No'] };

test('refuses when picker is open in a claude tmux pane', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'claude',
    transport: 'tmux', // any non-print transport
    parsedPicker: PICKER,
  });
  assert.equal(result, true);
});

test('allows when no picker is open (parsedPicker is null)', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'claude',
    transport: 'tmux',
    parsedPicker: null,
  });
  assert.equal(result, false);
});

test('allows when viaAnswer is true even with a picker open', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: true,
    kind: 'claude',
    transport: 'tmux',
    parsedPicker: PICKER,
  });
  assert.equal(result, false);
});

test('allows when transport is print even with a picker present', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'claude',
    transport: 'print',
    parsedPicker: PICKER,
  });
  assert.equal(result, false);
});

test('allows when kind is codex even with a picker present', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'codex',
    transport: 'tmux',
    parsedPicker: PICKER,
  });
  assert.equal(result, false);
});
