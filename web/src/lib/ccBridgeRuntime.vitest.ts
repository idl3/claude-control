// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, useState } from 'react';

// D1: html-to-image is mocked so these tests never touch a real canvas/DOM
// rasterizer — jsdom has no rendering pipeline for toPng to walk. Each test
// controls the mock's resolution/rejection directly via the imported `toPng`
// reference below (same "import the mocked fn back" idiom vitest's own docs
// use for factory mocks).
vi.mock('html-to-image', () => ({ toPng: vi.fn() }));
import { toPng } from 'html-to-image';
import {
  CC_BRIDGE_READY_TYPE,
  CC_PROPS_SET_TYPE,
  CC_PROPS_RESET_TYPE,
  CC_CAPTURE_REQUEST_TYPE,
  CC_CAPTURE_RESULT_TYPE,
  isCcPropsSetShape,
  isCcPropsResetShape,
  isCcCaptureRequestShape,
  isTrustedCcBridgeParent,
  parseCcInboundMessage,
  captureCcBridgeSnapshot,
  withCcBridge,
} from './ccBridgeRuntime';

const mockToPng = vi.mocked(toPng);

afterEach(() => {
  cleanup();
  mockToPng.mockReset();
});

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

describe('isCcCaptureRequestShape', () => {
  it('accepts the exact shape', () => {
    expect(isCcCaptureRequestShape({ type: CC_CAPTURE_REQUEST_TYPE, requestId: 'r1' })).toBe(true);
  });

  it('rejects an empty or non-string requestId', () => {
    expect(isCcCaptureRequestShape({ type: CC_CAPTURE_REQUEST_TYPE, requestId: '' })).toBe(false);
    expect(isCcCaptureRequestShape({ type: CC_CAPTURE_REQUEST_TYPE, requestId: 1 })).toBe(false);
    expect(isCcCaptureRequestShape({ type: CC_CAPTURE_REQUEST_TYPE })).toBe(false);
  });

  it('rejects extra keys or a wrong type', () => {
    expect(isCcCaptureRequestShape({ type: CC_CAPTURE_REQUEST_TYPE, requestId: 'r1', extra: 1 })).toBe(
      false,
    );
    expect(isCcCaptureRequestShape({ type: 'nope', requestId: 'r1' })).toBe(false);
    expect(isCcCaptureRequestShape(null)).toBe(false);
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

  it('parses a trusted capture-request message', () => {
    expect(
      parseCcInboundMessage(parent, parent, { type: CC_CAPTURE_REQUEST_TYPE, requestId: 'r1' }),
    ).toEqual({ kind: 'capture', requestId: 'r1' });
  });

  it('rejects a capture-request from a spoofed source', () => {
    expect(
      parseCcInboundMessage({}, parent, { type: CC_CAPTURE_REQUEST_TYPE, requestId: 'r1' }),
    ).toBeNull();
  });
});

describe('captureCcBridgeSnapshot', () => {
  it('resolves toPng and posts a cc-capture-result with the dataUrl, tagged with requestId', async () => {
    mockToPng.mockResolvedValue('data:image/png;base64,AAAA');
    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      await captureCcBridgeSnapshot('req-1');
      expect(mockToPng).toHaveBeenCalledWith(document.body, { skipFonts: true });
      expect(posted).toContainEqual({
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'req-1',
        ok: true,
        dataUrl: 'data:image/png;base64,AAAA',
      });
    } finally {
      window.postMessage = originalPostMessage;
    }
  });

  it('posts ok:false with an error message when toPng rejects', async () => {
    mockToPng.mockRejectedValue(new Error('tainted canvas'));
    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      await captureCcBridgeSnapshot('req-2');
      expect(posted).toContainEqual({
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'req-2',
        ok: false,
        error: 'tainted canvas',
      });
    } finally {
      window.postMessage = originalPostMessage;
    }
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

  it('a trusted cc-capture-request triggers toPng and posts cc-capture-result back to window.parent', async () => {
    mockToPng.mockResolvedValue('data:image/png;base64,BBBB');
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: CC_CAPTURE_REQUEST_TYPE, requestId: 'req-9' },
            source: window,
          }),
        );
        // captureCcBridgeSnapshot is async (awaits toPng) — flush microtasks.
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(posted).toContainEqual({
        type: CC_CAPTURE_RESULT_TYPE,
        requestId: 'req-9',
        ok: true,
        dataUrl: 'data:image/png;base64,BBBB',
      });
    } finally {
      window.postMessage = originalPostMessage;
    }
  });

  it('ignores a cc-capture-request from a spoofed source — toPng is never invoked', async () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: CC_CAPTURE_REQUEST_TYPE, requestId: 'req-x' } }),
      );
      await Promise.resolve();
    });
    expect(mockToPng).not.toHaveBeenCalled();
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
