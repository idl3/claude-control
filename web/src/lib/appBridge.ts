// Cockpit-side half of the cc-bridge protocol (cockpit-prototype-studio, C2).
// The artifact-side counterpart lives in ccBridgeRuntime.tsx, bundled INTO
// the artifact itself (a different execution context: this file runs in the
// cockpit's own bundle; that one runs inside the sandboxed srcdoc iframe a
// producer's build script wraps its root component with — see
// web/scratch/counter-app/counter.tsx, C4).
//
// Trust model — identical to appBeacon.ts: `event.origin` is the literal
// string 'null' for a sandbox="allow-scripts" (no allow-same-origin) srcdoc
// iframe, an opaque origin that carries no information, so it is NOT
// consulted here. `event.source` (the iframe's own contentWindow, as
// observed by the parent) is the only thing that distinguishes a genuine
// cc-bridge-ready announcement from a same-page script or an unrelated
// window also posting to the parent — checked in addition to, never instead
// of, the exact shape check below.

export const CC_BRIDGE_READY_TYPE = 'cc-bridge-ready';
export const CC_PROPS_SET_TYPE = 'cc-props-set';
export const CC_PROPS_RESET_TYPE = 'cc-props-reset';
export const CC_CAPTURE_REQUEST_TYPE = 'cc-capture-request';
export const CC_CAPTURE_RESULT_TYPE = 'cc-capture-result';
export const CC_DOM_OUTLINE_REQUEST_TYPE = 'cc-dom-outline-request';
export const CC_DOM_OUTLINE_RESULT_TYPE = 'cc-dom-outline-result';

/**
 * E1: re-enforced defensively on the cockpit side, at the SAME ceilings
 * ccBridgeRuntime.tsx's own serializeCcDomOutline uses to produce a result.
 * Source-identity proves the message genuinely came from the tracked
 * iframe, but not that ITS OWN serialization code stayed within its
 * advertised caps — a buggy or compromised producer build could still emit
 * a tree deeper/wider than it claims. Re-walking with the same numbers
 * bounds isCcDomOutlineResultShape's own validation cost to a fixed worst
 * case regardless of what a hostile payload contains, while never rejecting
 * a legitimately-capped result (same numbers, so nothing correctly
 * truncated on the producer side can ever exceed them here).
 */
const CC_DOM_OUTLINE_MAX_DEPTH = 12;
const CC_DOM_OUTLINE_MAX_NODES = 2000;

export type CcBridgeReady = { type: typeof CC_BRIDGE_READY_TYPE; manifestVersion: number };

export type CcDomOutlineNode = {
  tag: string;
  id: string | null;
  className: string | null;
  textPreview: string | null;
  childCount: number;
  children: CcDomOutlineNode[];
};

export type CcDomOutlineResult = {
  type: typeof CC_DOM_OUTLINE_RESULT_TYPE;
  tree: CcDomOutlineNode | null;
  truncated: boolean;
};

export type CcCaptureResult =
  | { type: typeof CC_CAPTURE_RESULT_TYPE; requestId: string; ok: true; dataUrl: string }
  | { type: typeof CC_CAPTURE_RESULT_TYPE; requestId: string; ok: false; error: string };

/**
 * Upper bound on an inbound `cc-capture-result`'s `dataUrl` STRING length —
 * checked by the cockpit in StudioModal.tsx's onMessage handler, BEFORE
 * entering the review/annotate stage, not baked into `isCcCaptureResultShape`
 * below: folding it into the shape check would make an oversize result fail
 * exact-shape validation entirely, and the caller's `if (!isValid...) return`
 * early-out would then silently drop it with no error surfaced — the CP3
 * audit explicitly requires the existing capture-failed error chip to fire
 * instead (Studio Phase D CP3, FIX 1).
 *
 * ~15MB of base64 TEXT comfortably covers lib/media-captures.js's
 * MAX_CAPTURE_BYTES (8MB DECODED): base64 inflates by 4/3, so an 8MB PNG
 * encodes to ~10.9MB of base64 text; 15MB leaves headroom above that plus the
 * `data:image/png;base64,` header — keep this in sync with the server ceiling
 * if either changes.
 */
export const MAX_CC_CAPTURE_DATA_URL_LENGTH = 15 * 1024 * 1024;

