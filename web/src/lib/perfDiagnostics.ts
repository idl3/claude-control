export const PERF_DIAGNOSTICS_STORAGE_KEY = 'cc:perf-diagnostics';

export type PerfEventKind = 'ws-message' | 'app-render';

export interface PerfEventDetail {
  kind: PerfEventKind;
  value?: number;
  t: number;
}

export interface PerfDeviceInfo {
  userAgent: string;
  platform: string;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  dpr: number;
  viewport: { width: number; height: number };
  visualViewport: { width: number; height: number; scale: number } | null;
  touchPoints: number;
  prefersReducedMotion: boolean;
  visibility: DocumentVisibilityState;
  supportedEntryTypes: string[];
  webgl: {
    available: boolean;
    version: 'webgl2' | 'webgl' | null;
    vendor: string | null;
    renderer: string | null;
  };
}

export interface PerfMemorySample {
  usedMb: number;
  totalMb: number | null;
  limitMb: number | null;
}

export interface PerfCounters {
  longTasks: number;
  longTaskMs: number;
  longAnimationFrames: number;
  longAnimationFrameMs: number;
  layoutShiftScore: number;
  wsMessages: number;
  wsBytes: number;
  appRenders: number;
  maxRenderMessages: number;
}

export interface FrameWindow {
  frames: number;
  totalGapMs: number;
  worstFrameMs: number;
  droppedFrames: number;
  jankFrames: number;
}

export interface PerfSample {
  t: number;
  elapsedMs: number;
  fps: number;
  avgFrameMs: number | null;
  worstFrameMs: number;
  droppedFrames: number;
  jankFrames: number;
  loopLagMs: number;
  longTasks: number;
  longTaskMs: number;
  longAnimationFrames: number;
  longAnimationFrameMs: number;
  layoutShiftScore: number;
  wsMessagesPerSec: number;
  wsKbPerSec: number;
  appRendersPerSec: number;
  maxRenderMessages: number;
  memory: PerfMemorySample | null;
  visibility: DocumentVisibilityState;
}

export interface PerfDiagnosticsReport {
  exportedAt: string;
  device: PerfDeviceInfo;
  latest: PerfSample | null;
  history: PerfSample[];
  note: string;
}

interface NavigatorWithDeviceMemory extends Navigator {
  deviceMemory?: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
    jsHeapSizeLimit?: number;
  };
}

let perfEventRecording = false;

export function setPerfEventRecording(enabled: boolean): void {
  perfEventRecording = enabled;
}

export function recordPerfEvent(kind: PerfEventKind, value?: number): void {
  if (!perfEventRecording || typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<PerfEventDetail>('cockpit:perf-event', {
      detail: { kind, value, t: performance.now() },
    }),
  );
}

export function loadPerfDiagnosticsEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const fromQuery = readPerfFlag(window.location.search);
  if (fromQuery != null) return fromQuery;
  try {
    return window.localStorage.getItem(PERF_DIAGNOSTICS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function savePerfDiagnosticsEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(PERF_DIAGNOSTICS_STORAGE_KEY, '1');
    else window.localStorage.removeItem(PERF_DIAGNOSTICS_STORAGE_KEY);
  } catch {
    /* localStorage unavailable/full — diagnostics still work for this page load */
  }
}

export function readPerfFlag(search: string): boolean | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get('perf') ?? params.get('diagnostics') ?? params.get('cc_perf');
  if (value == null) return null;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return true;
}

export function getPerfDeviceInfo(): PerfDeviceInfo {
  const nav = window.navigator as NavigatorWithDeviceMemory;
  const supportedEntryTypes =
    typeof PerformanceObserver !== 'undefined'
      ? [...(PerformanceObserver.supportedEntryTypes ?? [])].sort()
      : [];
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    dpr: window.devicePixelRatio || 1,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    visualViewport: window.visualViewport
      ? {
          width: Math.round(window.visualViewport.width),
          height: Math.round(window.visualViewport.height),
          scale: window.visualViewport.scale,
        }
      : null,
    touchPoints: nav.maxTouchPoints ?? 0,
    prefersReducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    visibility: document.visibilityState,
    supportedEntryTypes,
    webgl: detectWebgl(),
  };
}

export function sampleMemory(): PerfMemorySample | null {
  if (typeof performance === 'undefined') return null;
  const memory = (performance as PerformanceWithMemory).memory;
  const used = memory?.usedJSHeapSize;
  if (typeof used !== 'number') return null;
  const total = memory?.totalJSHeapSize;
  const limit = memory?.jsHeapSizeLimit;
  return {
    usedMb: bytesToMb(used),
    totalMb: typeof total === 'number' ? bytesToMb(total) : null,
    limitMb: typeof limit === 'number' ? bytesToMb(limit) : null,
  };
}

