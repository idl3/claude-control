import { describe, it, expect, vi } from 'vitest';
import {
  CC_BRIDGE_READY_TYPE,
  CC_PROPS_SET_TYPE,
  CC_PROPS_RESET_TYPE,
  CC_CAPTURE_REQUEST_TYPE,
  CC_CAPTURE_RESULT_TYPE,
  CC_DOM_OUTLINE_REQUEST_TYPE,
  CC_DOM_OUTLINE_RESULT_TYPE,
  isCcBridgeReadyShape,
  isCcCaptureResultShape,
  isCcDomOutlineResultShape,
  isTrustedCcBridgeSource,
  isValidCcBridgeReady,
  isValidCcCaptureResult,
  isValidCcDomOutlineResult,
  sendCcPropsSet,
  sendCcPropsReset,
  sendCcCaptureRequest,
  sendCcDomOutlineRequest,
  type CcDomOutlineNode,
} from './appBridge';

/** A minimal well-formed outline node — reused as a base fixture below. */
const LEAF: CcDomOutlineNode = {
  tag: 'span',
  id: null,
  className: null,
  textPreview: null,
  childCount: 0,
  children: [],
};

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

describe('isCcDomOutlineResultShape', () => {
  it('accepts tree:null (the producer-side degrade case)', () => {
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false })).toBe(
      true,
    );
  });

  it('accepts a well-formed non-null tree, including nested children', () => {
    const tree: CcDomOutlineNode = { ...LEAF, tag: 'div', id: 'root', childCount: 1, children: [LEAF] };
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree, truncated: true })).toBe(
      true,
    );
  });

  it('rejects a missing/non-boolean truncated, a wrong type, or extra top-level keys', () => {
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null })).toBe(false);
    expect(
      isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: 'no' }),
    ).toBe(false);
    expect(isCcDomOutlineResultShape({ type: 'nope', tree: null, truncated: false })).toBe(false);
    expect(
      isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false, extra: 1 }),
    ).toBe(false);
  });

  it('rejects a node missing a required key, an extra key, or a wrong field type', () => {
    const { childCount: _drop, ...missingChildCount } = LEAF;
    expect(
      isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: missingChildCount, truncated: false }),
    ).toBe(false);
    expect(
      isCcDomOutlineResultShape({
        type: CC_DOM_OUTLINE_RESULT_TYPE,
        tree: { ...LEAF, extra: 'x' },
        truncated: false,
      }),
    ).toBe(false);
    expect(
      isCcDomOutlineResultShape({
        type: CC_DOM_OUTLINE_RESULT_TYPE,
        tree: { ...LEAF, childCount: '0' },
        truncated: false,
      }),
    ).toBe(false);
    expect(
      isCcDomOutlineResultShape({
        type: CC_DOM_OUTLINE_RESULT_TYPE,
        tree: { ...LEAF, children: 'nope' },
        truncated: false,
      }),
    ).toBe(false);
  });

  it('rejects a tree deeper than the shared 12-level budget, even though each individual node is well-formed', () => {
    // Build a chain 14 nodes deep (depths 0..13) — one past the 12 ceiling.
    let node: CcDomOutlineNode = LEAF;
    for (let i = 0; i < 13; i++) {
      node = { ...LEAF, children: [node] };
    }
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: node, truncated: true })).toBe(
      false,
    );
  });

  it('rejects a tree wider than the shared 2000-node budget', () => {
    const children = Array.from({ length: 2001 }, () => ({ ...LEAF }));
    const tree: CcDomOutlineNode = { ...LEAF, children };
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree, truncated: true })).toBe(
      false,
    );
  });

  it('accepts a tree exactly at the depth/node ceilings (never rejects a legitimately-capped result)', () => {
    // Exactly 12 nested levels below the root (depths 0..12 inclusive = 13
    // nodes total) is what serializeCcDomOutline itself can legitimately
    // produce at maxDepth=12 — must not be rejected here.
    let node: CcDomOutlineNode = LEAF;
    for (let i = 0; i < 12; i++) {
      node = { ...LEAF, children: [node] };
    }
    expect(isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: node, truncated: true })).toBe(
      true,
    );
  });

  it('rejects a self-referencing (cyclic) node — the depth cap terminates the recursive walk before infinite recursion, a hostile/buggy producer can never hang or crash validation', () => {
    // A hostile or buggy producer build could post a tree whose own
    // `children` array cycles back to an ancestor (or itself) instead of
    // terminating in leaves. isPlainOutlineNodeShape's depth check
    // (`if (depth > CC_DOM_OUTLINE_MAX_DEPTH) return false;`) is the FIRST
    // line of the recursive walk, evaluated before it ever re-enters
    // `.every(...)` on the current node's children — so a cycle can recurse
    // at most CC_DOM_OUTLINE_MAX_DEPTH+1 (13) stack frames deep before this
    // returns false, never actually looping forever or blowing the stack.
    const n = { tag: 'div', id: null, className: null, textPreview: '', childCount: 1, children: [] as any[] };
    n.children.push(n);
    expect(
      isCcDomOutlineResultShape({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: n, truncated: true }),
    ).toBe(false);
  });
});

describe('isValidCcDomOutlineResult (combined check)', () => {
  const win = {};

  it('accepts a matching source + exact shape', () => {
    expect(
      isValidCcDomOutlineResult(win, win, { type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false }),
    ).toBe(true);
  });

  it('rejects a spoofed source even with a perfectly valid shape', () => {
    expect(
      isValidCcDomOutlineResult({}, win, { type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false }),
    ).toBe(false);
  });

  it('rejects a valid source with a malformed shape', () => {
    expect(isValidCcDomOutlineResult(win, win, { type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null })).toBe(
      false,
    );
  });
});

describe('sendCcDomOutlineRequest', () => {
  it('posts a bare cc-dom-outline-request message to the target window', () => {
    const postMessage = vi.fn();
    sendCcDomOutlineRequest({ postMessage } as unknown as Window);
    expect(postMessage).toHaveBeenCalledWith({ type: CC_DOM_OUTLINE_REQUEST_TYPE }, '*');
  });
});
