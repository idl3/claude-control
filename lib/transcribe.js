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
 * Pure model-preference resolver: given a list of filenames present on disk,
 * return the preferred one (multilingual before .en). Exposed for testing.
 *
 * @param {string[]} files - basenames available (e.g. from fs.readdirSync)
 * @returns {string | null} preferred basename, or null
 */
export function resolveModelFromFiles(files) {
  const prefs = [
    'ggml-medium.bin',
    'ggml-small.bin',
    'ggml-base.bin',
    'ggml-base.en.bin',
    'ggml-small.en.bin',
    'ggml-tiny.en.bin',
  ];
  for (const m of prefs) {
    if (files.includes(m)) return m;
  }
  return files.find((n) => /^ggml-.*\.bin$/.test(n)) ?? null;
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
  let files = [];
  try {
    files = fs.readdirSync(MODELS_DIR);
  } catch {
    /* dir missing */
  }
  const found = resolveModelFromFiles(files);
  return found ? path.join(MODELS_DIR, found) : null;
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
 * Derive the whisper-cli language flags from the resolved model path and call
 * options. Pure function — no I/O. Exposed for testing.
 *
 * @param {string} modelPath  - resolved model file path (used for its basename)
 * @param {{ lang?: string }} [opts]
 * @param {NodeJS.ProcessEnv} [env]  - defaults to process.env
 * @returns {{ effLang: string, translate: boolean }}
 */
export function buildWhisperFlags(modelPath, { lang } = {}, env = process.env) {
  const englishOnly = /\.en\.bin$/i.test(path.basename(modelPath));
  const effLang = lang || env.WHISPER_LANG || (englishOnly ? 'en' : 'auto');
  const translate = !englishOnly; // → always-English output
  return { effLang, translate };
}

/**
 * Transcribe an audio file (any ffmpeg-readable format) to text — always in
 * English. A multilingual model uses Whisper's TRANSLATE task, so Chinese,
 * Singlish, and mixed speech all come back as English. English-only (`.en`)
 * models are already English; nothing to translate.
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

  // `.en` models do English only; multilingual models auto-detect the source then
  // translate it to English. Source language is overridable (lang / WHISPER_LANG)
  // for the rare case you want to pin detection; output stays English.
  const { effLang, translate } = buildWhisperFlags(model, { lang });

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
      ...(translate ? ['--translate'] : []),
    ]);
    return cleanTranscript(stdout);
  } finally {
    fs.promises.unlink(wav).catch(() => {});
  }
}
