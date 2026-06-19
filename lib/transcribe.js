/**
 * lib/transcribe.js — local speech-to-text via ffmpeg + whisper.cpp.
 *
 * No API key, no cloud: transcodes the uploaded audio to 16kHz mono WAV with
 * ffmpeg, then runs the whisper-cli binary (brew install whisper-cpp) against a
 * local ggml model. Works for any browser that can record audio (incl. iOS
 * Safari), which the Web Speech API does not.
 *
 * Exports:
 *  - resolveFfmpeg() / resolveWhisperBin() / resolveWhisperModel() → string | null
 *  - cleanTranscript(raw) → string   (pure; strips timestamps/blank markers)
 *  - transcribe(inputPath, { lang }) → Promise<string>
 *
 * Binary/model resolution is overridable via env (FFMPEG_BIN, WHISPER_BIN,
 * WHISPER_MODEL) and defaults to Homebrew + ~/.claude-control/models.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const MODELS_DIR = path.join(os.homedir(), '.claude-control', 'models');

/** Resolve a binary: env override → `which` → known fallbacks. */
function resolveBin(name, envVar, fallbacks) {
  const e = process.env[envVar];
  if (e && e.trim() && fs.existsSync(e.trim())) return e.trim();
  try {
    const w = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    if (w && fs.existsSync(w)) return w;
  } catch {
    /* not on PATH */
  }
  for (const f of fallbacks) if (fs.existsSync(f)) return f;
  return null;
}

/** @returns {string | null} */
export function resolveFfmpeg() {
  return resolveBin('ffmpeg', 'FFMPEG_BIN', [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ]);
}

/** @returns {string | null} */
export function resolveWhisperBin() {
  return resolveBin('whisper-cli', 'WHISPER_BIN', [
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ]);
}

/**
 * Resolve the ggml model: WHISPER_MODEL env → preferred names in the models
 * dir → any `ggml-*.bin` there.
 * @returns {string | null}
 */
export function resolveWhisperModel() {
  const e = process.env.WHISPER_MODEL;
  if (e && e.trim() && fs.existsSync(e.trim())) return e.trim();
  // Prefer multilingual models (no `.en`) when present: a `.en` model can ONLY
  // do English, so if the user dropped in a multilingual ggml they want the mix
  // (English + Chinese + Singlish/…). English-only models are the fallback.
  const prefs = [
    'ggml-medium.bin',
    'ggml-small.bin',
    'ggml-base.bin',
    'ggml-base.en.bin',
    'ggml-small.en.bin',
    'ggml-tiny.en.bin',
  ];
  for (const m of prefs) {
    const p = path.join(MODELS_DIR, m);
    if (fs.existsSync(p)) return p;
  }
  try {
    const found = fs.readdirSync(MODELS_DIR).find((n) => /^ggml-.*\.bin$/.test(n));
    if (found) return path.join(MODELS_DIR, found);
  } catch {
    /* dir missing */
  }
  return null;
}

/**
 * Clean whisper-cli stdout into a single line: drop blank lines, drop
 * bracketed-only markers ([BLANK_AUDIO], (silence)), collapse whitespace.
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanTranscript(raw) {
  return String(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^[[(][^\])]*[\])]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Spawn a binary, capture stdout/stderr, resolve on exit 0. */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      err += d;
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve({ stdout: out, stderr: err })
        : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(0, 500)}`)),
    );
  });
}

/**
 * Transcribe an audio file (any ffmpeg-readable format) to text.
 *
 * @param {string} inputPath - path to the recorded audio file.
 * @param {{ lang?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function transcribe(inputPath, { lang } = {}) {
  const ffmpeg = resolveFfmpeg();
  const whisper = resolveWhisperBin();
  const model = resolveWhisperModel();
  if (!ffmpeg) throw new Error('ffmpeg not found (brew install ffmpeg)');
  if (!whisper) throw new Error('whisper-cli not found (brew install whisper-cpp)');
  if (!model) throw new Error(`no whisper model found in ${MODELS_DIR}`);

  // Language: an English-only (`.en`) model can ONLY do English. A multilingual
  // model (no `.en` — incl. a converted Singlish fine-tune) autodetects the
  // spoken language (Chinese, Singlish, …) unless one is forced. Override with
  // the `lang` arg or WHISPER_LANG (e.g. 'zh', 'en', 'auto').
  const englishOnly = /\.en\.bin$/i.test(path.basename(model));
  const effLang =
    lang || process.env.WHISPER_LANG || (englishOnly ? 'en' : 'auto');

  const wav = path.join(
    os.tmpdir(),
    `cc-stt-${Date.now()}-${process.pid}.wav`,
  );
  try {
    await run(ffmpeg, [
      '-nostdin', '-y',
      '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      '-f', 'wav', wav,
    ]);
    const { stdout } = await run(whisper, [
      '-m', model, '-f', wav, '-np', '-nt', '-l', effLang,
    ]);
    return cleanTranscript(stdout);
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
}
