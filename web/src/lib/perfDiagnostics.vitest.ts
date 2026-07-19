import { describe, expect, it } from 'vitest';
import {
  buildPerfSample,
  classifyPerfSample,
  createEmptyCounters,
  createEmptyFrameWindow,
  readPerfFlag,
  recordFrameGap,
} from './perfDiagnostics';

describe('perfDiagnostics flag parsing', () => {
  it('enables diagnostics from common truthy URL flags', () => {
    expect(readPerfFlag('?perf=1')).toBe(true);
    expect(readPerfFlag('diagnostics=true')).toBe(true);
    expect(readPerfFlag('?cc_perf=on')).toBe(true);
  });

  it('disables diagnostics from common falsey URL flags', () => {
    expect(readPerfFlag('?perf=0')).toBe(false);
    expect(readPerfFlag('?diagnostics=false')).toBe(false);
    expect(readPerfFlag('?cc_perf=off')).toBe(false);
  });

  it('returns null when no diagnostics flag is present', () => {
    expect(readPerfFlag('?x=1')).toBeNull();
    expect(readPerfFlag('')).toBeNull();
  });
});

describe('perfDiagnostics sample math', () => {
  it('tracks frame cadence and dropped frames without retaining per-frame data', () => {
    const frame = createEmptyFrameWindow();
    recordFrameGap(frame, 16.7);
    recordFrameGap(frame, 51);
    recordFrameGap(frame, 118);

    expect(frame.frames).toBe(3);
    expect(frame.worstFrameMs).toBe(118);
    expect(frame.jankFrames).toBe(2);
    expect(frame.droppedFrames).toBeGreaterThanOrEqual(7);
  });

  it('normalizes counters into one-second-ish rates', () => {
    const frame = createEmptyFrameWindow();
    for (let i = 0; i < 30; i++) recordFrameGap(frame, 16.7);
    const counters = createEmptyCounters();
    counters.wsMessages = 8;
    counters.wsBytes = 4096;
    counters.appRenders = 4;
    counters.longTasks = 1;
    counters.longTaskMs = 62;

    const sample = buildPerfSample({
      now: 123,
      elapsedMs: 2000,
      frame,
      counters,
      loopLagMs: 12,
      memory: null,
      visibility: 'visible',
    });

    expect(sample.fps).toBe(15);
    expect(sample.wsMessagesPerSec).toBe(4);
    expect(sample.wsKbPerSec).toBe(2);
    expect(sample.appRendersPerSec).toBe(2);
    expect(sample.longTaskMs).toBe(62);
  });
});

describe('perfDiagnostics status classification', () => {
  it('classifies missing samples as warming', () => {
    expect(classifyPerfSample(null)).toBe('warming');
  });

  it('does not classify a browser-throttled hidden page as hot', () => {
    const sample = buildPerfSample({
      now: 1,
      elapsedMs: 1000,
      frame: createEmptyFrameWindow(),
      counters: createEmptyCounters(),
      loopLagMs: 0,
      memory: null,
      visibility: 'hidden',
    });

    expect(classifyPerfSample(sample)).toBe('warming');
  });

  it('classifies sustained stalls as hot', () => {
    const counters = createEmptyCounters();
    counters.longTaskMs = 220;
    const sample = buildPerfSample({
      now: 1,
      elapsedMs: 1000,
      frame: createEmptyFrameWindow(),
      counters,
      loopLagMs: 0,
      memory: null,
      visibility: 'visible',
    });

    expect(classifyPerfSample(sample)).toBe('hot');
  });
});
