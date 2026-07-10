import { describe, it, expect, vi } from 'vitest';
import {
  CC_BRIDGE_READY_TYPE,
  CC_PROPS_SET_TYPE,
  CC_PROPS_RESET_TYPE,
  isCcBridgeReadyShape,
  isTrustedCcBridgeSource,
  isValidCcBridgeReady,
  sendCcPropsSet,
  sendCcPropsReset,
} from './appBridge';

describe('isCcBridgeReadyShape', () => {
  it('accepts the exact shape', () => {
    expect(isCcBridgeReadyShape({ type: CC_BRIDGE_READY_TYPE, manifestVersion: 1 })).toBe(true);
  });

  it('rejects a wrong type', () => {
    expect(isCcBridgeReadyShape({ type: 'not-it', manifestVersion: 1 })).toBe(false);
  });

  it('rejects a missing or non-number manifestVersion', () => {
    expect(isCcBridgeReadyShape({ type: CC_BRIDGE_READY_TYPE })).toBe(false);
    expect(isCcBridgeReadyShape({ type: CC_BRIDGE_READY_TYPE, manifestVersion: '1' })).toBe(false);
  });

  it('rejects extra keys beyond type/manifestVersion ("exact shape" only)', () => {
    expect(
      isCcBridgeReadyShape({ type: CC_BRIDGE_READY_TYPE, manifestVersion: 1, extra: 'x' }),
    ).toBe(false);
  });

  it('rejects non-object / nullish data', () => {
    expect(isCcBridgeReadyShape('cc-bridge-ready')).toBe(false);
    expect(isCcBridgeReadyShape(null)).toBe(false);
    expect(isCcBridgeReadyShape(undefined)).toBe(false);
    expect(isCcBridgeReadyShape(42)).toBe(false);
  });
});

describe('isTrustedCcBridgeSource', () => {
  it('accepts a source that reference-equals the tracked slot window', () => {
    const win = {};
    expect(isTrustedCcBridgeSource(win, win)).toBe(true);
  });

  it('rejects a spoofed source — same shape, different object identity', () => {
    expect(isTrustedCcBridgeSource({}, {})).toBe(false);
  });

  it('rejects a null or undefined source', () => {
    const win = {};
    expect(isTrustedCcBridgeSource(null, win)).toBe(false);
    expect(isTrustedCcBridgeSource(undefined, win)).toBe(false);
  });
});

describe('isValidCcBridgeReady (combined check)', () => {
  const win = {};

  it('accepts a matching source + exact shape — origin is never consulted', () => {
    expect(isValidCcBridgeReady(win, win, { type: CC_BRIDGE_READY_TYPE, manifestVersion: 1 })).toBe(
      true,
    );
  });

  it('rejects a spoofed source even with a perfectly valid shape', () => {
    expect(isValidCcBridgeReady({}, win, { type: CC_BRIDGE_READY_TYPE, manifestVersion: 1 })).toBe(
      false,
    );
  });

  it('rejects a valid source with a malformed shape', () => {
    expect(isValidCcBridgeReady(win, win, { type: CC_BRIDGE_READY_TYPE, extra: 1 })).toBe(false);
    expect(isValidCcBridgeReady(win, win, { type: 'something-else' })).toBe(false);
    expect(isValidCcBridgeReady(win, win, 'not an object')).toBe(false);
  });
});

describe('sendCcPropsSet / sendCcPropsReset', () => {
  it('posts a cc-props-set message with the given props to the target window', () => {
    const postMessage = vi.fn();
    sendCcPropsSet({ postMessage } as unknown as Window, { count: 5 });
    expect(postMessage).toHaveBeenCalledWith({ type: CC_PROPS_SET_TYPE, props: { count: 5 } }, '*');
  });

  it('posts a bare cc-props-reset message', () => {
    const postMessage = vi.fn();
    sendCcPropsReset({ postMessage } as unknown as Window);
    expect(postMessage).toHaveBeenCalledWith({ type: CC_PROPS_RESET_TYPE }, '*');
  });
});
