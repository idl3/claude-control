// Producer-injected runtime bundled INTO a cockpit-prototype-studio artifact
// (cockpit-prototype-studio, C2) — wraps a dogfood app's root component so
// claude-cockpit's Studio "Props" tab (C3) can drive its props live from
// outside the sandboxed iframe. Counterpart to appBridge.ts, which runs in
// the COCKPIT's own bundle (a different execution context — this module
// runs INSIDE the sandboxed srcdoc iframe once a producer's build script
// imports and calls withCcBridge; see web/scratch/counter-app/counter.tsx
// for a wiring example, C4). A plain in-repo module, not a copy-pasted
// template: esbuild's `bundle: true` (build.mjs) and Vite's automatic
// embedApp build (run.mjs) both resolve this relative import like any other
// local source file, so producers get a single, tested source of truth
// instead of hand-copied bridge code drifting per dogfood app. A synced
// template also lives at
// ~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx for
// producers OUTSIDE this repo (that skill has no access to web/src/lib) —
// see SKILL.md §5b.
//
// Trust model (mirrors appBeacon.ts / appBridge.ts exactly, but from the
// OTHER side of the same opaque-origin boundary): this code runs inside a
// sandbox="allow-scripts" (no allow-same-origin) srcdoc iframe, so
// `event.origin` on messages it receives is also the literal string 'null'
// and is NEVER consulted. `event.source` is checked against `window.parent`
// — the only legitimate source for cc-props-set/cc-props-reset — by
// reference equality, the same discriminator appBeacon.ts/appBridge.ts use
// in the other direction.
//
// Reserved, not yet handled (future phase — E2 tracker rationale):
// cc-console-entry.
//
// E1: cc-dom-outline-request/cc-dom-outline-result — same source-identity
// model as props-set/props-reset (event.source must reference-equal
// window.parent), a one-shot request/response like capture. On a trusted
// request, this module walks `document.body` into a depth/node-capped plain
// tree (serializeCcDomOutline) and posts it back as cc-dom-outline-result.
// Unlike capture, the result carries no requestId: a stale-but-valid outline
// is not a correctness hazard the way a stale capture would be (nothing is
// saved from it) — Studio's Inspector tab just shows a Refresh button for
// re-requesting, so no correlation/timeout machinery is needed here.
//
// D1: cc-capture-request/cc-capture-result — same source-identity model as
// props-set/props-reset above (event.source must reference-equal
// window.parent), but a one-shot request/response, not a state sync: on a
// trusted, well-shaped request, this module runs html-to-image's toPng over
// document.body and posts the resulting dataUrl (or an error string on
// failure — toPng CAN reject, e.g. a tainted/cross-origin image inside the
// artifact) back to window.parent, tagged with the SAME requestId so a late
// response can never be mistaken for a different, subsequent request's
// answer (see appBridge.ts's sendCcCaptureRequest doc comment). html-to-image
// is imported statically (not dynamically) — Phase D's Halt-N constraint
// requires the producer bundle stay a single static-import chunk, so the
// import cost lands on every artifact build, not just capture-invoking ones.

import { useEffect, useState, type ComponentType } from 'react';
import { toPng } from 'html-to-image';

export const CC_BRIDGE_READY_TYPE = 'cc-bridge-ready';
export const CC_PROPS_SET_TYPE = 'cc-props-set';
export const CC_PROPS_RESET_TYPE = 'cc-props-reset';
export const CC_CAPTURE_REQUEST_TYPE = 'cc-capture-request';
export const CC_CAPTURE_RESULT_TYPE = 'cc-capture-result';
export const CC_DOM_OUTLINE_REQUEST_TYPE = 'cc-dom-outline-request';
export const CC_DOM_OUTLINE_RESULT_TYPE = 'cc-dom-outline-result';

// E1: outline serialization budget — matches the acceptance ceiling exactly
// (depth <=12, total nodes <=2000). appBridge.ts re-enforces the SAME two
// numbers when validating an inbound result, defensively bounding its own
// validation cost regardless of what a buggy/hostile producer build claims.
export const CC_DOM_OUTLINE_MAX_DEPTH = 12;
export const CC_DOM_OUTLINE_MAX_NODES = 2000;
export const CC_DOM_OUTLINE_TEXT_PREVIEW_LENGTH = 40;

export type CcPropsSetMessage = { type: typeof CC_PROPS_SET_TYPE; props: Record<string, unknown> };
export type CcPropsResetMessage = { type: typeof CC_PROPS_RESET_TYPE };
export type CcCaptureRequestMessage = { type: typeof CC_CAPTURE_REQUEST_TYPE; requestId: string };
export type CcDomOutlineRequestMessage = { type: typeof CC_DOM_OUTLINE_REQUEST_TYPE };

