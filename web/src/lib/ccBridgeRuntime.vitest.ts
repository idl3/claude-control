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
  CC_DOM_OUTLINE_REQUEST_TYPE,
  CC_DOM_OUTLINE_RESULT_TYPE,
  isCcPropsSetShape,
  isCcPropsResetShape,
  isCcCaptureRequestShape,
  isCcDomOutlineRequestShape,
  isTrustedCcBridgeParent,
  parseCcInboundMessage,
  captureCcBridgeSnapshot,
  serializeCcDomOutline,
  postCcDomOutlineResult,
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

describe('isCcDomOutlineRequestShape', () => {
  it('accepts the exact bare shape', () => {
    expect(isCcDomOutlineRequestShape({ type: CC_DOM_OUTLINE_REQUEST_TYPE })).toBe(true);
  });

  it('rejects extra keys or a wrong type', () => {
    expect(isCcDomOutlineRequestShape({ type: CC_DOM_OUTLINE_REQUEST_TYPE, extra: 1 })).toBe(false);
    expect(isCcDomOutlineRequestShape({ type: 'nope' })).toBe(false);
    expect(isCcDomOutlineRequestShape(null)).toBe(false);
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

  it('parses a trusted dom-outline-request message', () => {
    expect(parseCcInboundMessage(parent, parent, { type: CC_DOM_OUTLINE_REQUEST_TYPE })).toEqual({
      kind: 'outline',
    });
  });

  it('rejects a dom-outline-request from a spoofed source', () => {
    expect(parseCcInboundMessage({}, parent, { type: CC_DOM_OUTLINE_REQUEST_TYPE })).toBeNull();
  });
});

describe('serializeCcDomOutline', () => {
  it('serializes tag/id/className/childCount and a direct-text preview', () => {
    document.body.innerHTML = '<div id="root" class="a b"><span>hello world</span></div>';
    const root = document.getElementById('root') as Element;
    const { tree, truncated } = serializeCcDomOutline(root);
    expect(truncated).toBe(false);
    expect(tree).toEqual({
      tag: 'div',
      id: 'root',
      className: 'a b',
      textPreview: null, // no DIRECT text node on #root — only an element child
      childCount: 1,
      children: [
        {
          tag: 'span',
          id: null,
          className: null,
          textPreview: 'hello world',
          childCount: 0,
          children: [],
        },
      ],
    });
  });

  it('hard-caps textPreview at 40 chars with no ellipsis marker, ignoring descendant text', () => {
    document.body.innerHTML =
      '<div id="root">' + 'x'.repeat(50) + '<span>this text is a descendant, not counted</span></div>';
    const root = document.getElementById('root') as Element;
    const { tree } = serializeCcDomOutline(root);
    expect(tree.textPreview).toBe('x'.repeat(40));
    expect(tree.textPreview?.length).toBe(40);
  });

  it('caps depth: a node exactly at maxDepth is included but childless, and flips truncated', () => {
    document.body.innerHTML = '<div id="d0"><div id="d1"><div id="d2">deep</div></div></div>';
    const root = document.getElementById('d0') as Element;
    const { tree, truncated } = serializeCcDomOutline(root, /* maxDepth */ 1, 2000);
    expect(truncated).toBe(true);
    expect(tree.tag).toBe('div');
    expect(tree.children).toHaveLength(1);
    const d1 = tree.children[0];
    expect(d1.id).toBe('d1');
    // d1 is AT maxDepth (depth 1) — real DOM childCount still reported...
    expect(d1.childCount).toBe(1);
    // ...but children is truncated to empty, since walking past maxDepth stops.
    expect(d1.children).toHaveLength(0);
  });

  it('caps total nodes at maxNodes across the WHOLE tree (not per-branch), and flips truncated', () => {
    // 1 root + 5 children = 6 nodes total; cap at 3 total.
    document.body.innerHTML =
      '<div id="root"><span></span><span></span><span></span><span></span><span></span></div>';
    const root = document.getElementById('root') as Element;
    const { tree, truncated } = serializeCcDomOutline(root, 12, /* maxNodes */ 3);
    expect(truncated).toBe(true);
    // root (1) + 2 children walked (2) = 3 visited before the cap stops the walk.
    expect(tree.children).toHaveLength(2);
  });

  it('does not truncate a tree that fits comfortably within both budgets', () => {
    document.body.innerHTML = '<div id="root"><span>a</span><span>b</span></div>';
    const root = document.getElementById('root') as Element;
    const { truncated } = serializeCcDomOutline(root);
    expect(truncated).toBe(false);
  });
});

describe('postCcDomOutlineResult', () => {
  it('posts a cc-dom-outline-result carrying the serialized tree to window.parent', () => {
    document.body.innerHTML = '<div id="root"><span>hi</span></div>';
    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      postCcDomOutlineResult(document.getElementById('root') as Element);
      expect(posted).toHaveLength(1);
      const msg = posted[0] as { type: string; truncated: boolean; tree: { tag: string } | null };
      expect(msg.type).toBe(CC_DOM_OUTLINE_RESULT_TYPE);
      expect(msg.truncated).toBe(false);
      expect(msg.tree?.tag).toBe('div');
    } finally {
      window.postMessage = originalPostMessage;
    }
  });

  it('degrades to tree:null (not a thrown error) when serialization itself throws', () => {
    // A throwing `id` getter simulates a hostile/buggy custom element —
    // serializeCcDomOutline's own try/catch (postCcDomOutlineResult) must
    // still post SOMETHING, not leave the request unanswered.
    const throwing = {
      tagName: 'DIV',
      get id(): string {
        throw new Error('boom');
      },
    } as unknown as Element;
    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      postCcDomOutlineResult(throwing);
      expect(posted).toContainEqual({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false });
    } finally {
      window.postMessage = originalPostMessage;
    }
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

  it('a trusted cc-dom-outline-request posts a cc-dom-outline-result back to window.parent', () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: CC_DOM_OUTLINE_REQUEST_TYPE }, source: window }),
        );
      });
      expect(posted).toHaveLength(1);
      const msg = posted[0] as { type: string; truncated: boolean };
      expect(msg.type).toBe(CC_DOM_OUTLINE_RESULT_TYPE);
      expect(msg.truncated).toBe(false);
    } finally {
      window.postMessage = originalPostMessage;
    }
  });

  it('ignores a cc-dom-outline-request from a spoofed source — no result is posted', () => {
    const Bridged = withCcBridge(Fixture, { label: 'hi' }, 1);
    render(createElement(Bridged));

    const posted: unknown[] = [];
    const originalPostMessage = window.postMessage;
    window.postMessage = ((data: unknown) => posted.push(data)) as typeof window.postMessage;
    try {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: CC_DOM_OUTLINE_REQUEST_TYPE } }), // no source
        );
      });
      expect(posted).toHaveLength(0);
    } finally {
      window.postMessage = originalPostMessage;
    }
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
