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

export type CcBridgeReady = { type: typeof CC_BRIDGE_READY_TYPE; manifestVersion: number };

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
