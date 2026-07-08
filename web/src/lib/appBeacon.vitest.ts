import { describe, it, expect } from 'vitest';
import {
  APP_ERROR_BEACON_TYPE,
  isAppErrorBeaconShape,
  isTrustedAppBeaconSource,
  isValidAppErrorBeacon,
} from './appBeacon';

describe('isAppErrorBeaconShape', () => {
  it('accepts the exact shape with no message', () => {
    expect(isAppErrorBeaconShape({ type: APP_ERROR_BEACON_TYPE })).toBe(true);
  });

  it('accepts the exact shape with a string message', () => {
    expect(isAppErrorBeaconShape({ type: APP_ERROR_BEACON_TYPE, message: 'boom' })).toBe(true);
  });

  it('rejects a wrong type', () => {
    expect(isAppErrorBeaconShape({ type: 'not-it' })).toBe(false);
  });

  it('rejects a non-string message', () => {
    expect(isAppErrorBeaconShape({ type: APP_ERROR_BEACON_TYPE, message: 42 })).toBe(false);
  });

  it('rejects extra keys beyond type/message ("exact shape" only)', () => {
    expect(isAppErrorBeaconShape({ type: APP_ERROR_BEACON_TYPE, extra: 'x' })).toBe(false);
    expect(
      isAppErrorBeaconShape({ type: APP_ERROR_BEACON_TYPE, message: 'boom', stack: 'x' }),
    ).toBe(false);
  });

  it('rejects non-object / nullish data', () => {
    expect(isAppErrorBeaconShape('cc-app-error')).toBe(false);
    expect(isAppErrorBeaconShape(null)).toBe(false);
    expect(isAppErrorBeaconShape(undefined)).toBe(false);
    expect(isAppErrorBeaconShape(42)).toBe(false);
  });
});

describe('isTrustedAppBeaconSource', () => {
  it('accepts a source that reference-equals the tracked slot window', () => {
    const win = {};
    expect(isTrustedAppBeaconSource(win, win)).toBe(true);
  });

  it('rejects a spoofed source — same shape, different object identity', () => {
    expect(isTrustedAppBeaconSource({}, {})).toBe(false);
  });

  it('rejects a null or undefined source', () => {
    const win = {};
    expect(isTrustedAppBeaconSource(null, win)).toBe(false);
    expect(isTrustedAppBeaconSource(undefined, win)).toBe(false);
  });

  it('rejects when the tracked slot window itself is null (no iframe mounted yet)', () => {
    expect(isTrustedAppBeaconSource(null, null)).toBe(false);
  });
});

describe('isValidAppErrorBeacon (combined check — AppFrameLayer message listener)', () => {
  const win = {};

  it('accepts a matching source + exact shape — origin is never consulted (opaque-origin frames report "null")', () => {
    expect(isValidAppErrorBeacon(win, win, { type: APP_ERROR_BEACON_TYPE, message: 'boom' })).toBe(
      true,
    );
    expect(isValidAppErrorBeacon(win, win, { type: APP_ERROR_BEACON_TYPE })).toBe(true);
  });

  it('rejects a spoofed source even with a perfectly valid shape', () => {
    expect(isValidAppErrorBeacon({}, win, { type: APP_ERROR_BEACON_TYPE })).toBe(false);
  });

  it('rejects a valid source with a malformed shape', () => {
    expect(isValidAppErrorBeacon(win, win, { type: APP_ERROR_BEACON_TYPE, extra: 1 })).toBe(false);
    expect(isValidAppErrorBeacon(win, win, { type: 'something-else' })).toBe(false);
    expect(isValidAppErrorBeacon(win, win, 'not an object')).toBe(false);
  });
});