/** One node in a serialized read-only DOM outline — see serializeCcDomOutline. */
export type CcDomOutlineNode = {
  tag: string;
  id: string | null;
  className: string | null;
  /** Direct text-node children only (not descendant text), trimmed, hard-capped at CC_DOM_OUTLINE_TEXT_PREVIEW_LENGTH chars. */
  textPreview: string | null;
  /** Actual element-child count in the live DOM, even if `children` was truncated by the depth/node budget. */
  childCount: number;
  children: CcDomOutlineNode[];
};

export type CcDomOutlineResultMessage = {
  type: typeof CC_DOM_OUTLINE_RESULT_TYPE;
  tree: CcDomOutlineNode | null;
  truncated: boolean;
};

/**
 * Exact-shape check for an inbound `cc-props-set` message — mirrors
 * appBeacon.ts's isAppErrorBeaconShape: `type` must be the exact literal,
 * `props` must be a plain object, and no other keys are allowed.
 */
export function isCcPropsSetShape(data: unknown): data is CcPropsSetMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => k !== 'type' && k !== 'props')) return false;
  if (rec.type !== CC_PROPS_SET_TYPE) return false;
  if (typeof rec.props !== 'object' || rec.props === null || Array.isArray(rec.props)) return false;
  return true;
}

/** Exact-shape check for an inbound `cc-props-reset` message — no other keys allowed. */
export function isCcPropsResetShape(data: unknown): data is CcPropsResetMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  return keys.length === 1 && keys[0] === 'type' && rec.type === CC_PROPS_RESET_TYPE;
}

/** Exact-shape check for an inbound `cc-capture-request` message — `requestId` must be a non-empty string, no other keys allowed. */
export function isCcCaptureRequestShape(data: unknown): data is CcCaptureRequestMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => k !== 'type' && k !== 'requestId')) return false;
  if (rec.type !== CC_CAPTURE_REQUEST_TYPE) return false;
  return typeof rec.requestId === 'string' && rec.requestId.length > 0;
}

/** Exact-shape check for an inbound `cc-dom-outline-request` message — no other keys allowed, same bare shape as props-reset. */
export function isCcDomOutlineRequestShape(data: unknown): data is CcDomOutlineRequestMessage {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  return keys.length === 1 && keys[0] === 'type' && rec.type === CC_DOM_OUTLINE_REQUEST_TYPE;
}

/**
 * Source-identity check — the iframe's own side of the boundary: the only
 * trusted sender of props-set/props-reset is window.parent.
 */
export function isTrustedCcBridgeParent(eventSource: unknown, parentWindow: unknown): boolean {
  return eventSource != null && eventSource === parentWindow;
}

export type CcBridgeInboundMessage =
  | { kind: 'set'; props: Record<string, unknown> }
  | { kind: 'reset' }
  | { kind: 'capture'; requestId: string }
  | { kind: 'outline' };

/**
 * Combined check the bridge's own `message` listener runs against every
 * inbound event — source identity AND exact shape must both hold. Returns
 * null for anything not recognized (untrusted source, malformed shape, or a
 * reserved-but-unhandled message type).
 */
export function parseCcInboundMessage(
  eventSource: unknown,
  parentWindow: unknown,
  data: unknown,
): CcBridgeInboundMessage | null {
  if (!isTrustedCcBridgeParent(eventSource, parentWindow)) return null;
  if (isCcPropsSetShape(data)) return { kind: 'set', props: data.props };
  if (isCcPropsResetShape(data)) return { kind: 'reset' };
  if (isCcCaptureRequestShape(data)) return { kind: 'capture', requestId: data.requestId };
  if (isCcDomOutlineRequestShape(data)) return { kind: 'outline' };
  return null;
}

/**
 * Direct (non-descendant) text content of `el`, trimmed and hard-capped at
 * CC_DOM_OUTLINE_TEXT_PREVIEW_LENGTH chars — deliberately NOT `el.textContent`
 * (which recursively includes every descendant's text too): a tree that
 * already shows nested elements as their own nodes doesn't need every
 * ancestor repeating the same descendant text in its own preview.
 */
function directTextPreview(el: Element): string | null {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3 /* Node.TEXT_NODE — jsdom/browser both define this constant on Node, but Node isn't guaranteed global here */) {
      text += node.textContent ?? '';
    }
  }
  text = text.trim();
  if (!text) return null;
  return text.length > CC_DOM_OUTLINE_TEXT_PREVIEW_LENGTH
    ? text.slice(0, CC_DOM_OUTLINE_TEXT_PREVIEW_LENGTH)
    : text;
}

/**
 * Walks `root` into a plain, read-only outline tree, depth- and node-capped.
 * `visited` is a single shared counter across the whole walk (closed over,
 * not per-branch) so "total nodes <=2000" is a genuine whole-tree budget, not
 * a per-branch one — a wide shallow tree and a narrow deep tree hit the same
 * ceiling. `maxDepth` bounds the deepest node VALUE the tree can contain
 * (root is depth 0); a node landing exactly at `maxDepth` is still included
 * itself, just childless in the output even if it has real DOM children
 * (which is what flips `truncated`).
 */
