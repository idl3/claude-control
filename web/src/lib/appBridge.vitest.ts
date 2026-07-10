import { describe, it, expect, vi } from 'vitest';
import {
  CC_BRIDGE_READY_TYPE,
  CC_PROPS_SET_TYPE,
  CC_PROPS_RESET_TYPE,
  CC_CAPTURE_REQUEST_TYPE,
  CC_CAPTURE_RESULT_TYPE,
  isCcBridgeReadyShape,
  isCcCaptureResultShape,
  isTrustedCcBridgeSource,
  isValidCcBridgeReady,
  isValidCcCaptureResult,
  sendCcPropsSet,
  sendCcPropsReset,
  sendCcCaptureRequest,
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

describe('isCcCaptureResultShape', () => {
  it('accepts a well-formed success result', () => {
    expect(
      isCcCaptureResultShape({
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'r1',
        ok: true,
        dataUrl: 'data:image/png;base64,AAAA',
      }),
    ).toBe(true);
  });

  it('accepts a well-formed failure result', () => {
    expect(
      isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: 'r1', ok: false, error: 'boom' }),
    ).toBe(true);
  });

  it('rejects a success result with an empty dataUrl, or a missing dataUrl entirely', () => {
    expect(
      isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: 'r1', ok: true, dataUrl: '' }),
    ).toBe(false);
    expect(isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: 'r1', ok: true })).toBe(
      false,
    );
  });

  it('rejects ok:true carrying an `error` key instead of `dataUrl` (discriminant mismatch, not coerced)', () => {
    expect(
      isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: 'r1', ok: true, error: 'x' }),
    ).toBe(false);
  });

  it('rejects a missing/empty requestId, a non-boolean ok, or extra keys', () => {
    expect(
      isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: '', ok: true, dataUrl: 'x' }),
    ).toBe(false);
    expect(
      isCcCaptureResultShape({ type: CC_CAPTURE_RESULT_TYPE, requestId: 'r1', ok: 'yes', dataUrl: 'x' }),
    ).toBe(false);
    expect(
      isCcCaptureResultShape({
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'r1',
        ok: true,
        dataUrl: 'x',
        extra: 1,
      }),
    ).toBe(false);
  });

  it('rejects a wrong type or non-object data', () => {
    expect(isCcCaptureResultShape({ type: 'nope', requestId: 'r1', ok: true, dataUrl: 'x' })).toBe(false);
    expect(isCcCaptureResultShape(null)).toBe(false);
  });
});

describe('isValidCcCaptureResult (combined check)', () => {
  const win = {};

  it('accepts a matching source + exact shape', () => {
    expect(
      isValidCcCaptureResult(win, win, {
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'r1',
        ok: true,
        dataUrl: 'x',
      }),
    ).toBe(true);
  });

  it('rejects a spoofed source even with a perfectly valid shape', () => {
    expect(
      isValidCcCaptureResult({}, win, {
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'r1',
        ok: true,
        dataUrl: 'x',
      }),
    ).toBe(false);
  });
});

describe('sendCcCaptureRequest', () => {
  it('posts a cc-capture-request message with the given requestId to the target window', () => {
    const postMessage = vi.fn();
    sendCcCaptureRequest({ postMessage } as unknown as Window, 'req-1');
    expect(postMessage).toHaveBeenCalledWith(
      { type: CC_CAPTURE_REQUEST_TYPE, requestId: 'req-1' },
      '*',
    );
  });
});
