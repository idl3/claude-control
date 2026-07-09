// Validates `message` events an embedded app iframe may post up to the host
// to report an in-app crash — see AppFrameLayer.tsx's `message` listener.
// Pure, DOM-free helpers (same precedent as computePaneClip in
// AppFrameLayer.tsx) so they're unit-testable without a real window/iframe.
//
// Trust model: `event.origin` is the literal string 'null' for a
// sandbox="allow-scripts" (no allow-same-origin) srcdoc iframe — an opaque
// origin that carries no information, so it is NOT consulted here at all.
// `event.source` (the iframe's own contentWindow, as observed by the parent)
// is the only thing that distinguishes a genuine beacon from a same-page
// script or an unrelated window also posting to the parent, so
// isTrustedAppBeaconSource is checked in addition to, never instead of, the
// shape check below.

export const APP_ERROR_BEACON_TYPE = 'cc-app-error';

export type AppErrorBeacon = { type: typeof APP_ERROR_BEACON_TYPE; message?: string };

/**
 * Shape check on `event.data` — exact match only. `type` must be the exact
 * literal, `message` (if present) must be a string, and no other keys are
 * allowed: a payload carrying extra/unexpected fields is rejected rather
 * than silently accepted, so an accidental shape drift on the emitting side
 * fails loud instead of quietly widening what counts as a trusted beacon.
 */
export function isAppErrorBeaconShape(data: unknown): data is AppErrorBeacon {
  if (typeof data !== 'object' || data === null) return false;
  const rec = data as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.some((k) => k !== 'type' && k !== 'message')) return false;
  if (rec.type !== APP_ERROR_BEACON_TYPE) return false;
  if ('message' in rec && typeof rec.message !== 'string') return false;
  return true;
}

/**
 * Source-identity check — the only trust discriminator available for an
 * opaque-origin (srcdoc sandbox) iframe. `eventSource` must be reference-
 * equal to the exact iframe contentWindow the slot is tracking; a same-shape
 * message posted from any other window (a same-page script, a different
 * tab, an unrelated iframe) is rejected even though the shape check above
 * would pass it.
 */
export function isTrustedAppBeaconSource(eventSource: unknown, slotWindow: unknown): boolean {
  return eventSource != null && eventSource === slotWindow;
}

/**
 * Combined check AppFrameLayer's `message` listener runs against every
 * tracked slot: both the source identity AND the exact shape must hold
 * before a slot is marked crashed. Deliberately takes no `origin` argument —
 * see the trust-model note above.
 */
export function isValidAppErrorBeacon(eventSource: unknown, slotWindow: unknown, data: unknown): boolean {
  return isTrustedAppBeaconSource(eventSource, slotWindow) && isAppErrorBeaconShape(data);
}
