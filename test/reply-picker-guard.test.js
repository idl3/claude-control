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

// ---------------------------------------------------------------------------
// Codex-TUI keystroke panes: the predicate is now parser-agnostic. The caller
// runs parseCodexPrompt for codex panes and passes its result as parsedPicker;
// a Codex pane with an open picker must be refused, mirroring the Claude path.
// ---------------------------------------------------------------------------

test('refuses when picker is open in a codex tmux pane', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'codex',
    transport: 'tmux',
    parsedPicker: PICKER, // stand-in for a non-null parseCodexPrompt result
  });
  assert.equal(result, true);
});

test('allows when codex pane has no picker open (parsedPicker is null)', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'codex',
    transport: 'tmux',
    parsedPicker: null,
  });
  assert.equal(result, false);
});

test('allows when viaAnswer is true in a codex pane even with a picker open', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: true,
    kind: 'codex',
    transport: 'tmux',
    parsedPicker: PICKER,
  });
  assert.equal(result, false);
});

test('allows when kind is neither claude nor codex even with a picker present', () => {
  const result = shouldRefuseSendForPicker({
    viaAnswer: false,
    kind: 'shell',
    transport: 'tmux',
    parsedPicker: PICKER,
  });
  assert.equal(result, false);
});