export function createEmptyCounters(): PerfCounters {
  return {
    longTasks: 0,
    longTaskMs: 0,
    longAnimationFrames: 0,
    longAnimationFrameMs: 0,
    layoutShiftScore: 0,
    wsMessages: 0,
    wsBytes: 0,
    appRenders: 0,
    maxRenderMessages: 0,
  };
}

export function createEmptyFrameWindow(): FrameWindow {
  return {
    frames: 0,
    totalGapMs: 0,
    worstFrameMs: 0,
    droppedFrames: 0,
    jankFrames: 0,
  };
}

export function recordFrameGap(window: FrameWindow, gapMs: number): void {
  if (!Number.isFinite(gapMs) || gapMs <= 0) return;
  window.frames += 1;
  window.totalGapMs += gapMs;
  window.worstFrameMs = Math.max(window.worstFrameMs, gapMs);
  if (gapMs > 34) {
    window.droppedFrames += Math.max(1, Math.round(gapMs / 16.7) - 1);
  }
  if (gapMs > 50) window.jankFrames += 1;
}

export function buildPerfSample(args: {
  now: number;
  elapsedMs: number;
  frame: FrameWindow;
  counters: PerfCounters;
  loopLagMs: number;
  memory: PerfMemorySample | null;
  visibility: DocumentVisibilityState;
}): PerfSample {
  const elapsedSec = Math.max(args.elapsedMs / 1000, 0.001);
  return {
    t: args.now,
    elapsedMs: Math.round(args.elapsedMs),
    fps: round1(args.frame.frames / elapsedSec),
    avgFrameMs: args.frame.frames > 0 ? round1(args.frame.totalGapMs / args.frame.frames) : null,
    worstFrameMs: round1(args.frame.worstFrameMs),
    droppedFrames: args.frame.droppedFrames,
    jankFrames: args.frame.jankFrames,
    loopLagMs: round1(Math.max(0, args.loopLagMs)),
    longTasks: args.counters.longTasks,
    longTaskMs: round1(args.counters.longTaskMs),
    longAnimationFrames: args.counters.longAnimationFrames,
    longAnimationFrameMs: round1(args.counters.longAnimationFrameMs),
    layoutShiftScore: round3(args.counters.layoutShiftScore),
    wsMessagesPerSec: round1(args.counters.wsMessages / elapsedSec),
    wsKbPerSec: round1(args.counters.wsBytes / 1024 / elapsedSec),
    appRendersPerSec: round1(args.counters.appRenders / elapsedSec),
    maxRenderMessages: args.counters.maxRenderMessages,
    memory: args.memory,
    visibility: args.visibility,
  };
}

export function classifyPerfSample(sample: PerfSample | null): 'warming' | 'ok' | 'watch' | 'hot' {
  if (!sample) return 'warming';
  if (sample.visibility !== 'visible') return 'warming';
  if (
    sample.fps < 40 ||
    sample.worstFrameMs >= 120 ||
    sample.loopLagMs >= 120 ||
    sample.longTaskMs >= 180 ||
    sample.longAnimationFrameMs >= 180
  ) {
    return 'hot';
  }
  if (
    sample.fps < 52 ||
    sample.worstFrameMs >= 60 ||
    sample.loopLagMs >= 60 ||
    sample.longTasks > 0 ||
    sample.longAnimationFrames > 0 ||
    sample.jankFrames > 1
  ) {
    return 'watch';
  }
  return 'ok';
}

export function buildPerfReport(device: PerfDeviceInfo, history: PerfSample[]): PerfDiagnosticsReport {
  return {
    exportedAt: new Date().toISOString(),
    device,
    latest: history.length > 0 ? history[history.length - 1] : null,
    history,
    note:
      'Mobile browsers do not expose device temperature. Use this report to correlate heat with FPS drops, long tasks, JS heap growth, websocket bursts, render bursts, and compositor/WebGL details.',
  };
}

export function bytesToMb(bytes: number): number {
  return round1(bytes / 1024 / 1024);
}

function detectWebgl(): PerfDeviceInfo['webgl'] {
  if (typeof document === 'undefined') {
    return { available: false, version: null, vendor: null, renderer: null };
  }
  const canvas = document.createElement('canvas');
  const webgl2 = canvas.getContext('webgl2');
  const gl = webgl2 ?? canvas.getContext('webgl');
  if (!gl) return { available: false, version: null, vendor: null, renderer: null };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = debug ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : null;
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return {
    available: true,
    version: webgl2 ? 'webgl2' : 'webgl',
    vendor,
    renderer,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
