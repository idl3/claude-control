import { useCallback, useEffect, useRef, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import { appNameFromUrl, fetchAppManifest, type AppManifest, type AppManifestProp } from '../lib/appVersion';
import { mediaAppFramePath } from '../lib/mediaUrl';
import { setHotkeySuppressed } from '../lib/hotkeySuppression';
import {
  sendCcPropsSet,
  sendCcPropsReset,
  sendCcCaptureRequest,
  isValidCcBridgeReady,
  isValidCcCaptureResult,
  MAX_CC_CAPTURE_DATA_URL_LENGTH,
} from '../lib/appBridge';
import { saveCapture } from '../lib/api';
import { EmbeddedApp } from './EmbeddedApp';
import { StudioAnnotate, type StudioAnnotateHandle } from './StudioAnnotate';
import { StudioInspector } from './StudioInspector';

// Phase C, C3: coalesces rapid prop edits into one cc-props-set postMessage,
// per the ≤150ms acceptance budget.
const PROPS_DEBOUNCE_MS = 150;

// Studio Phase C CP3 audit, FIX 1: belt-and-suspenders fallback for the
// "already-hosted elsewhere" race — see the `bridgeReady` doc comment on
// StudioPropsPanel below for the two races this constant closes. Chosen
// comfortably above PROPS_DEBOUNCE_MS so the normal (fresh-open) path is
// always resolved by the real `cc-bridge-ready` message, not the fallback.
const BRIDGE_READY_FALLBACK_MS = 250;

/**
 * The live iframe hosting `url` is owned by AppFrameLayer (a hoisted portal,
 * keyed by url — see EmbeddedApp.tsx's doc comment), not by this panel, so
 * there is no ref to reach it directly. Every AppFrameLayer-hosted iframe
 * carries `title={url}` (StudioModal.vitest.ts's existing tests already rely
 * on this — `screen.findByTitle(url)`), which doubles as a stable, already-
 * established lookup key: cheaper and more surgical than threading a new
 * accessor prop/context through AppFrameLayer just for this one panel.
 */
export function findAppIframeWindow(url: string): Window | null {
  for (const el of document.querySelectorAll('iframe')) {
    if ((el as HTMLIFrameElement).title === url) return (el as HTMLIFrameElement).contentWindow;
  }
  return null;
}

/** Best-effort control-kind pick for one manifest prop — falls through to
 * raw-JSON-only for anything not in this small, high-confidence set (enums,
 * booleans, numbers, strings). Complex tsTypes (generics, function types —
 * see manifest.mjs's "un-inferable" degrade case) are never mis-rendered as
 * a text input; they get the raw-JSON editor only. */
function studioPropControlKind(prop: AppManifestProp): 'enum' | 'boolean' | 'number' | 'string' | 'raw' {
  if (prop.enumOptions && prop.enumOptions.length > 0) return 'enum';
  if (prop.tsType === 'boolean') return 'boolean';
  if (prop.tsType === 'number') return 'number';
  if (prop.tsType === 'string') return 'string';
  return 'raw';
}

function StudioPropField({
  prop,
  value,
  onChange,
  resetGeneration,
}: {
  prop: AppManifestProp;
  value: unknown;
  onChange: (v: unknown) => void;
  // Studio Phase C CP3 audit, FIX 2: bumped by StudioPropsPanel's reset() on
  // every "Reset to defaults" click. The raw-JSON textarea below is
  // uncontrolled (`defaultValue`, not `value`) so it can hold deliberately
  // invalid/unparseable text (see onRawChange's doc comment) — React only
  // re-evaluates `defaultValue` at mount, so a `values` reset to `{}` alone
  // reverts the live artifact but leaves stale text sitting in the
  // textarea. Folding this counter into the textarea's `key` forces exactly
  // that one element to remount on reset, without disturbing the field's
  // `rawMode` toggle state (which stays keyed by `prop.name` alone, via the
  // parent's `key={prop.name}` on the whole field).
  resetGeneration: number;
}) {
  const kind = studioPropControlKind(prop);
  const [rawMode, setRawMode] = useState(kind === 'raw');

  // Per-prop raw-JSON override (C3 acceptance: "invalid-value testing"):
  // deliberately does NOT require valid JSON. A parse failure forwards the
  // exact typed text as a raw string — an intentionally-wrong-typed value
  // (e.g. text typed into a `count: number` prop) is exactly the invalid
  // input this escape hatch exists to inject, so the artifact's OWN error
  // path (cc-app-error beacon -> AppFrameLayer's existing crash strip, see
  // lib/appBeacon.ts) can be exercised — never sanitized away here.
  const onRawChange = (text: string) => {
    try {
      onChange(JSON.parse(text));
    } catch {
      onChange(text);
    }
  };

  let control: React.ReactNode = null;
  if (!rawMode) {
    if (kind === 'enum') {
      const opts = prop.enumOptions ?? [];
      control = (
        <select
          aria-label={prop.name}
          value={typeof value === 'string' ? value : String(prop.example ?? prop.default ?? opts[0] ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    } else if (kind === 'boolean') {
      control = (
        <input
          type="checkbox"
          aria-label={prop.name}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      );
    } else if (kind === 'number') {
      control = (
        <input
          type="number"
          aria-label={prop.name}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    } else if (kind === 'string') {
      control = (
        <input
          type="text"
          aria-label={prop.name}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    }
  }

  return (
    <div className="studio-prop-field">
      <div className="studio-prop-label">
        <span className="studio-prop-name">
          {prop.name}
          {prop.required ? ' *' : ''}
        </span>
        <span className="studio-prop-type">{prop.tsType}</span>
        {prop.example !== undefined && (
          <button type="button" className="studio-prop-example-chip" onClick={() => onChange(prop.example)}>
            example: {String(prop.example)}
          </button>
        )}
      </div>
      {control ?? (
        <textarea
          key={resetGeneration}
          className="studio-prop-raw"
          aria-label={`${prop.name} raw JSON`}
          defaultValue={value === undefined ? '' : JSON.stringify(value)}
          onChange={(e) => onRawChange(e.target.value)}
        />
      )}
      {kind !== 'raw' && (
        <button type="button" className="studio-prop-raw-toggle" onClick={() => setRawMode((r) => !r)}>
          {rawMode ? 'typed' : 'raw'}
        </button>
      )}
    </div>
  );
}

/**
 * Phase C, C3: the Props panel. Always mounted alongside `.studio-frame`
 * (never a tab that unmounts the frame — that would tear down the
 * context="studio" EmbeddedApp placeholder and force an iframe reload,
 * defeating the whole point of live prop editing) so editing a prop can
 * never itself trigger the reload the acceptance criterion explicitly rules
 * out. Renders one of three states: loading (manifest fetch in flight),
 * degrade (no manifest — old, pre-rebuild artifact), or the generated form.
 */
function StudioPropsPanel({ url, manifest }: { url: string; manifest: AppManifest | null | undefined }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Studio Phase C CP3 audit, FIX 2: remount counter for the raw-JSON
  // textareas — see StudioPropField's `resetGeneration` doc comment.
  const [resetGeneration, setResetGeneration] = useState(0);

  // Studio Phase C CP3 audit, FIX 1: `cc-bridge-ready` (posted once by the
  // artifact's ccBridgeRuntime.tsx on ITS mount) previously had no cockpit-
  // side listener — isValidCcBridgeReady sat unused, and cc-props-set fired
  // on the blind PROPS_DEBOUNCE_MS debounce with no readiness gating, so a
  // props-set that landed before the artifact's OWN message listener effect
  // ran was silently dropped (postMessage has no delivery ack). `bridgeReady`
  // (state, drives the flush effect below) plus `bridgeReadyRef` (always-
  // current, read from inside the debounce timeout's closure so a stale
  // `bridgeReady` captured at commit()-creation time can never cause a
  // send that should've been queued, or vice versa) gate outbound sends.
  // `pendingPropsRef` coalesces to just the newest not-yet-sent commit —
  // props are idempotent full-sets, not deltas, so only the latest value
  // needs to survive being queued, never a history — and is flushed exactly
  // once when the gate opens.
  const [bridgeReady, setBridgeReadyState] = useState(false);
  const bridgeReadyRef = useRef(false);
  const pendingPropsRef = useRef<Record<string, unknown> | null>(null);
  const setBridgeReady = useCallback((v: boolean) => {
    bridgeReadyRef.current = v;
    setBridgeReadyState(v);
  }, []);

  // A newly (re)fetched manifest means a different app/version is open —
  // drop any in-progress edits from the previous one.
  useEffect(() => {
    setValues({});
  }, [manifest]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Handshake ordering guarantee. Two races, both closed here:
  //  1. Fresh-open race (the one FIX 1 exists for): the artifact's own
  //     message listener effect (ccBridgeRuntime.tsx) mounts after its
  //     ready-announce effect in the SAME synchronous effects pass, so by
  //     the time `cc-bridge-ready` is actually delivered (postMessage
  //     delivery is always a queued task, never synchronous) the artifact's
  //     listener is already live — this listener flips `bridgeReady` the
  //     moment a validated ready message from the CORRECT iframe window
  //     arrives, and the flush effect below sends whatever was queued.
  //  2. Already-hosted race: AppFrameLayer's pickHost arbitration (studio >
  //     panel > transcript) can hand this panel an iframe that was already
  //     open elsewhere and already announced ready before this listener (or
  //     even this panel) existed — no second announcement is coming.
  //     `BRIDGE_READY_FALLBACK_MS` (250ms, comfortably above
  //     PROPS_DEBOUNCE_MS's 150ms) is the belt-and-suspenders half: by the
  //     time it fires, the artifact's own listener is unconditionally live
  //     either way, so it's safe to stop gating and flush.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const win = findAppIframeWindow(url);
      if (!win) return;
      if (isValidCcBridgeReady(event.source, win, event.data)) {
        setBridgeReady(true);
      }
    }
    window.addEventListener('message', onMessage);
    const fallback = setTimeout(() => setBridgeReady(true), BRIDGE_READY_FALLBACK_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(fallback);
    };
  }, [url, setBridgeReady]);

  // Flushes the queued props exactly once when the gate opens. `bridgeReady`
  // only ever transitions false -> true once per panel instance (a new app
  // open remounts this whole component via StudioModal's `key={openUrl}`),
  // so this effect body runs at most once with a non-null pending value.
  useEffect(() => {
    if (!bridgeReady || pendingPropsRef.current === null) return;
    const win = findAppIframeWindow(url);
    if (win) sendCcPropsSet(win, pendingPropsRef.current);
    pendingPropsRef.current = null;
  }, [bridgeReady, url]);

  const commit = useCallback(
    (next: Record<string, unknown>) => {
      setValues(next);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        const win = findAppIframeWindow(url);
        if (!win) return;
        if (bridgeReadyRef.current) {
          sendCcPropsSet(win, next);
        } else {
          pendingPropsRef.current = next; // coalesce to newest
        }
      }, PROPS_DEBOUNCE_MS);
    },
    [url],
  );

  const reset = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pendingPropsRef.current = null; // a queued-but-unsent set must not outlive a reset
    setValues({});
    setResetGeneration((g) => g + 1);
    const win = findAppIframeWindow(url);
    // Ungated, unlike cc-props-set above: cc-props-reset returns the
    // artifact to ITS OWN default props, which is also the state it's
    // already in if the bridge listener isn't up yet — sending it early is
    // a safe no-op (nothing to actually reset), never a lost mutation the
    // way an arbitrary props-set would be, so it doesn't need to wait on
    // the same readiness gate.
    if (win) sendCcPropsReset(win);
  };

  if (manifest === undefined) {
    return <div className="studio-props-panel" aria-label="Props" />;
  }

  if (manifest === null) {
    const name = appNameFromUrl(url) ?? url;
    return (
      <div className="studio-props-panel studio-props-degrade" aria-label="Props">
        <p className="studio-props-degrade-msg">
          No prop manifest for this build — rebuild with a component entry to enable live prop editing.
        </p>
        <pre className="studio-props-degrade-cmd">
          {`node ~/.claude/skills/prototype-component/scripts/run.mjs \\\n  --write-app ${name} --html <built.html> --manifest <out.manifest.json>`}
        </pre>
      </div>
    );
  }

  return (
    <div className="studio-props-panel" aria-label="Props">
      <div className="studio-props-head">
        <span className="studio-props-title">Props</span>
        <button type="button" className="studio-props-reset" onClick={reset}>
          Reset to defaults
        </button>
      </div>
      {manifest.props.map((prop) => (
        <StudioPropField
          key={prop.name}
          prop={prop}
          value={values[prop.name]}
          onChange={(v) => commit({ ...values, [prop.name]: v })}
          resetGeneration={resetGeneration}
        />
      ))}
    </div>
  );
}

type SidePanelTab = 'props' | 'inspector';

/**
 * E1/E2: tab strip added atop StudioPropsPanel's existing permanently-
 * mounted, never-unmounted container (see that component's own doc comment
 * — hiding `.studio-frame` is the risk it guards against, not hiding its OWN
 * content). StudioPropsPanel and StudioInspector both stay mounted here
 * regardless of which tab is active, toggled via the native `hidden`
 * attribute rather than a conditional render, so switching tabs never resets
 * either panel's in-progress state (a pending prop edit, an already-fetched
 * outline) — same never-unmount discipline as `.studio-frame` itself, just
 * applied one level down. Console (E2) ships `disabled` — a "coming soon"
 * placeholder tab with no body to hide/show, since it can never become
 * active (see phase-e-tasks.md's E2 CP0 log for why live forwarding wasn't
 * shipped this phase).
 */
function StudioSidePanel({ url, manifest }: { url: string; manifest: AppManifest | null | undefined }) {
  const [tab, setTab] = useState<SidePanelTab>('props');
  return (
    <div className="studio-side-panel">
      <div className="studio-side-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'props'}
          className="studio-side-tab"
          onClick={() => setTab('props')}
        >
          Props
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'inspector'}
          className="studio-side-tab"
          onClick={() => setTab('inspector')}
        >
          Inspector
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={false}
          className="studio-side-tab studio-side-tab-disabled"
          disabled
          title="Console — coming soon"
        >
          Console
        </button>
      </div>
      <div className="studio-side-tab-body" hidden={tab !== 'props'}>
        <StudioPropsPanel url={url} manifest={manifest} />
      </div>
      <div className="studio-side-tab-body" hidden={tab !== 'inspector'}>
        <StudioInspector url={url} active={tab === 'inspector'} />
      </div>
    </div>
  );
}