export function serializeCcDomOutline(
  root: Element,
  maxDepth: number = CC_DOM_OUTLINE_MAX_DEPTH,
  maxNodes: number = CC_DOM_OUTLINE_MAX_NODES,
): { tree: CcDomOutlineNode; truncated: boolean } {
  let visited = 0;
  let truncated = false;

  function walk(el: Element, depth: number): CcDomOutlineNode {
    visited += 1;
    const childCount = el.children.length;
    const children: CcDomOutlineNode[] = [];
    if (depth >= maxDepth) {
      if (childCount > 0) truncated = true;
    } else {
      for (const child of Array.from(el.children)) {
        if (visited >= maxNodes) {
          truncated = true;
          break;
        }
        children.push(walk(child, depth + 1));
      }
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' && el.className ? el.className : null,
      textPreview: directTextPreview(el),
      childCount,
      children,
    };
  }

  return { tree: walk(root, 0), truncated };
}

/**
 * Serializes `root` (defaults to document.body, parity with D1's capture
 * target) and posts the result to window.parent as `cc-dom-outline-result`.
 * try/catch mirrors captureCcBridgeSnapshot's defensive shape even though the
 * DOM walk itself is synchronous — a custom element with a throwing getter
 * (e.g. a hostile/buggy `id`/`className` accessor) is plausible in a
 * producer's own markup, and this is one-shot best-effort telemetry, not a
 * mutation that must never silently no-op.
 */
export function postCcDomOutlineResult(root: Element = document.body): void {
  try {
    const { tree, truncated } = serializeCcDomOutline(root);
    window.parent.postMessage({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree, truncated }, '*');
  } catch {
    window.parent.postMessage({ type: CC_DOM_OUTLINE_RESULT_TYPE, tree: null, truncated: false }, '*');
  }
}

/**
 * Runs html-to-image's toPng over `document.body` (the artifact's full
 * rendered root — simplest reliable capture target, no dependency on any
 * app-specific root element id) and posts the result back to window.parent
 * as `cc-capture-result`, tagged with the same requestId the request
 * carried. `skipFonts: true` avoids toPng's most common failure mode
 * (embedding @font-face rules from a cross-origin stylesheet throws a
 * SecurityError) at the cost of web-font glyphs not rendering pixel-perfect
 * in the capture — an acceptable trade for a screenshot tool, not a
 * pixel-perfect export. This is an OUTBOUND send once triggered by a
 * trusted, validated request, so (like sendCcPropsSet/sendCcPropsReset in
 * appBridge.ts) it applies no further validation of its own.
 */
export async function captureCcBridgeSnapshot(requestId: string): Promise<void> {
  try {
    const dataUrl = await toPng(document.body, { skipFonts: true });
    window.parent.postMessage({ type: CC_CAPTURE_RESULT_TYPE, requestId, ok: true, dataUrl }, '*');
  } catch (err) {
    window.parent.postMessage(
      {
        type: CC_CAPTURE_RESULT_TYPE,
        requestId,
        ok: false,
        error: err instanceof Error ? err.message : 'capture failed',
      },
      '*',
    );
  }
}

/**
 * Wraps `RootComponent` so a cockpit Studio "Props" tab can drive its props
 * live: announces `cc-bridge-ready{manifestVersion}` to window.parent on
 * mount, then applies `cc-props-set` merges (spread onto `exampleProps` with
 * the SAME `key` — React reconciles in place, preserving RootComponent's own
 * internal state) and `cc-props-reset` (clears overrides AND bumps `key` to
 * force a full remount, discarding RootComponent's internal state too —
 * "reset to defaults" means both, not just the props).
 */
export function withCcBridge<P extends Record<string, unknown>>(
  RootComponent: ComponentType<P>,
  exampleProps: P,
  manifestVersion = 1,
) {
  return function CcBridgeRoot() {
    const [overrides, setOverrides] = useState<Partial<P>>({});
    const [resetKey, setResetKey] = useState(0);

    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires exactly once, mirrors CounterBoundary's mount-only announce
    useEffect(() => {
      window.parent.postMessage({ type: CC_BRIDGE_READY_TYPE, manifestVersion }, '*');
    }, []);

    useEffect(() => {
      function onMessage(event: MessageEvent) {
        const msg = parseCcInboundMessage(event.source, window.parent, event.data);
        if (!msg) return;
        if (msg.kind === 'set') {
          setOverrides((prev) => ({ ...prev, ...msg.props }));
        } else if (msg.kind === 'reset') {
          setOverrides({});
          setResetKey((k) => k + 1);
        } else if (msg.kind === 'capture') {
          void captureCcBridgeSnapshot(msg.requestId);
        } else {
          postCcDomOutlineResult();
        }
      }
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    return <RootComponent key={resetKey} {...exampleProps} {...overrides} />;
  };
}
