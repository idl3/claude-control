// @vitest-environment jsdom
/**
 * Tests for useVoiceRecorder abort + unmount lifecycle (PLE-50).
 *
 * Strategy: render the hook via @testing-library/react renderHook with
 * jsdom, stub MediaRecorder + navigator.mediaDevices, and mock ../lib/api so
 * transcribeAudio is fully controllable.
 *
 * Each test is written to FAIL against the original hook (no AbortController,
 * no mountedRef guard) and PASS with the fixed hook.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ─── mock ../lib/api ─────────────────────────────────────────────────────────
// Must be declared before the hook import so vi.mock hoisting works.
const mockTranscribeAudio = vi.fn<(blob: Blob, ext: string, signal?: AbortSignal) => Promise<string>>();
vi.mock('../lib/api', () => ({
  transcribeAudio: (blob: Blob, ext: string, signal?: AbortSignal) => mockTranscribeAudio(blob, ext, signal),
}));

import { useVoiceRecorder } from './useVoiceRecorder';

// ─── minimal MediaRecorder stub ───────────────────────────────────────────────
// Captures onstop so tests can fire it manually.
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }

  start() {}
  stop() {
    // Deliver a dummy chunk then fire onstop (mimics real MediaRecorder).
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['x'], { type: 'audio/webm' }) });
    }
    this.onstop?.();
  }
  pause() {}
  resume() {}

  static isTypeSupported() {
    return false;
  }
}

// ─── minimal MediaStream stub ─────────────────────────────────────────────────
class FakeMediaStream {
  getTracks() {
    return [{ stop: vi.fn() }];
  }
}

// ─── setup / teardown ─────────────────────────────────────────────────────────
beforeEach(() => {
  FakeMediaRecorder.instances = [];
  mockTranscribeAudio.mockReset();

  // Stub browser APIs on globalThis (jsdom does not provide these).
  Object.defineProperty(globalThis, 'MediaRecorder', {
    value: FakeMediaRecorder,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeMediaStream()),
    },
    writable: true,
    configurable: true,
  });
  // AudioContext is not needed; pickMime falls back gracefully when absent.
  Object.defineProperty(globalThis, 'AudioContext', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  // requestAnimationFrame / cancelAnimationFrame stubs (used by waveform draw).
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (_cb: FrameRequestCallback) => 0,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (_id: number) => {},
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── helper: render hook and wait for mic acquisition ─────────────────────────
async function mountHook(overrides: {
  onCommit?: (t: string) => void;
  onClose?: () => void;
} = {}) {
  const onCommit = overrides.onCommit ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const result = renderHook(() => useVoiceRecorder({ onCommit, onClose }));
  // Let the async getUserMedia + state updates settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { ...result, onCommit, onClose };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: cancel() aborts the signal passed to transcribeAudio
// ─────────────────────────────────────────────────────────────────────────────
describe('cancel() aborts in-flight transcription', () => {
  it('signal.aborted is true after cancel(); no commit and no status:error applied', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveTranscribe!: (text: string) => void;

    // never-resolving until we manually drive it
    mockTranscribeAudio.mockImplementation((_blob, _ext, signal) => {
      capturedSignal = signal;
      return new Promise<string>((resolve) => {
        resolveTranscribe = resolve;
      });
    });

    const onCommit = vi.fn();
    const { result } = await mountHook({ onCommit });

    // Trigger stop → queues up transcription.
    await act(async () => {
      result.current.stop();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockTranscribeAudio).toHaveBeenCalledOnce();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Verify signal is wired through as the third argument.
    expect(mockTranscribeAudio.mock.calls[0][2]).toBe(capturedSignal);

    // Call cancel while transcription is still pending.
    act(() => {
      result.current.cancel();
    });

    expect(capturedSignal!.aborted).toBe(true);

    // Now resolve the pending transcription — commit must NOT fire.
    await act(async () => {
      resolveTranscribe('hello world');
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.status).not.toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: AbortError rejection → hook does NOT enter status:'error'
// ─────────────────────────────────────────────────────────────────────────────
describe('AbortError rejection is swallowed', () => {
  it('hook stays out of error state when transcribeAudio rejects with AbortError', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    mockTranscribeAudio.mockRejectedValue(abortErr);

    const onCommit = vi.fn();
    const { result } = await mountHook({ onCommit });

    await act(async () => {
      result.current.stop();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.status).not.toBe('error');
    expect(result.current.errorMsg).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Normal Error rejection → hook DOES enter status:'error'
// ─────────────────────────────────────────────────────────────────────────────
describe('genuine transcription error surfaces', () => {
  it('hook enters status:error when transcribeAudio rejects with a non-abort Error', async () => {
    const serverErr = new Error('Internal server error');
    mockTranscribeAudio.mockRejectedValue(serverErr);

    const onCommit = vi.fn();
    const { result } = await mountHook({ onCommit });

    await act(async () => {
      result.current.stop();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorMsg).toBe('Internal server error');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