const SUPPRESS_STORAGE_KEY = 'cockpit:studio-suppress-hotkeys';

const DEVICE_MODES = [
  { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { id: 'ipad', label: 'iPad', width: 768, height: 1024 },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
] as const;

type DeviceModeId = (typeof DEVICE_MODES)[number]['id'];

// Studio Phase B CP3 audit, FIX 3: `.studio-body` (styles.css) reserves
// 24px padding on every side (48px horizontal total) around `.studio-frame`,
// which itself carries a 1px border on every side (2px horizontal total) —
// 50px of chrome the device box's raw preset width doesn't account for. A
// mode used to enable the instant the window matched the RAW device width
// (useMinWidth(DEVICE_MODES[i].width)), so a window exactly at (or a few px
// above) a preset's width enabled that mode yet couldn't actually fit its
// device box without `.studio-body`'s own `overflow: auto` kicking in — a
// boundary-band horizontal scrollbar. Gating on `width + chrome` instead
// means "enabled" now genuinely implies "fits with no scrollbar."
const STUDIO_BODY_CHROME_WIDTH = 50;

/**
 * Same SSR-safe matchMedia idiom as `useIsNarrow` (hooks/useIsNarrow.ts),
 * generalized from a fixed max-width breakpoint to an arbitrary min-width —
 * reused three times below (once per device mode) instead of adding a
 * dynamic-count hook (which would violate rules-of-hooks).
 */
function useMinWidth(px: number): boolean {
  const query = `(min-width:${px}px)`;
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

const APP_VERSION_URL_RE = /^apps\/[a-z0-9-]+\/([^/]+)\.html$/;

/**
 * Derives a display version tag purely from the embed's url — no network
 * call, no dependency on the media-apps versions API. The versioned url
 * form ("apps/<name>/<stamp>[-label].html", see lib/appVersion.ts) carries
 * its stamp/label segment inline; the flat legacy form ("apps/<name>.html")
 * carries none, and always tracks whatever `latest` currently points at.
 */
function versionTagFromUrl(url: string): string {
  const normalized = mediaAppFramePath(url) ?? url;
  const m = APP_VERSION_URL_RE.exec(normalized);
  return m ? m[1] : 'latest';
}

// D1: client-side ceiling on how long a `cc-capture-request` waits for its
// matching `cc-capture-result` before the button re-enables with an error —
// bounds a wedged/crashed artifact (tainted canvas, an infinite render loop
// inside toPng's DOM walk, etc.) from leaving Screenshot stuck forever.
const CAPTURE_TIMEOUT_MS = 10_000;

type CaptureStage =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'error'; message: string }
  | { kind: 'review'; dataUrl: string }
  | { kind: 'saving' }
  | { kind: 'saved'; path: string };

/**
 * D1/D2/D3: Screenshot button + capture/annotate/save flow, mounted inside
 * `.studio-toolbar`. `requestIdRef` is the sole correlation key between a
 * Screenshot click and its eventual `cc-capture-result` (see
 * appBridge.ts's `sendCcCaptureRequest` doc comment) — a click while a prior
 * request is still outstanding mints a NEW requestId, so a stale result (or
 * a post-timeout late arrival) fails the `=== requestIdRef.current` check
 * below and is silently dropped rather than misapplied to the wrong request.
 */
function StudioCapture({ url, name }: { url: string; name: string }) {
  const [stage, setStage] = useState<CaptureStage>({ kind: 'idle' });
  const requestIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotateRef = useRef<StudioAnnotateHandle | null>(null);
  // Studio Phase D CP3 audit, FIX 1: StudioAnnotate's own imgReady, lifted
  // here so Save can be disabled/blocked while the received dataUrl hasn't
  // (yet, or ever) finished decoding — belt-and-suspenders against silently
  // exporting a blank canvas: StudioAnnotate.exportPng() ALSO throws while
  // its own imgReady is false, so this is the UI-affordance half, not the
  // only guard. Stable identities (useCallback, empty deps — setStage/
  // setAnnotateReady are useState setters, already stable) so passing these
  // as props never re-triggers StudioAnnotate's image-load effect.
  const [annotateReady, setAnnotateReady] = useState(false);
  const handleAnnotateReady = useCallback((ready: boolean) => setAnnotateReady(ready), []);
  const handleAnnotateError = useCallback(() => {
    setStage({ kind: 'error', message: 'capture image failed to decode' });
  }, []);

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => clearPendingTimeout, []);

  // The studio-context hoisted live-app iframe (AppFrameLayer.tsx's
  // STUDIO_HOIST_Z_INDEX = 310) unconditionally paints above .studio-overlay
  // so the live app stays interactive during normal Studio use — but that
  // same z-index also sits above .studio-capture-overlay (z-index: 1), which
  // silently swallows every pointer event meant for the annotation canvas
  // and Save/Cancel buttons during review/saving/saved. Toggling this body
  // class (same pattern as App.tsx's is-ipad/is-external-display) lets
  // styles.css neutralize the hoisted iframe only while the capture overlay
  // is actually showing, without touching AppFrameLayer's unconditional
  // normal-use behavior.
  useEffect(() => {
    const reviewing = stage.kind === 'review' || stage.kind === 'saving' || stage.kind === 'saved';
    document.body.classList.toggle('studio-capture-reviewing', reviewing);
    return () => document.body.classList.remove('studio-capture-reviewing');
  }, [stage.kind]);

  const startCapture = () => {
    const win = findAppIframeWindow(url);
    if (!win) {
      setStage({ kind: 'error', message: 'app iframe not found' });
      return;
    }
    const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    requestIdRef.current = requestId;
    setStage({ kind: 'capturing' });
    setAnnotateReady(false); // fresh capture cycle — Save stays blocked until the NEW image decodes
    sendCcCaptureRequest(win, requestId);
    clearPendingTimeout();
    timeoutRef.current = setTimeout(() => {
      // A result that already arrived clears requestIdRef in the message
      // listener below before this fires — that's the safe no-op half of
      // this race; this branch only fires for a genuinely still-outstanding
      // request.
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null;
        setStage({ kind: 'error', message: 'capture timed out' });
      }
    }, CAPTURE_TIMEOUT_MS);
  };

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!requestIdRef.current) return;
      const win = findAppIframeWindow(url);
      if (!isValidCcCaptureResult(event.source, win, event.data)) return;
      const data = event.data as { requestId: string; ok: boolean; dataUrl?: string; error?: string };
      if (data.requestId !== requestIdRef.current) return; // stale — answers a different (timed-out or superseded) request
      requestIdRef.current = null;
      clearPendingTimeout();
      if (data.ok && data.dataUrl) {
        // Studio Phase D CP3 audit, FIX 1: an oversize dataUrl is rejected
        // HERE, before ever reaching the review stage — not folded into
        // isCcCaptureResultShape (see that constant's doc comment for why:
        // this path surfaces the existing capture-failed error chip instead
        // of a silent drop).
        if (data.dataUrl.length > MAX_CC_CAPTURE_DATA_URL_LENGTH) {
          setStage({ kind: 'error', message: 'capture too large to review' });
        } else {
          setStage({ kind: 'review', dataUrl: data.dataUrl });
        }
      } else {
        setStage({ kind: 'error', message: data.error || 'capture failed' });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [url]);

  const save = async () => {
    // Studio Phase D CP3 audit, FIX 1: `!annotateReady` blocks Save the same
    // way the disabled button attribute does — a logic-level guard, not just
    // a UI affordance, since a synthetic/programmatic click can bypass
    // `disabled`. exportPng() is now called INSIDE the try below (it used to
    // sit before it, uncaught): StudioAnnotate.exportPng() itself throws
    // while its own imgReady is false, and an uncaught throw there used to
    // become an unhandled rejection instead of the error stage.
    if (stage.kind !== 'review' || !annotateReady) return;
    setStage({ kind: 'saving' });
    try {
      const exported = annotateRef.current ? await annotateRef.current.exportPng() : stage.dataUrl;
      const path = await saveCapture(name, exported);
      setStage({ kind: 'saved', path });
    } catch (err) {
      setStage({ kind: 'error', message: err instanceof Error ? err.message : 'save failed' });
    }
  };

  const copyTag = (path: string) => {
    navigator.clipboard?.writeText(`<embedded-image url="${path}" />`).catch(() => {});
  };

  return (
    <div className="studio-capture-controls">
      <button
        type="button"
        className="studio-capture-btn"
        onClick={startCapture}
        disabled={stage.kind === 'capturing'}
      >
        {stage.kind === 'capturing' ? 'Capturing…' : 'Screenshot'}
      </button>
      {stage.kind === 'error' && (
        <span className="studio-capture-error-chip" role="alert">
          {stage.message}
          <button type="button" onClick={() => setStage({ kind: 'idle' })} aria-label="dismiss capture error">
            ✕
          </button>
        </span>
      )}
      {(stage.kind === 'review' || stage.kind === 'saving' || stage.kind === 'saved') && (
        <div className="studio-capture-overlay">
          {stage.kind === 'review' && (
            <div className="studio-capture-review">
              <StudioAnnotate
                ref={annotateRef}
                imageDataUrl={stage.dataUrl}
                onReady={handleAnnotateReady}
                onError={handleAnnotateError}
              />
              <div className="studio-capture-actions">
                <button type="button" onClick={() => setStage({ kind: 'idle' })}>
                  Cancel
                </button>
                <button type="button" onClick={save} disabled={!annotateReady}>
                  Save
                </button>
              </div>
            </div>
          )}
          {stage.kind === 'saving' && <div className="studio-capture-saving">Saving…</div>}
          {stage.kind === 'saved' && (
            <div className="studio-capture-saved">
              <code className="studio-capture-tag">{`<embedded-image url="${stage.path}" />`}</code>
              <div className="studio-capture-actions">
                <button type="button" onClick={() => copyTag(stage.path)}>
                  Copy
                </button>
                <button type="button" onClick={() => setStage({ kind: 'idle' })}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StudioPanel({ url, onClose: rawClose }: { url: string; onClose: () => void }) {
  const { rootRef, requestClose } = useModalTransition(rawClose);
  // T4 fail-safe: release suppression EAGERLY at close-request time, not via
  // unmount cleanup alone — unmount is gated behind the close animation's
  // GSAP onComplete, and a safety invariant must never depend on a decorative
  // animation callback firing (CP3-A HIGH). The unmount cleanup below stays
  // as the second line of defense.
  const onClose = () => {
    setHotkeySuppressed(false);
    requestClose();
  };
  const name = appNameFromUrl(url) ?? url;
  const versionTag = versionTagFromUrl(url);

  // C3: undefined = loading, null = no manifest (degrade path), object = form.
  const [manifest, setManifest] = useState<AppManifest | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setManifest(undefined);
    fetchAppManifest(url).then((m) => {
      if (!cancelled) setManifest(m);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Studio Phase B CP3 audit, FIX 3: gate on the device width PLUS
  // `.studio-body`'s own chrome width (see STUDIO_BODY_CHROME_WIDTH), not
  // the raw device width alone — see that constant's doc comment.
  const mobileEnabled = useMinWidth(DEVICE_MODES[0].width + STUDIO_BODY_CHROME_WIDTH);
  const ipadEnabled = useMinWidth(DEVICE_MODES[1].width + STUDIO_BODY_CHROME_WIDTH);
  const desktopEnabled = useMinWidth(DEVICE_MODES[2].width + STUDIO_BODY_CHROME_WIDTH);
  const enabledById: Record<DeviceModeId, boolean> = {
    mobile: mobileEnabled,
    ipad: ipadEnabled,
    desktop: desktopEnabled,
  };

  // Default to the largest enabled mode at open time; users can switch freely
  // among whatever stays enabled afterward (a resize disabling the current
  // mode just greys its button out — acceptance doesn't require auto-switch).
  const [mode, setMode] = useState<DeviceModeId>(() =>
    enabledById.desktop ? 'desktop' : enabledById.ipad ? 'ipad' : 'mobile',
  );
  const device = DEVICE_MODES.find((d) => d.id === mode) ?? DEVICE_MODES[0];

  // Suppression toggle: defaults ON the first time the studio is ever opened
  // in this tab session; after that it remembers the user's last choice
  // (sessionStorage) across opens. Independent of that persisted preference,
  // the LIVE global flag (A3's hotkeySuppression store) is unconditionally
  // forced back to OFF when this panel unmounts (effect cleanup below) — the
  // rest of the app's hotkeys must never stay suppressed after the studio
  // closes, no matter what the toggle was left on.
  const [suppressOn, setSuppressOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.sessionStorage.getItem(SUPPRESS_STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  });

  useEffect(() => {
    setHotkeySuppressed(suppressOn);
  }, [suppressOn]);

  useEffect(() => {
    return () => setHotkeySuppressed(false);
  }, []);

  // Escape closes the studio. This reaches the listener even while
  // suppression is ON: A3's interceptor carves Escape out of
  // isSuppressedCombo unconditionally (see hotkeySuppression.ts), precisely
  // so this composition works — the studio's own close key is never a
  // casualty of its own hotkey-suppression feature.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleSuppress = () => {
    const next = !suppressOn;
    setSuppressOn(next);
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(SUPPRESS_STORAGE_KEY, String(next));
    }
  };

  return (
    <div className="studio-overlay" ref={rootRef} role="presentation">
      <div className="studio-panel" role="dialog" aria-modal="true" aria-label={`${name} studio`}>
        <div className="studio-head">
          <div className="studio-title-group">
            <span className="studio-title">{name}</span>
            <span className="studio-version">{versionTag}</span>
          </div>
          <button type="button" className="studio-close" aria-label="Close studio" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="studio-toolbar">
          <StudioCapture url={url} name={name} />
          <label className="studio-suppress-toggle">
            <input type="checkbox" checked={suppressOn} onChange={toggleSuppress} />
            Disable cockpit hotkeys
          </label>
          <div className="studio-device-bar">
            {DEVICE_MODES.map((d) => {
              const enabled = enabledById[d.id];
              return (
                <button
                  key={d.id}
                  type="button"
                  className="studio-device-btn"
                  aria-pressed={mode === d.id}
                  disabled={!enabled}
                  title={enabled ? undefined : 'screen too small'}
                  onClick={() => enabled && setMode(d.id)}
                >
                  {d.label} {d.width}
                </button>
              );
            })}
          </div>
        </div>

        <div className="studio-body">
          {/* B1: a context='studio' EmbeddedApp placeholder — same
              cheap-to-remount span AppFrameLayer already tracks for
              transcript/panel placeholders of this url. It never creates or
              moves an iframe itself; it just tells AppFrameLayer's host
              arbitration (pickHost: studio > panel > transcript) that the
              studio wants to host `url` while this panel is open. The
              `.studio-frame` box below stays the device-sized reservation
              from Phase A (B2 sizes it per device mode) — EmbeddedApp fills
              it at 100%/100% (studio context, same treatment as panel). */}
          <div className="studio-frame" style={{ width: device.width, height: device.height }}>
            <EmbeddedApp url={url} height={device.height} context="studio" />
          </div>
          <StudioSidePanel url={url} manifest={manifest} />
        </div>
      </div>
    </div>
  );
}

/**
 * A4: self-mounting studio shell. Listens for `cockpit:studio-open` directly
 * (same window-CustomEvent idiom as `cockpit:app-reload` — see
 * EmbeddedApp.tsx's AppFullscreenButton doc comment), so it needs no
 * provider/context and can be mounted once, unconditionally, from App.tsx's
 * AppChrome — independent of ArtifactPanel/AppFrameLayer (both off-limits
 * this phase). Renders nothing until an open event arrives.
 */
export function StudioModal() {
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const url = (e as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      // Studio Phase B CP3 audit, FIX 4: `<StudioPanel key={openUrl} ...>`
      // below keys the panel by its url, so an unconditional `setOpenUrl(url)`
      // for a SECOND app opened while a first app's studio is already open
      // force-unmounts the first StudioPanel outright (React tears down and
      // remounts on a key change) — bypassing useModalTransition's exit tween
      // entirely, a visible jump-cut instead of the studio's normal close
      // animation. Ignoring the second open (ignore-until-closed) is the
      // smallest guard that avoids the jump-cut: the user sees the current
      // app's studio uninterrupted, closes it via the regular path (full exit
      // tween), and can reopen for the new app afterward — this keeps the
      // existing one-studio-at-a-time model (`openUrl` is a single value, not
      // a stack) intact rather than adding a pending-url queue plus wiring a
      // second, deferred open into StudioPanel's own onClose/exit-complete
      // callback to auto-chain the swap, which would add real state machinery
      // for what's a rare double-open edge case. The functional-update form
      // (`prev`) is required, not incidental: this effect's dependency array
      // is `[]` (the listener is attached exactly once), so a plain
      // `openUrl` reference in this closure would always read the STALE
      // value from the initial render (always null) — `prev` always reflects
      // the actual current state at update time regardless of when onOpen
      // fires relative to this effect's single mount.
      setOpenUrl((prev) => (prev && prev !== url ? prev : url));
    };
    window.addEventListener('cockpit:studio-open', onOpen);
    return () => window.removeEventListener('cockpit:studio-open', onOpen);
  }, []);

  if (openUrl === null) return null;
  return <StudioPanel key={openUrl} url={openUrl} onClose={() => setOpenUrl(null)} />;
}