/**
 * Shape check on `event.data` for an inbound `cc-bridge-ready` announcement —
 * exact match only, mirrors isAppErrorBeaconShape: `type` must be the exact
 * literal, `manifestVersion` must be a number, and no other keys are allowed.
 */
export function isCcBridgeReadyShape(data: unknown): data is CcBridgeReady {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => k !== 'type' && k !== 'manifestVersion')) return false;
  if (rec.type !== CC_BRIDGE_READY_TYPE) return false;
  if (typeof rec.manifestVersion !== 'number') return false;
  return true;
}

/**
 * Exact-shape check for an inbound `cc-capture-result` message. The success
 * and failure variants are exact-shape checked separately (each has its own
 * fixed key set: {type,requestId,ok,dataUrl} or {type,requestId,ok,error}) —
 * `ok` is a discriminant, not a generic boolean; a message with `ok: true`
 * but an `error` key instead of `dataUrl` (or vice versa) is rejected, not
 * coerced.
 */
export function isCcCaptureResultShape(data: unknown): data is CcCaptureResult {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (rec.type !== CC_CAPTURE_RESULT_TYPE) return false;
  if (typeof rec.requestId !== 'string' || rec.requestId.length === 0) return false;
  if (rec.ok === true) {
    return keys.length === 4 && typeof rec.dataUrl === 'string' && rec.dataUrl.length > 0;
  }
  if (rec.ok === false) {
    return keys.length === 4 && typeof rec.error === 'string';
  }
  return false;
}

/**
 * Source-identity check — the only trust discriminator available for an
 * opaque-origin (srcdoc sandbox) iframe. Mirrors isTrustedAppBeaconSource
 * exactly: `eventSource` must be reference-equal to the exact iframe
 * contentWindow the caller is tracking.
 */
export function isTrustedCcBridgeSource(eventSource: unknown, slotWindow: unknown): boolean {
  return eventSource != null && eventSource === slotWindow;
}

/**
 * Combined check for the cockpit's `message` listener: both the source
 * identity AND the exact shape must hold before a `cc-bridge-ready`
 * announcement is trusted. Deliberately takes no `origin` argument — see the
 * trust-model note above.
 */
export function isValidCcBridgeReady(eventSource: unknown, slotWindow: unknown, data: unknown): boolean {
  return isTrustedCcBridgeSource(eventSource, slotWindow) && isCcBridgeReadyShape(data);
}

/**
 * Combined check for an inbound `cc-capture-result`: same source-identity +
 * exact-shape discipline as `isValidCcBridgeReady`. Callers must additionally
 * check `data.requestId` against the specific request they are awaiting —
 * this function only proves the message is a genuine, well-formed capture
 * result from the tracked iframe, not that it answers any particular request
 * (a stale result from a prior, already-timed-out capture is still "valid"
 * by this check alone).
 */
export function isValidCcCaptureResult(eventSource: unknown, slotWindow: unknown, data: unknown): boolean {
  return isTrustedCcBridgeSource(eventSource, slotWindow) && isCcCaptureResultShape(data);
}

/**
 * Recursive shape+budget check for one outline node, called only after the
 * top-level envelope already matched. `budget` is a shared mutable counter
 * (closed over across the whole recursive walk, same "whole-tree, not
 * per-branch" discipline as the producer's own serializeCcDomOutline) so an
 * oversize tree is rejected outright — not silently truncated here, since
 * silently accepting a shorter tree than what was actually sent could mask
 * a producer-side bug the E1 acceptance criteria explicitly want caught.
 */
function isPlainOutlineNodeShape(
  data: unknown,
  depth: number,
  budget: { count: number },
): data is CcDomOutlineNode {
  if (depth > CC_DOM_OUTLINE_MAX_DEPTH) return false;
  budget.count += 1;
  if (budget.count > CC_DOM_OUTLINE_MAX_NODES) return false;
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => !OUTLINE_NODE_KEYS.has(k)) || keys.length !== OUTLINE_NODE_KEYS.size) return false;
  if (typeof rec.tag !== 'string') return false;
  if (rec.id !== null && typeof rec.id !== 'string') return false;
  if (rec.className !== null && typeof rec.className !== 'string') return false;
  if (rec.textPreview !== null && typeof rec.textPreview !== 'string') return false;
  if (typeof rec.childCount !== 'number') return false;
  if (!Array.isArray(rec.children)) return false;
  return rec.children.every((c) => isPlainOutlineNodeShape(c, depth + 1, budget));
}

