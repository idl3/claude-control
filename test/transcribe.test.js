/**
 * PLE-45: added coverage for buildWhisperFlags + resolveModelFromFiles
 * (the pure language-decision and model-selection logic).
 * No audio decoding, no ffmpeg, no whisper spawn — all inputs are synthetic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, buildWhisperFlags, resolveModelFromFiles } from '../lib/transcribe.js';

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

// ── buildWhisperFlags: --translate ──────────────────────────────────────────

test('--translate: multilingual model includes translate=true', () => {
  const { translate } = buildWhisperFlags('/models/ggml-medium.bin');
  assert.equal(translate, true);
});

test('--translate: english-only .en model has translate=false', () => {
  const { translate } = buildWhisperFlags('/models/ggml-base.en.bin');
  assert.equal(translate, false);
});

test('--translate has teeth: flipping model from multilingual to .en flips the flag', () => {
  // This test would FAIL if someone accidentally hard-coded translate=true.
  const { translate: ml } = buildWhisperFlags('/models/ggml-small.bin');
  const { translate: en } = buildWhisperFlags('/models/ggml-small.en.bin');
  assert.equal(ml, true,  'multilingual must have translate=true');
  assert.equal(en, false, '.en model must have translate=false');
  assert.notEqual(ml, en, 'values must differ — test has teeth');
});

test('--translate: .en suffix matching is case-insensitive', () => {
  // Unusual but possible on case-insensitive filesystems or user-renamed files.
  const { translate } = buildWhisperFlags('/models/ggml-base.EN.BIN');
  assert.equal(translate, false);
});

// ── buildWhisperFlags: effLang precedence ────────────────────────────────────

test('effLang: explicit lang arg wins over everything', () => {
  const { effLang } = buildWhisperFlags(
    '/models/ggml-medium.bin',
    { lang: 'zh' },
    { WHISPER_LANG: 'fr' },
  );
  assert.equal(effLang, 'zh');
});

test('effLang: WHISPER_LANG env wins when no lang arg', () => {
  const { effLang } = buildWhisperFlags(
    '/models/ggml-medium.bin',
    {},
    { WHISPER_LANG: 'ja' },
  );
  assert.equal(effLang, 'ja');
});

test('effLang: multilingual model default is "auto" when no lang or env', () => {
  const { effLang } = buildWhisperFlags('/models/ggml-medium.bin', {}, {});
  assert.equal(effLang, 'auto');
});

test('effLang: english-only model default is "en" when no lang or env', () => {
  const { effLang } = buildWhisperFlags('/models/ggml-base.en.bin', {}, {});
  assert.equal(effLang, 'en');
});

test('effLang: explicit lang arg overrides even for .en model', () => {
  // Unusual but user explicitly requested a language; respect it.
  const { effLang } = buildWhisperFlags(
    '/models/ggml-tiny.en.bin',
    { lang: 'de' },
    {},
  );
  assert.equal(effLang, 'de');
});

// ── resolveModelFromFiles: model preference order ────────────────────────────

test('resolveModelFromFiles: prefers multilingual medium over .en models', () => {
  const files = ['ggml-medium.bin', 'ggml-base.en.bin', 'ggml-small.en.bin'];
  assert.equal(resolveModelFromFiles(files), 'ggml-medium.bin');
});

test('resolveModelFromFiles: prefers small multilingual over .en when medium absent', () => {
  const files = ['ggml-small.bin', 'ggml-base.en.bin'];
  assert.equal(resolveModelFromFiles(files), 'ggml-small.bin');
});

test('resolveModelFromFiles: prefers base multilingual over .en when medium+small absent', () => {
  const files = ['ggml-base.bin', 'ggml-tiny.en.bin'];
  assert.equal(resolveModelFromFiles(files), 'ggml-base.bin');
});

test('resolveModelFromFiles: falls back to .en model when no multilingual present', () => {
  const files = ['ggml-base.en.bin', 'ggml-small.en.bin', 'ggml-tiny.en.bin'];
  assert.equal(resolveModelFromFiles(files), 'ggml-base.en.bin');
});

test('resolveModelFromFiles: falls back to any ggml-*.bin when none of the named prefs exist', () => {
  const files = ['ggml-custom-model.bin', 'readme.txt'];
  assert.equal(resolveModelFromFiles(files), 'ggml-custom-model.bin');
});

test('resolveModelFromFiles: returns null when no ggml model files present', () => {
  assert.equal(resolveModelFromFiles([]), null);
  assert.equal(resolveModelFromFiles(['readme.txt', 'config.json']), null);
});

test('resolveModelFromFiles: multilingual beats .en even when .en appears first in array', () => {
  // Order in the files array must not matter — preference list drives selection.
  const files = ['ggml-base.en.bin', 'ggml-small.bin'];
  assert.equal(resolveModelFromFiles(files), 'ggml-small.bin');
});
