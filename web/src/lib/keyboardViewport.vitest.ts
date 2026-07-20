import { describe, it, expect } from 'vitest';
import { keyboardIsUp, KEYBOARD_UP_THRESHOLD_PX, isEditableElement, softKeyboardIsUp } from './keyboardViewport';

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

describe('isEditableElement', () => {
  const asEl = (o: { tagName: string; type?: string; isContentEditable?: boolean }) =>
    o as unknown as Element;
  it('is false for null', () => {
    expect(isEditableElement(null)).toBe(false);
  });
  it('is true for a textarea', () => {
    expect(isEditableElement(asEl({ tagName: 'TEXTAREA' }))).toBe(true);
  });
  it('is true for a text input and a type-less input', () => {
    expect(isEditableElement(asEl({ tagName: 'INPUT', type: 'text' }))).toBe(true);
    expect(isEditableElement(asEl({ tagName: 'INPUT' }))).toBe(true);
  });
  it('is false for non-text input types that raise no keyboard', () => {
    for (const type of ['button', 'checkbox', 'range', 'file', 'radio']) {
      expect(isEditableElement(asEl({ tagName: 'INPUT', type }))).toBe(false);
    }
  });
  it('is true for a contenteditable element, false for a plain div', () => {
    expect(isEditableElement(asEl({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isEditableElement(asEl({ tagName: 'DIV' }))).toBe(false);
  });
});

describe('softKeyboardIsUp', () => {
  it('is false when no editable is focused, even on a large viewport shrink', () => {
    // iPad toolbar-collapse / transcript-load reflow: viewport shrinks, no keyboard.
    expect(
      softKeyboardIsUp({ layoutHeight: 1194, visualViewportHeight: 900, hasEditableFocus: false }),
    ).toBe(false);
  });
  it('is true on an iPhone keyboard shrink with an editable focused', () => {
    expect(
      softKeyboardIsUp({ layoutHeight: 695, visualViewportHeight: 358, hasEditableFocus: true }),
    ).toBe(true);
  });
  it('is true on an iPad-portrait keyboard shrink with an editable focused', () => {
    // ~370px keyboard on a 1194px layout: past the 120px floor AND past 25% (298px).
    expect(
      softKeyboardIsUp({ layoutHeight: 1194, visualViewportHeight: 824, hasEditableFocus: true }),
    ).toBe(true);
  });
  it('is false when the drop clears the px floor but not the ratio (iPad non-keyboard shift with a field focused)', () => {
    // 200px drop on a 1194px layout: >120px but <25% (298px) → not a keyboard.
    expect(
      softKeyboardIsUp({ layoutHeight: 1194, visualViewportHeight: 994, hasEditableFocus: true }),
    ).toBe(false);
  });
  it('still requires the px floor on a small layout', () => {
    // drop 90 on 300px layout: >25% (75px) but <120px floor → false.
    expect(
      softKeyboardIsUp({ layoutHeight: 300, visualViewportHeight: 210, hasEditableFocus: true }),
    ).toBe(false);
  });
});