const OUTLINE_NODE_KEYS = new Set(['tag', 'id', 'className', 'textPreview', 'childCount', 'children']);

/**
 * Exact-shape check for an inbound `cc-dom-outline-result`. `tree: null` is
 * a valid degrade case (the producer's own walk threw — see
 * postCcDomOutlineResult's try/catch); a non-null tree is walked recursively
 * against the same depth/node budget the producer itself enforces.
 */
export function isCcDomOutlineResultShape(data: unknown): data is CcDomOutlineResult {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => k !== 'type' && k !== 'tree' && k !== 'truncated')) return false;
  if (rec.type !== CC_DOM_OUTLINE_RESULT_TYPE) return false;
  if (typeof rec.truncated !== 'boolean') return false;
  if (rec.tree === null) return true;
  return isPlainOutlineNodeShape(rec.tree, 0, { count: 0 });
}

/**
 * Combined check for an inbound `cc-dom-outline-result`: same source-identity
 * + exact-shape discipline as `isValidCcCaptureResult`. No requestId to
 * additionally check (outline results aren't correlated — see
 * ccBridgeRuntime.tsx's E1 doc comment).
 */
export function isValidCcDomOutlineResult(eventSource: unknown, slotWindow: unknown, data: unknown): boolean {
  return isTrustedCcBridgeSource(eventSource, slotWindow) && isCcDomOutlineResultShape(data);
}

/**
 * Post a `cc-capture-request` down to a tracked iframe's contentWindow.
 * `requestId` is a caller-generated correlation id (StudioModal mints one
 * per Screenshot click) — REQUIRED, unlike props-set/props-reset's fire-and-
 * forget shape, because capture is a one-shot request/response with a 10s
 * timeout on the caller's side: without a requestId, a `cc-capture-result`
 * that arrives late (after the caller already gave up and re-enabled the
 * Screenshot button) could be misread as the answer to a brand-new,
 * unrelated capture request racing it. Outbound send from the cockpit (the
 * trusted party in this direction) — no shape/source validation applies
 * here, mirroring sendCcPropsSet/sendCcPropsReset.
 */
export function sendCcCaptureRequest(iframeWindow: Window, requestId: string): void {
  iframeWindow.postMessage({ type: CC_CAPTURE_REQUEST_TYPE, requestId }, '*');
}

/**
 * Post a `cc-dom-outline-request` down to a tracked iframe's contentWindow.
 * Outbound send from the cockpit (the trusted party in this direction) — no
 * shape/source validation applies here, mirroring sendCcCaptureRequest. No
 * requestId (unlike capture): see ccBridgeRuntime.tsx's E1 doc comment for
 * why outline results don't need correlation.
 */
export function sendCcDomOutlineRequest(iframeWindow: Window): void {
  iframeWindow.postMessage({ type: CC_DOM_OUTLINE_REQUEST_TYPE }, '*');
}

/**
 * Post a `cc-props-set` message down to a tracked iframe's contentWindow,
 * merging `props` into the artifact's live override state (see
 * ccBridgeRuntime.tsx's withCcBridge — same `key`, so React reconciles in
 * place and the wrapped component's own internal state survives). This is
 * an outbound SEND from the cockpit (the trusted party in this direction),
 * so no shape/source validation applies here — only the artifact's own
 * bridge runtime validates what it receives.
 */
export function sendCcPropsSet(iframeWindow: Window, props: Record<string, unknown>): void {
  iframeWindow.postMessage({ type: CC_PROPS_SET_TYPE, props }, '*');
}

/**
 * Post a `cc-props-reset` message: the artifact's bridge runtime clears all
 * prop overrides AND bumps its wrapper `key`, forcing a full remount that
 * also discards the wrapped component's own internal state — "reset to
 * defaults" means both, not just the props.
 */
export function sendCcPropsReset(iframeWindow: Window): void {
  iframeWindow.postMessage({ type: CC_PROPS_RESET_TYPE }, '*');
}
