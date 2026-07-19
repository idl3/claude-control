import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clientPerfPath,
  recordClientPerf,
  readRecentClientPerfRecords,
  summarizeClientPerf,
} from '../lib/client-perf.js';

let dir;
let prev;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-perf-'));
  prev = process.env.CLAUDE_CONTROL_DIR;
  process.env.CLAUDE_CONTROL_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.CLAUDE_CONTROL_DIR;
  else process.env.CLAUDE_CONTROL_DIR = prev;
});

function sample(overrides = {}) {
  return {
    t: Date.UTC(2026, 6, 19, 1, 2, 3),
    elapsedMs: 1000,
    fps: 60,
    avgFrameMs: 16.7,
    worstFrameMs: 16.7,
    droppedFrames: 0,
    jankFrames: 0,
    loopLagMs: 1,
    longTasks: 0,
    longTaskMs: 0,
    longAnimationFrames: 0,
    longAnimationFrameMs: 0,
    layoutShiftScore: 0,
    wsMessagesPerSec: 1,
    wsKbPerSec: 0.5,
    appRendersPerSec: 2,
    maxRenderMessages: 120,
    memory: { usedMb: 80, totalMb: 128, limitMb: 2048 },
    surfaces: {
      iframes: 0,
      visibleIframes: 0,
      videos: 0,
      playingVideos: 0,
      audios: 0,
      playingAudio: 0,
      canvases: 0,
      visibleCanvases: 0,
      runningAnimations: 0,
      embedHoists: 0,
      visibleEmbedHoists: 0,
      voiceActive: false,
    },
    visibility: 'visible',
    ...overrides,
  };
}

test('recordClientPerf appends a local JSONL batch with normalized samples', () => {
  const rec = recordClientPerf(
    {
      clientId: 'phone-1',
      pageId: 'page-1',
      url: 'https://host.ts.net/?perf=1',
      userAgent: 'MobileSafari',
      device: {
        platform: 'iPhone',
        dpr: 3,
        viewport: { width: 390, height: 844 },
        webgl: { available: true, version: 'webgl2', renderer: 'Apple GPU' },
      },
      samples: [sample({ fps: 42, worstFrameMs: 72 })],
    },
    { userAgent: 'Server-UA' },
  );

  assert.equal(rec.clientId, 'phone-1');
  assert.equal(rec.samples.length, 1);
  assert.equal(rec.samples[0].fps, 42);
  assert.equal(rec.samples[0].surfaces.visibleIframes, 0);
  assert.equal(rec.device.webgl.renderer, 'Apple GPU');

  const lines = fs.readFileSync(clientPerfPath(), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).pageId, 'page-1');
});

test('recordClientPerf rejects empty batches instead of writing noise', () => {
  assert.throws(() => recordClientPerf({ samples: [] }), /samples required/);
  assert.equal(fs.existsSync(clientPerfPath()), false);
});

test('recordClientPerf clips each batch to the newest 30 samples', () => {
  const samples = Array.from({ length: 35 }, (_, i) => sample({ fps: i + 1 }));
  const rec = recordClientPerf({ samples });
  assert.equal(rec.samples.length, 30);
  assert.equal(rec.samples[0].fps, 6);
  assert.equal(rec.samples[29].fps, 35);
});

test('summarizeClientPerf computes local recent-tail stress metrics', () => {
  recordClientPerf({
    clientId: 'phone-1',
    samples: [
      sample({ fps: 60, worstFrameMs: 17, wsKbPerSec: 0.5 }),
      sample({
        fps: 35,
        worstFrameMs: 140,
        loopLagMs: 130,
        longTaskMs: 220,
        wsKbPerSec: 3,
        surfaces: {
          ...sample().surfaces,
          visibleIframes: 2,
          visibleCanvases: 1,
          runningAnimations: 18,
          playingVideos: 1,
          voiceActive: true,
        },
      }),
      sample({ fps: 5, visibility: 'hidden', worstFrameMs: 1000 }),
    ],
  });

  const summary = summarizeClientPerf();
  assert.equal(summary.records, 1);
  assert.equal(summary.samples, 3);
  assert.equal(summary.visibleSamples, 2);
  assert.equal(summary.summary.avgFps, 47.5);
  assert.equal(summary.summary.minFps, 35);
  assert.equal(summary.summary.worstFrameMs, 140);
  assert.equal(summary.summary.hotSamples, 1);
  assert.equal(summary.summary.stressedSamples, 1);
  assert.equal(summary.summary.wsKbPerSecMax, 3);
  assert.equal(summary.summary.maxVisibleIframes, 2);
  assert.equal(summary.summary.maxRunningAnimations, 18);
  assert.equal(summary.summary.maxPlayingVideos, 1);
  assert.equal(summary.summary.voiceActiveSamples, 1);
});

test('readRecentClientPerfRecords ignores corrupt JSONL lines', () => {
  recordClientPerf({ samples: [sample({ fps: 59 })] });
  fs.appendFileSync(clientPerfPath(), '{not-json}\n');
  recordClientPerf({ samples: [sample({ fps: 58 })] });

  const records = readRecentClientPerfRecords();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.samples[0].fps), [59, 58]);
});
