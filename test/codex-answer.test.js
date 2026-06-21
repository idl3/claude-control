// test/codex-answer.test.js — P4 parity: Codex capture-based approval flow.
//
// Tests cover:
//  1. detectPendingFromCapture against real fixtures (re-uses adapter directly,
//     duplicates minimal assertions to keep this file self-contained as the
//     parity-audit surface).
//  2. codexPendingToFrontend mapper.
//  3. frontendSelectionToNative + buildAnswerProgram routing.
//  4. Claude regression: buildAnswerProgram (lib/answer.js) unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../lib/agents/codex.js';
import { codexPendingToFrontend, frontendSelectionToNative } from '../lib/agents/codex-pending.js';
import { buildAnswerProgram as claudeBuildAnswerProgram } from '../lib/answer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(__dirname, 'fixtures', 'codex');

const execCapture = fs.readFileSync(path.join(FIX, 'pane-exec-approval.txt'), 'utf8');
const editCapture = fs.readFileSync(path.join(FIX, 'pane-edit-approval.txt'), 'utf8');
const headerOnlyCapture = execCapture.split('\n').slice(0, 8).join('\n'); // header block only, no modal

// ---------------------------------------------------------------------------
// 1. detectPendingFromCapture — fixture assertions (parity audit surface)
// ---------------------------------------------------------------------------

test('1a. exec-approval: pendingKind=exec_command, 3 options, option[0] highlighted, shortcuts y/p/esc', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  assert.equal(native.transcriptPending, true);
  assert.equal(native.pendingKind, 'exec_command');
  assert.equal(native.options.length, 3);
  assert.equal(native.options[0].highlighted, true);
  assert.equal(native.options[0].shortcut, 'y');
  assert.equal(native.options[1].shortcut, 'p');
  assert.equal(native.options[2].shortcut, 'esc');
});

test('1b. edit-approval: pendingKind=apply_patch, 3 options, shortcuts y/a/esc', () => {
  const native = CodexAdapter.detectPendingFromCapture(editCapture);
  assert.equal(native.transcriptPending, true);
  assert.equal(native.pendingKind, 'apply_patch');
  assert.equal(native.options.length, 3);
  assert.equal(native.options[0].shortcut, 'y');
  assert.equal(native.options[1].shortcut, 'a');
  assert.equal(native.options[2].shortcut, 'esc');
});

test('1c. non-modal capture (header block only): transcriptPending=false', () => {
  const native = CodexAdapter.detectPendingFromCapture(headerOnlyCapture);
  assert.equal(native.transcriptPending, false);
});

// ---------------------------------------------------------------------------
// 2. codexPendingToFrontend mapper
// ---------------------------------------------------------------------------

test('2a. maps exec native → frontend Pending with 1 question, multiSelect=false', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const fe = codexPendingToFrontend(native);
  assert.notEqual(fe, null);
  assert.equal(fe.questions.length, 1);
  assert.equal(fe.questions[0].multiSelect, false);
});

test('2b. option labels and descriptions are preserved from native options', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const fe = codexPendingToFrontend(native);
  assert.equal(fe.questions[0].options[0].label, 'Yes, proceed');
  assert.equal(fe.questions[0].options[0].description, 'key: y');
  assert.equal(fe.questions[0].options[1].description, 'key: p');
  assert.equal(fe.questions[0].options[2].description, 'key: esc');
});

test('2c. toolUseId is deterministic: same input produces same id across two calls', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const fe1 = codexPendingToFrontend(native);
  const fe2 = codexPendingToFrontend(native);
  assert.equal(fe1.toolUseId, fe2.toolUseId);
  assert.ok(fe1.toolUseId.startsWith('codex:exec_command:'));
});

test('2d. toolUseId DIFFERS between exec and apply_patch modals', () => {
  const execNative = CodexAdapter.detectPendingFromCapture(execCapture);
  const editNative = CodexAdapter.detectPendingFromCapture(editCapture);
  const execFe = codexPendingToFrontend(execNative);
  const editFe = codexPendingToFrontend(editNative);
  assert.notEqual(execFe.toolUseId, editFe.toolUseId);
});

