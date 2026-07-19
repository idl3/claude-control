/**
 * lib/client-perf.js — local sink for browser/device performance samples.
 *
 * The mobile diagnostics overlay POSTs small sample batches to /api/client-perf.
 * Samples are stored as bounded JSONL under ~/.claude-control/logs so heat/jank
 * reports can be investigated locally without a cloud telemetry service.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const MAX_STRING = 1200;
const MAX_SAMPLES_PER_BATCH = 30;
const MAX_RECENT_BATCHES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // rotate past 10 MB (keep one .1 backup)

export function clientPerfPath() {
  const base = process.env.CLAUDE_CONTROL_DIR || path.join(os.homedir(), '.claude-control');
  return path.join(base, 'logs', 'client-perf.jsonl');
}

export function recordClientPerf(body = {}, meta = {}) {
  const samples = Array.isArray(body.samples)
    ? body.samples.slice(-MAX_SAMPLES_PER_BATCH).map(normalizeSample).filter(Boolean)
    : [];
  if (samples.length === 0) {
    const err = new Error('samples required');
    err.code = 'EINVAL';
    throw err;
  }

  const rec = {
    ts: meta.ts || new Date().toISOString(),
    clientId: clip(body.clientId || ''),
    pageId: clip(body.pageId || ''),
    url: clip(body.url || ''),
    userAgent: clip(body.userAgent || meta.userAgent || ''),
    device: normalizeDevice(body.device || {}),
    samples,
  };

  const p = clientPerfPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  rotateIfNeeded(p);
  fs.appendFileSync(p, `${JSON.stringify(rec)}\n`);
  return rec;
}

export function readRecentClientPerfRecords(limit = MAX_RECENT_BATCHES) {
  const p = clientPerfPath();
  let text = '';
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }
  const lines = text.trim().split('\n').filter(Boolean).slice(-clampInt(limit, 1, MAX_RECENT_BATCHES));
  const records = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && Array.isArray(rec.samples)) records.push(rec);
    } catch {
      // Ignore torn/corrupt lines; JSONL append should not make diagnostics fail.
    }
  }
  return records;
}

export function summarizeClientPerf(limit = MAX_RECENT_BATCHES) {
  const records = readRecentClientPerfRecords(limit);
  const samples = records.flatMap((rec) =>
    rec.samples.map((sample) => ({
      ...sample,
      batchTs: rec.ts,
      clientId: rec.clientId || '',
      pageId: rec.pageId || '',
      userAgent: rec.userAgent || '',
    })),
  );
  const visible = samples.filter((s) => s.visibility === 'visible');
  const stressed = visible.filter((s) => classifySample(s) !== 'ok');
  const hot = visible.filter((s) => classifySample(s) === 'hot');
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  return {
    ok: true,
    path: clientPerfPath(),
    records: records.length,
    samples: samples.length,
    visibleSamples: visible.length,
    startedAt: samples.length > 0 ? new Date(samples[0].t).toISOString() : null,
    endedAt: latest ? new Date(latest.t).toISOString() : null,
    latest,
    summary: {
      avgFps: avg(visible.map((s) => s.fps)),
      minFps: min(visible.map((s) => s.fps)),
      worstFrameMs: max(visible.map((s) => s.worstFrameMs)),
      maxLoopLagMs: max(visible.map((s) => s.loopLagMs)),
      longTaskMs: sum(visible.map((s) => s.longTaskMs)),
      longAnimationFrameMs: sum(visible.map((s) => s.longAnimationFrameMs)),
      wsKbPerSecAvg: avg(visible.map((s) => s.wsKbPerSec)),
      wsKbPerSecMax: max(visible.map((s) => s.wsKbPerSec)),
      appRendersPerSecMax: max(visible.map((s) => s.appRendersPerSec)),
      stressedSamples: stressed.length,
      hotSamples: hot.length,
    },
  };
}

function normalizeDevice(device) {
  return {
    platform: clip(device.platform || ''),
    hardwareConcurrency: finiteOrNull(device.hardwareConcurrency),
    deviceMemoryGb: finiteOrNull(device.deviceMemoryGb),
    dpr: finiteOrNull(device.dpr),
    viewport: normalizeViewport(device.viewport),
    visualViewport: device.visualViewport ? normalizeViewport(device.visualViewport, true) : null,
    touchPoints: finiteOrNull(device.touchPoints),
    prefersReducedMotion: !!device.prefersReducedMotion,
    webgl: {
      available: !!device.webgl?.available,
      version: clip(device.webgl?.version || ''),
      vendor: clip(device.webgl?.vendor || ''),
      renderer: clip(device.webgl?.renderer || ''),
    },
  };
}

function normalizeSample(s) {
  if (!s || typeof s !== 'object') return null;
  const t = finiteOrNull(s.t);
  if (!t) return null;
  return {
    t,
    elapsedMs: finiteOrZero(s.elapsedMs),
    fps: finiteOrZero(s.fps),
    avgFrameMs: finiteOrNull(s.avgFrameMs),
    worstFrameMs: finiteOrZero(s.worstFrameMs),
    droppedFrames: finiteOrZero(s.droppedFrames),
    jankFrames: finiteOrZero(s.jankFrames),
    loopLagMs: finiteOrZero(s.loopLagMs),
    longTasks: finiteOrZero(s.longTasks),
    longTaskMs: finiteOrZero(s.longTaskMs),
    longAnimationFrames: finiteOrZero(s.longAnimationFrames),
    longAnimationFrameMs: finiteOrZero(s.longAnimationFrameMs),
    layoutShiftScore: finiteOrZero(s.layoutShiftScore),
    wsMessagesPerSec: finiteOrZero(s.wsMessagesPerSec),
    wsKbPerSec: finiteOrZero(s.wsKbPerSec),
    appRendersPerSec: finiteOrZero(s.appRendersPerSec),
    maxRenderMessages: finiteOrZero(s.maxRenderMessages),
    memory: s.memory ? {
      usedMb: finiteOrZero(s.memory.usedMb),
      totalMb: finiteOrNull(s.memory.totalMb),
      limitMb: finiteOrNull(s.memory.limitMb),
    } : null,
    visibility: s.visibility === 'hidden' ? 'hidden' : 'visible',
  };
}

function normalizeViewport(v, includeScale = false) {
  return {
    width: finiteOrZero(v?.width),
    height: finiteOrZero(v?.height),
    ...(includeScale ? { scale: finiteOrNull(v?.scale) } : {}),
  };
}

function classifySample(sample) {
  if (sample.visibility !== 'visible') return 'ok';
  if (
    sample.fps < 40 ||
    sample.worstFrameMs >= 120 ||
    sample.loopLagMs >= 120 ||
    sample.longTaskMs >= 180 ||
    sample.longAnimationFrameMs >= 180
  ) return 'hot';
  if (
    sample.fps < 52 ||
    sample.worstFrameMs >= 60 ||
    sample.loopLagMs >= 60 ||
    sample.longTasks > 0 ||
    sample.longAnimationFrames > 0 ||
    sample.jankFrames > 1
  ) return 'watch';
  return 'ok';
}

function rotateIfNeeded(p) {
  try {
    if (fs.statSync(p).size <= MAX_FILE_BYTES) return;
    try { fs.rmSync(`${p}.1`, { force: true }); } catch { /* ignore */ }
    fs.renameSync(p, `${p}.1`);
  } catch {
    /* no file yet — nothing to rotate */
  }
}

function clip(v) {
  return typeof v === 'string' ? v.slice(0, MAX_STRING) : String(v ?? '').slice(0, MAX_STRING);
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function finiteOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(v, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function sum(xs) {
  return Math.round(xs.filter(Number.isFinite).reduce((a, b) => a + b, 0) * 10) / 10;
}

function avg(xs) {
  const finite = xs.filter(Number.isFinite);
  if (finite.length === 0) return null;
  return Math.round((finite.reduce((a, b) => a + b, 0) / finite.length) * 10) / 10;
}

function min(xs) {
  const finite = xs.filter(Number.isFinite);
  return finite.length ? Math.min(...finite) : null;
}

function max(xs) {
  const finite = xs.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : null;
}
