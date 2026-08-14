import type { Session } from './types';

export type FishDepth = 'near' | 'mid' | 'far';

interface FishPreset {
  travelXvw: number;
  travelYvh: number;
  durationMs: number;
  peakAlpha: number;
}

const PRESETS: Record<FishDepth, FishPreset> = {
  near: { travelXvw: 124, travelYvh: 4, durationMs: 9_000, peakAlpha: 0.44 },
  mid: { travelXvw: 118, travelYvh: -3, durationMs: 12_000, peakAlpha: 0.32 },
  far: { travelXvw: 112, travelYvh: 2, durationMs: 15_000, peakAlpha: 0.22 },
};

export function pickFishDepth(rand: () => number = Math.random): FishDepth {
  const r = rand();
  if (r < 0.28) return 'near';
  if (r < 0.72) return 'mid';
  return 'far';
}

function jitter(base: number, pct: number, rand: () => number): number {
  return base * (1 + (rand() * 2 - 1) * pct);
}

export interface FishSwim {
  depth: FishDepth;
  travelXvw: number;
  travelYvh: number;
  durationMs: number;
  peakAlpha: number;
  topPercent: number;
}

export function buildFishSwim(depth?: FishDepth, rand: () => number = Math.random): FishSwim {
  const d = depth ?? pickFishDepth(rand);
  const preset = PRESETS[d];
  return {
    depth: d,
    travelXvw: jitter(preset.travelXvw, 0.06, rand),
    travelYvh: jitter(preset.travelYvh, 0.45, rand),
    durationMs: jitter(preset.durationMs, 0.14, rand),
    peakAlpha: preset.peakAlpha,
    topPercent: 14 + rand() * 68,
  };
}

const AMBIENT_MIN_MS = 45_000;
const AMBIENT_MAX_MS = 125_000;

/** A fish occasionally crosses the backdrop; there is no continuous loop. */
export function nextFishDelayMs(rand: () => number = Math.random): number {
  return AMBIENT_MIN_MS + rand() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
}

export function detectTurnCompletions(
  prevActive: Map<string, boolean>,
  sessions: Session[],
  isActive: (s: Session) => boolean,
): { completed: string[]; nextActive: Map<string, boolean> } {
  const nextActive = new Map<string, boolean>();
  const completed: string[] = [];
  for (const s of sessions) {
    const wasActive = prevActive.get(s.id) ?? false;
    const nowActive = isActive(s);
    if (wasActive && !nowActive && !s.pending) completed.push(s.id);
    nextActive.set(s.id, nowActive);
  }
  return { completed, nextActive };
}
