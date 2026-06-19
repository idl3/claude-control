import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, clampLang } from '../lib/transcribe.js';

test('clampLang keeps en/zh as-is (null = no second pass)', () => {
  assert.equal(clampLang('en'), null);
  assert.equal(clampLang('zh'), null);
  assert.equal(clampLang(''), null);
  assert.equal(clampLang(null), null);
});

test('clampLang folds CJK-script misdetections to zh', () => {
  assert.equal(clampLang('ja'), 'zh'); // Japanese shares Han chars
  assert.equal(clampLang('yue'), 'zh'); // Cantonese
});

test('clampLang folds other misdetections (latin/Singlish space) to en', () => {
  assert.equal(clampLang('ko'), 'en');
  assert.equal(clampLang('vi'), 'en');
  assert.equal(clampLang('ms'), 'en'); // Malay — Singlish borrows from it
  assert.equal(clampLang('id'), 'en');
});

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
