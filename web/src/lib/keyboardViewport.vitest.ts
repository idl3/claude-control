import { describe, it, expect } from 'vitest';
import { keyboardIsUp, KEYBOARD_UP_THRESHOLD_PX } from './keyboardViewport';

describe('keyboardIsUp', () => {
  it('is false at rest (visible viewport == layout viewport)', () => {
    expect(keyboardIsUp(695, 695)).toBe(false);
  });

  it('is true when the keyboard shrinks the visible viewport', () => {
    // iPhone-class: layout 695, keyboard leaves ~358 visible.
    expect(keyboardIsUp(695, 358)).toBe(true);
  });

  it('detects the keyboard from the LAYOUT height even when iOS scrolled the input into view', () => {
    // Regression guard for the direct-tap-from-dismissed bug: on that path iOS
    // scrolls the focused input into view, which (a) collapses
    // window.innerHeight to visualViewport.height and (b) inflates
    // visualViewport.offsetTop. The OLD detector
    //   innerHeight(358) - vvHeight(358) - offsetTop(337) = -337  → NOT up
    // silently failed, so the composer pin never engaged → gap. Detecting off
    // the STABLE documentElement.clientHeight (695) with no offsetTop term keeps
    // this true.
    const stableLayoutHeight = 695; // documentElement.clientHeight (does not collapse)
    const visibleHeight = 358; // visualViewport.height with keyboard up
    expect(keyboardIsUp(stableLayoutHeight, visibleHeight)).toBe(true);
  });

  it('ignores small deltas (e.g. an address bar / toolbar collapse) below the threshold', () => {
    expect(keyboardIsUp(695, 695 - (KEYBOARD_UP_THRESHOLD_PX - 1))).toBe(false);
  });

  it('flips exactly past the threshold', () => {
    expect(keyboardIsUp(1000, 1000 - KEYBOARD_UP_THRESHOLD_PX)).toBe(false); // == threshold, not strictly greater
    expect(keyboardIsUp(1000, 1000 - KEYBOARD_UP_THRESHOLD_PX - 1)).toBe(true);
  });

  it('honours a custom threshold', () => {
    expect(keyboardIsUp(800, 700, 150)).toBe(false); // delta 100 < 150
    expect(keyboardIsUp(800, 600, 150)).toBe(true); // delta 200 > 150
  });
});
