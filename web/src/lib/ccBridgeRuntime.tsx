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
// Reserved, not yet handled (future phases): cc-capture-request,
// cc-dom-outline-request, cc-console-entry.

import { useEffect, useState, type ComponentType } from 'react';

export const CC_BRIDGE_READY_TYPE = 'cc-bridge-ready';
export const CC_PROPS_SET_TYPE = 'cc-props-set';
export const CC_PROPS_RESET_TYPE = 'cc-props-reset';

export type CcPropsSetMessage = { type: typeof CC_PROPS_SET_TYPE; props: Record<string, unknown> };
export type CcPropsResetMessage = { type: typeof CC_PROPS_RESET_TYPE };

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

/**
 * Source-identity check — the iframe's own side of the boundary: the only
 * trusted sender of props-set/props-reset is window.parent.
 */
export function isTrustedCcBridgeParent(eventSource: unknown, parentWindow: unknown): boolean {
  return eventSource != null && eventSource === parentWindow;
}

export type CcBridgeInboundMessage = { kind: 'set'; props: Record<string, unknown> } | { kind: 'reset' };

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
  return null;
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
        } else {
          setOverrides({});
          setResetKey((k) => k + 1);
        }
      }
      window.addEventListener('message', onMessage);
      return () => window.removeEventListener('message', onMessage);
    }, []);

    return <RootComponent key={resetKey} {...exampleProps} {...overrides} />;
  };
}