test('2e. returns null when native is not pending', () => {
  const native = CodexAdapter.detectPendingFromCapture(headerOnlyCapture);
  assert.equal(codexPendingToFrontend(native), null);
});

test('2f. returns null for null input', () => {
  assert.equal(codexPendingToFrontend(null), null);
});

test('2g. kindLabel maps exec_command to "Run command" in question.header', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const fe = codexPendingToFrontend(native);
  assert.equal(fe.questions[0].header, 'Run command');
});

test('2h. kindLabel maps apply_patch to "Apply edits" in question.header', () => {
  const native = CodexAdapter.detectPendingFromCapture(editCapture);
  const fe = codexPendingToFrontend(native);
  assert.equal(fe.questions[0].header, 'Apply edits');
});

// ---------------------------------------------------------------------------
// 3. Answer routing: frontendSelectionToNative + buildAnswerProgram
// ---------------------------------------------------------------------------

test('3a. selecting "Yes, proceed" → keys [1, Enter]', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const validated = frontendSelectionToNative(native, [['Yes, proceed']]);
  const keys = CodexAdapter.buildAnswerProgram(native, validated);
  assert.deepEqual(keys, ['1', 'Enter']);
});

test('3b. selecting "No, and tell Codex what to do differently" → keys [3, Enter]', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  // option[2].label is "No, and tell Codex what to do differently" (shortcut: esc)
  const thirdLabel = native.options[2].label;
  const validated = frontendSelectionToNative(native, [[thirdLabel]]);
  const keys = CodexAdapter.buildAnswerProgram(native, validated);
  assert.deepEqual(keys, ['3', 'Enter']);
});

test('3c. selecting a label NOT in options throws from frontendSelectionToNative', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  assert.throws(
    () => frontendSelectionToNative(native, [['Non-existent option label']]),
    /selection not in pending options/i,
  );
});

test('3d. apply_patch: "Yes, proceed" → keys [1, Enter]', () => {
  const native = CodexAdapter.detectPendingFromCapture(editCapture);
  const validated = frontendSelectionToNative(native, [['Yes, proceed']]);
  const keys = CodexAdapter.buildAnswerProgram(native, validated);
  assert.deepEqual(keys, ['1', 'Enter']);
});

test('3e. empty selections pass through frontendSelectionToNative (falls back to highlighted)', () => {
  const native = CodexAdapter.detectPendingFromCapture(execCapture);
  const validated = frontendSelectionToNative(native, []);
  const keys = CodexAdapter.buildAnswerProgram(native, validated);
  assert.deepEqual(keys, ['1', 'Enter']); // highlighted = option 1
});

// ---------------------------------------------------------------------------
// 4. Claude regression: buildAnswerProgram (lib/answer.js) unaffected
// ---------------------------------------------------------------------------

test('4a. Claude buildAnswerProgram: single-select question → numbered key + submit', () => {
  const pending = {
    questions: [
      {
        multiSelect: false,
        options: [{ label: 'Yes' }, { label: 'No' }],
      },
    ],
  };
  const keys = claudeBuildAnswerProgram(pending, [['Yes']]);
  // single-select: "1" selects+auto-advances; "1" submits
  assert.deepEqual(keys, ['1', '1']);
});

test('4b. Claude buildAnswerProgram: multi-question program ends with Submit "1"', () => {
  const pending = {
    questions: [
      { multiSelect: false, options: [{ label: 'alpha' }, { label: 'beta' }] },
      { multiSelect: true, options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] },
    ],
  };
  const keys = claudeBuildAnswerProgram(pending, [['beta'], ['a', 'c']]);
  assert.deepEqual(keys, ['2', '1', '3', 'Right', '1']);
});

test('4c. Claude buildAnswerProgram: invalid label throws (regression guard)', () => {
  const pending = {
    questions: [{ multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
  };
  assert.throws(() => claudeBuildAnswerProgram(pending, [['Maybe']]), /no valid option/i);
});
