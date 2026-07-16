// Pure, DOM-free helpers for the cosmos backdrop's shooting stars: which
// "depth" a given shot uses, the randomized numbers (angle/travel/duration/
// peak-alpha) that make each shot feel organic rather than a metronome, the
// randomized ambient cadence, and the active→idle "turn finished" edge that
// fires one on demand. Kept side-effect-free (every source of randomness is
// an injected `rand`) so behavior is unit-testable without mounting the app,
// GSAP, or the DOM. App.tsx wires these into real timers/GSAP/session state.
//
// Depth presets mirror the retired always-on CSS streaks (near/mid/far):
// near is biggest/brightest and crosses fastest (shortest visible window,
// longest travel distance); far is thinnest/dimmest and lingers longest
// (shortest travel distance). See styles.css's .cosmos-shoot-slot rules.
//
// durationMs below is the POST-speedup value: the coordinator asked for each
// streak to travel 2.1x faster than the initial pass (same distances/angles,
// just zips across quicker) — the /2.1 is baked in here rather than left as
// a separate runtime multiplier so there is exactly one number to read.

import type { Session } from './types';

export type ShootDepth = 'near' | 'mid' | 'far';

interface DepthPreset {
  angleDeg: number;
  travelXvw: number;
  travelYvw: number;
  durationMs: number;
  peakAlpha: number;
}

const FLIGHT_SPEEDUP = 2.1;

const PRESETS: Record<ShootDepth, DepthPreset> = {
  near: { angleDeg: 19, travelXvw: 150, travelYvw: 51, durationMs: 850 / FLIGHT_SPEEDUP, peakAlpha: 0.85 },
  mid: { angleDeg: 16, travelXvw: 115, travelYvw: 33, durationMs: 1150 / FLIGHT_SPEEDUP, peakAlpha: 0.5 },
  far: { angleDeg: 21, travelXvw: 70, travelYvw: 27, durationMs: 1550 / FLIGHT_SPEEDUP, peakAlpha: 0.3 },
};

/** Weighted pick — near/mid are equally common, far a bit rarer (echoes the
 *  retired three-streak mix, where the "far" cycle was the longest/rarest). */
export function pickDepth(rand: () => number = Math.random): ShootDepth {
  const r = rand();
  if (r < 0.4) return 'near';
  if (r < 0.75) return 'mid';
  return 'far';
}

/** `base` jittered by up to ±`pct` (e.g. pct = 0.15 → ±15%). */
export function jitter(base: number, pct: number, rand: () => number = Math.random): number {
  return base * (1 + (rand() * 2 - 1) * pct);
}

export interface Shot {
  depth: ShootDepth;
  angleDeg: number;
  travelXvw: number;
  travelYvw: number;
  durationMs: number;
  peakAlpha: number;
  /** Vertical start position, percent of the backdrop's height. */
  topPercent: number;
}

/** One randomized shot — depth is picked (weighted) unless given explicitly. */
export function buildShot(depth?: ShootDepth, rand: () => number = Math.random): Shot {
  const d = depth ?? pickDepth(rand);
  const preset = PRESETS[d];
  return {
    depth: d,
    angleDeg: jitter(preset.angleDeg, 0.15, rand),
    travelXvw: jitter(preset.travelXvw, 0.12, rand),
    travelYvw: jitter(preset.travelYvw, 0.12, rand),
    durationMs: jitter(preset.durationMs, 0.15, rand),
    peakAlpha: preset.peakAlpha,
    // Start row varies every shot so repeats never trace the same line.
    topPercent: 8 + rand() * 62,
  };
}

const AMBIENT_MIN_MS = 60_000;
const AMBIENT_MAX_MS = 150_000;

/** Randomized ambient gap — never less than a minute (well below the retired
 *  ~30-40s average gap), so "at most once per minute" holds by construction. */
export function nextAmbientDelayMs(rand: () => number = Math.random): number {
  return AMBIENT_MIN_MS + rand() * (AMBIENT_MAX_MS - AMBIENT_MIN_MS);
}

/**
 * Active→idle "turn finished" edge over a session list — the same signal
 * lib/push-trigger.js's evaluateEdges uses server-side to fire the "✅
 * finished" push (wasActive && !nowActive && !nowPending), reused here
 * client-side to fire a shooting star instead of/alongside the push. No
 * settle-window debounce (that exists server-side to survive the `thinking`
 * flag's ~2s TUI-scrape flicker for a real push notification); a decorative
 * shooting star firing an extra time on a flicker is low-stakes, and the
 * caller's own GSAP-slot-busy check already prevents overlap spam.
 *
 * `prevActive` is keyed by session id; pass the previous call's `nextActive`
 * back in next time (or an empty Map on first mount — an empty map can never
 * satisfy `wasActive`, so nothing fires just because the app loaded mid-run).
 */
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
