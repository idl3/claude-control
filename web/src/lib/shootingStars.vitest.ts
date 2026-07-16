import { describe, it, expect } from 'vitest';
import { pickDepth, jitter, buildShot, nextAmbientDelayMs, detectTurnCompletions } from './shootingStars';
import type { Session } from './types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return { id: 's1', ...overrides };
}

describe('pickDepth', () => {
  it('picks near below 0.4, mid between 0.4 and 0.75, far above 0.75', () => {
    expect(pickDepth(() => 0)).toBe('near');
    expect(pickDepth(() => 0.39)).toBe('near');
    expect(pickDepth(() => 0.4)).toBe('mid');
    expect(pickDepth(() => 0.74)).toBe('mid');
    expect(pickDepth(() => 0.75)).toBe('far');
    expect(pickDepth(() => 0.999)).toBe('far');
  });
});

describe('jitter', () => {
  it('stays within +/- pct of base', () => {
    expect(jitter(100, 0.15, () => 0)).toBeCloseTo(85);
    expect(jitter(100, 0.15, () => 1)).toBeCloseTo(115);
    expect(jitter(100, 0.15, () => 0.5)).toBeCloseTo(100);
  });
});

describe('buildShot', () => {
  it('produces a shot for an explicit depth with all fields populated', () => {
    const shot = buildShot('far', () => 0.5);
    expect(shot.depth).toBe('far');
    expect(shot.angleDeg).toBeGreaterThan(0);
    expect(shot.travelXvw).toBeGreaterThan(0);
    expect(shot.travelYvw).toBeGreaterThan(0);
    expect(shot.durationMs).toBeGreaterThan(0);
    expect(shot.peakAlpha).toBeGreaterThan(0);
    expect(shot.topPercent).toBeGreaterThanOrEqual(8);
    expect(shot.topPercent).toBeLessThanOrEqual(70);
  });

  it('near travels further and finishes faster than far (post-speedup durations)', () => {
    const near = buildShot('near', () => 0.5);
    const far = buildShot('far', () => 0.5);
    expect(near.travelXvw).toBeGreaterThan(far.travelXvw);
    expect(near.durationMs).toBeLessThan(far.durationMs);
  });

  it('bakes in the 2.1x flight speedup — near lands well under half a second', () => {
    const near = buildShot('near', () => 0.5);
    // base near duration was 850ms; /2.1 ~= 405ms, +/-15% jitter caps it under 500ms
    expect(near.durationMs).toBeLessThan(500);
  });

  it('picks a weighted-random depth when none is given', () => {
    const shot = buildShot(undefined, () => 0);
    expect(shot.depth).toBe('near');
  });
});

describe('nextAmbientDelayMs', () => {
  it('never returns less than one minute (ambient cadence is "at most once per minute")', () => {
    expect(nextAmbientDelayMs(() => 0)).toBeGreaterThanOrEqual(60_000);
    expect(nextAmbientDelayMs(() => 1)).toBeLessThanOrEqual(150_000);
  });
});

describe('detectTurnCompletions', () => {
  const isActive = (s: Session) => !!s.thinking;

  it('does not fire on first run even if a session is already idle', () => {
    const sessions = [makeSession({ id: 'a', thinking: false })];
    const { completed, nextActive } = detectTurnCompletions(new Map(), sessions, isActive);
    expect(completed).toEqual([]);
    expect(nextActive.get('a')).toBe(false);
  });

  it('fires when a session flips from active to idle', () => {
    const prev = new Map([['a', true]]);
    const sessions = [makeSession({ id: 'a', thinking: false })];
    const { completed, nextActive } = detectTurnCompletions(prev, sessions, isActive);
    expect(completed).toEqual(['a']);
    expect(nextActive.get('a')).toBe(false);
  });

  it('does not fire when a session is still active', () => {
    const prev = new Map([['a', true]]);
    const sessions = [makeSession({ id: 'a', thinking: true })];
    const { completed } = detectTurnCompletions(prev, sessions, isActive);
    expect(completed).toEqual([]);
  });

  it('does not fire when the newly-idle session is pending a question', () => {
    const prev = new Map([['a', true]]);
    const sessions = [makeSession({ id: 'a', thinking: false, pending: true })];
    const { completed } = detectTurnCompletions(prev, sessions, isActive);
    expect(completed).toEqual([]);
  });

  it('tracks multiple sessions independently', () => {
    const prev = new Map([['a', true], ['b', false]]);
    const sessions = [
      makeSession({ id: 'a', thinking: false }),
      makeSession({ id: 'b', thinking: true }),
    ];
    const { completed, nextActive } = detectTurnCompletions(prev, sessions, isActive);
    expect(completed).toEqual(['a']);
    expect(nextActive.get('a')).toBe(false);
    expect(nextActive.get('b')).toBe(true);
  });
});
