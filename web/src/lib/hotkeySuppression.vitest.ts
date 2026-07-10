// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import {
  getHotkeySuppressed,
  isSuppressedCombo,
  setHotkeySuppressed,
  subscribeHotkeySuppressed,
  useHotkeySuppressionInterceptor,
} from './hotkeySuppression';

afterEach(() => {
  cleanup();
  setHotkeySuppressed(false); // reset the module-level singleton between tests
});

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

describe('hotkey suppression store', () => {
  it('defaults to OFF (not suppressed)', () => {
    expect(getHotkeySuppressed()).toBe(false);
  });

  it('set() updates the flag and notifies subscribers', () => {
    const fn = vi.fn();
    const unsub = subscribeHotkeySuppressed(fn);
    setHotkeySuppressed(true);
    expect(getHotkeySuppressed()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(true);
    unsub();
  });

  it('set() to the same value is a no-op (no notification)', () => {
    const fn = vi.fn();
    setHotkeySuppressed(false); // already false
    const unsub = subscribeHotkeySuppressed(fn);
    setHotkeySuppressed(false);
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    const fn = vi.fn();
    const unsub = subscribeHotkeySuppressed(fn);
    unsub();
    setHotkeySuppressed(true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('isSuppressedCombo', () => {
  it('never suppresses Escape, even with modifiers', () => {
    expect(isSuppressedCombo(keydown({ key: 'Escape' }))).toBe(false);
    expect(isSuppressedCombo(keydown({ key: 'Escape', metaKey: true }))).toBe(false);
  });

  it('never suppresses plain typing (no modifier)', () => {
    for (const key of ['k', 'a', 'Enter', 'Tab', ' ']) {
      expect(isSuppressedCombo(keydown({ key }))).toBe(false);
    }
  });

  it('suppresses modifier combos (meta/ctrl/alt)', () => {
    expect(isSuppressedCombo(keydown({ key: 'k', metaKey: true }))).toBe(true);
    expect(isSuppressedCombo(keydown({ key: 'k', ctrlKey: true }))).toBe(true);
    expect(isSuppressedCombo(keydown({ key: 'Tab', altKey: true }))).toBe(true);
  });

  it('carves out Cmd/Ctrl+C/V/X (copy/paste/cut)', () => {
    expect(isSuppressedCombo(keydown({ key: 'c', metaKey: true }))).toBe(false);
    expect(isSuppressedCombo(keydown({ key: 'v', metaKey: true }))).toBe(false);
    expect(isSuppressedCombo(keydown({ key: 'x', metaKey: true }))).toBe(false);
    expect(isSuppressedCombo(keydown({ key: 'C', ctrlKey: true }))).toBe(false); // case-insensitive
  });

  it('does NOT carve out Cmd+Shift+C (a different combo than plain copy)', () => {
    expect(isSuppressedCombo(keydown({ key: 'c', metaKey: true, shiftKey: true }))).toBe(true);
  });
});

// Mounted ordering test: proves the capture-phase interceptor, registered via
// useLayoutEffect at mount, runs before ANY listener registered after it —
// bubble or capture — because it stopImmediatePropagation()s the event in
// the capture phase before the DOM ever reaches later listeners.
function TestHost() {
  useHotkeySuppressionInterceptor();
  return null;
}

describe('useHotkeySuppressionInterceptor (mounted)', () => {
  it('blocks a spy listener (bubble AND capture, registered after) while ON; passes while OFF', () => {
    render(createElement(TestHost));

    const bubbleSpy = vi.fn();
    const captureSpy = vi.fn();
    window.addEventListener('keydown', bubbleSpy);
    window.addEventListener('keydown', captureSpy, true);

    setHotkeySuppressed(true);
    window.dispatchEvent(keydown({ key: 'k', metaKey: true }));
    expect(bubbleSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();

    setHotkeySuppressed(false);
    window.dispatchEvent(keydown({ key: 'k', metaKey: true }));
    expect(bubbleSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledTimes(1);

    window.removeEventListener('keydown', bubbleSpy);
    window.removeEventListener('keydown', captureSpy, true);
  });

  it('Escape always reaches later listeners, even while suppression is ON', () => {
    render(createElement(TestHost));
    const spy = vi.fn();
    window.addEventListener('keydown', spy);

    setHotkeySuppressed(true);
    window.dispatchEvent(keydown({ key: 'Escape' }));
    expect(spy).toHaveBeenCalledTimes(1);

    window.removeEventListener('keydown', spy);
  });

  it('Cmd+C always reaches later listeners, even while suppression is ON', () => {
    render(createElement(TestHost));
    const spy = vi.fn();
    window.addEventListener('keydown', spy);

    setHotkeySuppressed(true);
    window.dispatchEvent(keydown({ key: 'c', metaKey: true }));
    expect(spy).toHaveBeenCalledTimes(1);

    window.removeEventListener('keydown', spy);
  });

  it('does not preventDefault on plain typing (no modifier)', () => {
    render(createElement(TestHost));
    setHotkeySuppressed(true);
    const e = keydown({ key: 'a' });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('preventDefault + stopImmediatePropagation on a suppressed combo', () => {
    render(createElement(TestHost));
    setHotkeySuppressed(true);
    const e = keydown({ key: 'k', metaKey: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('cleanup on unmount removes the interceptor — later listeners see events again even if the flag is still ON', () => {
    const { unmount } = render(createElement(TestHost));
    const spy = vi.fn();
    window.addEventListener('keydown', spy);

    setHotkeySuppressed(true);
    window.dispatchEvent(keydown({ key: 'k', metaKey: true }));
    expect(spy).not.toHaveBeenCalled();

    unmount();
    window.dispatchEvent(keydown({ key: 'k', metaKey: true }));
    expect(spy).toHaveBeenCalledTimes(1); // interceptor gone; nothing stops propagation now

    window.removeEventListener('keydown', spy);
  });
});
