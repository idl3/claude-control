// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState } from 'react';
import {
  CC_BRIDGE_READY_TYPE,
  CC_PROPS_SET_TYPE,
  CC_PROPS_RESET_TYPE,
  isCcPropsSetShape,
  isCcPropsResetShape,
  isTrustedCcBridgeParent,
  parseCcInboundMessage,
  withCcBridge,
} from './ccBridgeRuntime';

afterEach(cleanup);

describe('isCcPropsSetShape', () => {
  it('accepts the exact shape', () => {
    expect(isCcPropsSetShape({ type: CC_PROPS_SET_TYPE, props: { count: 1 } })).toBe(true);
  });

  it('rejects a non-object props value', () => {
    expect(isCcPropsSetShape({ type: CC_PROPS_SET_TYPE, props: null })).toBe(false);
    expect(isCcPropsSetShape({ type: CC_PROPS_SET_TYPE, props: [1, 2] })).toBe(false);
    expect(isCcPropsSetShape({ type: CC_PROPS_SET_TYPE, props: 'x' })).toBe(false);
  });

  it('rejects extra keys ("exact shape" only)', () => {
    expect(isCcPropsSetShape({ type: CC_PROPS_SET_TYPE, props: {}, extra: 1 })).toBe(false);
  });

  it('rejects a wrong type / non-object data', () => {
    expect(isCcPropsSetShape({ type: 'nope', props: {} })).toBe(false);
    expect(isCcPropsSetShape(null)).toBe(false);
    expect(isCcPropsSetShape('x')).toBe(false);
  });
});

describe('isCcPropsResetShape', () => {
  it('accepts the exact bare shape', () => {
    expect(isCcPropsResetShape({ type: CC_PROPS_RESET_TYPE })).toBe(true);
  });

  it('rejects extra keys or a wrong type', () => {
    expect(isCcPropsResetShape({ type: CC_PROPS_RESET_TYPE, extra: 1 })).toBe(false);
    expect(isCcPropsResetShape({ type: 'nope' })).toBe(false);
  });
});

describe('isTrustedCcBridgeParent', () => {
  it('accepts a source that reference-equals window.parent', () => {
    const parent = {};
    expect(isTrustedCcBridgeParent(parent, parent)).toBe(true);
  });

  it('rejects a spoofed source — same shape, different object identity', () => {
    expect(isTrustedCcBridgeParent({}, {})).toBe(false);
  });

  it('rejects a null or undefined source', () => {
    const parent = {};
    expect(isTrustedCcBridgeParent(null, parent)).toBe(false);
    expect(isTrustedCcBridgeParent(undefined, parent)).toBe(false);
  });
});

describe('parseCcInboundMessage', () => {
  const parent = {};

  it('parses a trusted props-set message', () => {
    expect(parseCcInboundMessage(parent, parent, { type: CC_PROPS_SET_TYPE, props: { a: 1 } })).toEqual({
      kind: 'set',
      props: { a: 1 },
    });
  });

  it('parses a trusted props-reset message', () => {
    expect(parseCcInboundMessage(parent, parent, { type: CC_PROPS_RESET_TYPE })).toEqual({ kind: 'reset' });
  });

  it('rejects a spoofed source even with a valid shape', () => {
    expect(parseCcInboundMessage({}, parent, { type: CC_PROPS_RESET_TYPE })).toBeNull();
  });

  it('rejects a malformed / unrecognized shape from a trusted source', () => {
    expect(parseCcInboundMessage(parent, parent, { type: 'unknown-message' })).toBeNull();
  });
});

// Fixture with its OWN internal state, to prove props-set preserves it
// (React reconciles in place — same `key`) while props-reset discards it
// (the bridge bumps `key`, forcing a full remount). No JSX — this is a
// `.vitest.ts` file (see vite.config.ts's `test.include`), so fixtures use
// createElement directly, same convention as every other *.vitest.ts here.
function Fixture({ label }: { label: string }) {
  const [clicks, setClicks] = useState(0);
  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'label' }, label),
    createElement('span', { 'data-testid': 'clicks' }, String(clicks)),
    createElement('button', { onClick: () => setClicks((c) => c + 1) }, 'inc'),
  );
}

describe('withCcBridge', () => {
  it('announces cc-bridge-ready to window.parent on mount', () => {
    // jsdom: a non-framed document's window.parent === window itself, so
    // overriding window.postMessage observes what withCcBridge sends to
    // window.parent.postMessage without needing a real nested iframe.
    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
      render(createElement(Bridged));
      expect(posted).toContainEqual({ type: CC_BRIDGE_READY_TYPE, manifestVersion: 1 });
    } finally {
      window.postMessage = originalPostMessage;
    }
  });

  it("props-set round-trips and preserves the wrapped component's internal state", () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));
    expect(screen.getByTestId('label').textContent).toBe('hi');

    fireEvent.click(screen.getByText('inc'));
    fireEvent.click(screen.getByText('inc'));
    expect(screen.getByTestId('clicks').textContent).toBe('2');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: CC_PROPS_SET_TYPE, props: { label: 'bye' } },
          source: window,
        }),
      );
    });

    expect(screen.getByTestId('label').textContent).toBe('bye');
    // Internal state survived the props-set — same component instance (same `key`).
    expect(screen.getByTestId('clicks').textContent).toBe('2');
  });

  it('props-reset clears overrides AND remounts (internal state is discarded)', () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    fireEvent.click(screen.getByText('inc'));
    expect(screen.getByTestId('clicks').textContent).toBe('1');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: CC_PROPS_SET_TYPE, props: { label: 'bye' } },
          source: window,
        }),
      );
    });
    expect(screen.getByTestId('label').textContent).toBe('bye');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: CC_PROPS_RESET_TYPE }, source: window }),
      );
    });

    // Remounted: label reverts to the original exampleProps, clicks reset to 0.
    expect(screen.getByTestId('label').textContent).toBe('hi');
    expect(screen.getByTestId('clicks').textContent).toBe('0');
  });

  it('ignores a message with no matching source (spoofed / same-shape-different-window)', () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    act(() => {
      // No `source` set on a constructed MessageEvent defaults to null, which
      // never reference-equals window.parent.
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: CC_PROPS_SET_TYPE, props: { label: 'bye' } } }),
      );
    });

    expect(screen.getByTestId('label').textContent).toBe('hi');
  });
});
