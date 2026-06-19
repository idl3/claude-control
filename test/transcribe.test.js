import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript } from '../lib/transcribe.js';

test('cleanTranscript collapses lines into one trimmed string', () => {
  assert.equal(cleanTranscript('  Hello   world  \n'), 'Hello world');
});

test('cleanTranscript joins multiple segment lines with a space', () => {
  assert.equal(cleanTranscript('First line.\nSecond line.'), 'First line. Second line.');
});

test('cleanTranscript drops bracketed-only markers', () => {
  assert.equal(cleanTranscript('[BLANK_AUDIO]'), '');
  assert.equal(cleanTranscript('(silence)'), '');
  assert.equal(cleanTranscript('Real words.\n[BLANK_AUDIO]'), 'Real words.');
});

test('cleanTranscript keeps text that merely contains brackets', () => {
  assert.equal(cleanTranscript('use array[0] here'), 'use array[0] here');
});

test('cleanTranscript handles empty input', () => {
  assert.equal(cleanTranscript(''), '');
  assert.equal(cleanTranscript('\n\n  \n'), '');
});
