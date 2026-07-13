import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useModalTransition, prefersReducedMotion } from '../lib/anim';
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
import {
  CameraIcon,
  SmartphoneIcon,
  TabletIcon,
  MonitorIcon,
  XIcon,
  CheckIcon,
  EllipsisIcon,
  GripHandleIcon,
  BracesIcon,
} from './icons';

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

// Graphite Inspector redesign, Finding 4/segmented-control spec: a small enum
// (≤ this many options) renders as an inline segmented control — the
// Storybook "radio-for-small-enums" pattern — rather than a native <select>,
// which is reserved for enums with MORE options (a segmented row of 6+ chips
// would wrap and out-clutter a dropdown). `size:"sm"|"md"|"lg"` (3) segments;
// a 5+-option enum stays a <select>.
const ENUM_SEGMENTED_MAX = 4;

// Graphite Inspector, Finding 2 (color-aware string fields): a string prop
// whose current value or manifest example parses as a CSS color gets a live
// swatch inset on the right of its input. Deliberately conservative — only
// the unambiguous machine-color forms (hex, rg[b]/hsl[a]/oklch/oklab/lab/lch
// functions) — so an ordinary string like "Sunset" never sprouts a swatch.
const CSS_COLOR_RE = /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\()/i;
function asCssColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return CSS_COLOR_RE.test(trimmed) ? trimmed : null;
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

  const opts = prop.enumOptions ?? [];
  const enumSegmented = kind === 'enum' && opts.length > 0 && opts.length <= ENUM_SEGMENTED_MAX;

  let control: React.ReactNode = null;
  if (!rawMode) {
    if (kind === 'enum') {
      const current = typeof value === 'string' ? value : String(prop.example ?? prop.default ?? opts[0] ?? '');
      control = enumSegmented ? (
        // Segmented control — buttons keep aria-label={prop.name} on the group
        // so a11y/tests still address it by prop name (same identity a <select>
        // carried), with aria-pressed marking the active option.
        <div className="studio-segmented studio-prop-segmented" role="group" aria-label={prop.name}>
          {opts.map((o) => (
            <button
              key={o}
              type="button"
              className="studio-segment"
              aria-pressed={current === o}
              onClick={() => onChange(o)}
            >
              {o}
            </button>
          ))}
        </div>
      ) : (
        <select
          className="studio-prop-control"
          aria-label={prop.name}
          value={current}
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
      const on = Boolean(value);
      control = (
        <button
          type="button"
          className="studio-prop-switch"
          role="switch"
          aria-checked={on}
          aria-label={prop.name}
          onClick={() => onChange(!on)}
        >
          <span className="studio-prop-switch-track" aria-hidden="true">
            <span className="studio-prop-switch-thumb" />
          </span>
          <span className="studio-prop-switch-label">{on ? 'true' : 'false'}</span>
        </button>
      );
    } else if (kind === 'number') {
      control = (
        <input
          type="number"
          className="studio-prop-control"
          aria-label={prop.name}
          placeholder={prop.example !== undefined ? String(prop.example) : undefined}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    } else if (kind === 'string') {
      const swatch = asCssColor(value) ?? asCssColor(prop.example);
      control = (
        <div className={`studio-prop-input-wrap${swatch ? ' has-swatch' : ''}`}>
          <input
            type="text"
            className="studio-prop-control"
            aria-label={prop.name}
            placeholder={prop.example !== undefined ? String(prop.example) : undefined}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
          {swatch && (
            <span className="studio-prop-swatch" style={{ background: swatch }} aria-hidden="true" />
          )}
        </div>
      );
    }
  }

  const showExample =
    prop.example !== undefined && kind !== 'raw' && kind !== 'boolean' && !(kind === 'enum' && enumSegmented);

  return (
    <div className="studio-prop-field">
      <div className="studio-prop-label">
        <span className="studio-prop-name">
          {prop.name}
          {prop.required && (
            <span className="studio-prop-required" title="required" aria-label="required">
              *
            </span>
          )}
        </span>
        <span className="studio-prop-label-meta">
          <span className="studio-prop-type">{prop.tsType}</span>
          {kind !== 'raw' && (
            <button
              type="button"
              className="studio-prop-raw-toggle"
              aria-label="Edit as JSON"
              aria-pressed={rawMode}
              title="Edit as JSON"
              onClick={() => setRawMode((r) => !r)}
            >
              <BracesIcon className="studio-tool-ico" />
            </button>
          )}
        </span>
      </div>
      <div className="studio-prop-control-row">
        {control ?? (
          <textarea
            key={resetGeneration}
            className="studio-prop-raw"
            aria-label={`${prop.name} raw JSON`}
            defaultValue={value === undefined ? '' : JSON.stringify(value)}
            onChange={(e) => onRawChange(e.target.value)}
          />
        )}
      </div>
      {showExample && (
        <button
          type="button"
          className="studio-prop-example"
          onClick={() => onChange(prop.example)}
          title={`Use example: ${String(prop.example)}`}
        >
          Use example
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
type StudioPropsHandle = { reset: () => void };

const StudioPropsPanel = forwardRef<StudioPropsHandle, { url: string; manifest: AppManifest | null | undefined }>(
  function StudioPropsPanel({ url, manifest }, ref) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Studio Phase C CP3 audit, FIX 2: remount counter for the raw-JSON
  // textareas — see StudioPropField's `resetGeneration` doc comment.
  const [resetGeneration, setResetGeneration] = useState(0);
  // Studio Phase E polish, F15: "Copied" affordance for the degrade-path
  // rebuild command. Declared up here with the other hooks (not inside the
  // `manifest === null` conditional branch below) to obey rules-of-hooks.
  const [cmdCopied, setCmdCopied] = useState(false);

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

  // Finding 9: the "Reset to defaults" control now lives in the sheet/dock
  // header (StudioSidePanel), one level up — this panel exposes its reset()
  // so that header button can drive it without lifting all the props state up
  // (which would also drag the never-unmount discipline and the bridge/queue
  // machinery out of here). aria-label on the header button stays "Reset to
  // defaults" so its accessible identity is unchanged.
  useImperativeHandle(ref, () => ({ reset }));

  if (manifest === undefined) {
    return (
      <div className="studio-props-panel studio-props-loading" aria-label="Props">
        <div className="thread-skeleton" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="thread-skeleton-row">
              <span className="thread-skeleton-bar" style={{ width: '40%' }} />
              <span className="thread-skeleton-bar" style={{ width: '85%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (manifest === null) {
    const name = appNameFromUrl(url) ?? url;
    const cmd = `node ~/.claude/skills/prototype-component/scripts/run.mjs \\\n  --write-app ${name} --html <built.html> --manifest <out.manifest.json>`;
    return (
      <div className="studio-props-panel studio-props-degrade" aria-label="Props">
        <p className="studio-props-degrade-msg">
          No prop manifest for this build — rebuild with a component entry to enable live prop editing.
        </p>
        <pre className="studio-props-degrade-cmd">{cmd}</pre>
        <button
          type="button"
          className="studio-props-degrade-copy"
          data-copied={cmdCopied ? '' : undefined}
          onClick={() => {
            navigator.clipboard
              ?.writeText(cmd)
              .then(() => {
                setCmdCopied(true);
                setTimeout(() => setCmdCopied(false), 1500);
              })
              .catch(() => {});
          }}
        >
          {cmdCopied ? 'Copied' : 'Copy command'}
        </button>
      </div>
    );
  }

  return (
    <div className="studio-props-panel" aria-label="Props">
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
});

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
/**
 * Graphite Inspector redesign — the Props/Inspector dock. ONE always-mounted
 * tree serves both layouts (never a second render branch that would remount
 * `.studio-frame` or tear down a panel body):
 *   - Desktop (wide / fine pointer): a docked right-hand column, `data-expanded`
 *     is inert, the grip is `display:none` (styles.css).
 *   - Mobile (narrow / coarse pointer): a bottom SHEET — `position:absolute`,
 *     `transform:translateY(...)`-slid over the stage, peeking its header when
 *     collapsed and rising to ~72vh when expanded. Expansion is pure CSS off
 *     `data-expanded`; the container and every body inside it stay mounted, so
 *     sliding the sheet never reloads the hosted iframe (same discipline as
 *     `.studio-frame`). Props/Inspector still toggle via `hidden`, never a
 *     conditional render.
 * The Reset control (Finding 9) rides in this header now, driving
 * StudioPropsPanel via an imperative `reset()` ref.
 */
function StudioSidePanel({ url, manifest }: { url: string; manifest: AppManifest | null | undefined }) {
  const [tab, setTab] = useState<SidePanelTab>('props');
  const [expanded, setExpanded] = useState(false);
  const propsRef = useRef<StudioPropsHandle | null>(null);
  const propCount = manifest && typeof manifest === 'object' ? manifest.props.length : null;

  // Refinement #4 (mobile polish pass): a single sliding underline — instead
  // of each tab carrying its own static `border-bottom-color` — replaces the
  // Props/Inspector active indicator so switching tabs animates a slide
  // rather than an instant color swap. `offsetLeft`/`offsetWidth` (not
  // `getBoundingClientRect`, which one existing vitest test globally mocks
  // to a fixed rect) measured against `.studio-side-tabs`'s own
  // `position: relative` give the underline's target box; the CSS side
  // (styles.css `.studio-tab-underline`) turns that into one
  // `transform: translateX() scaleX()` off a 1px base, so nothing here ever
  // animates `left`/`width` (layout-triggering, banned by the perf rules).
  const propsTabBtnRef = useRef<HTMLButtonElement | null>(null);
  const inspectorTabBtnRef = useRef<HTMLButtonElement | null>(null);
  const [underline, setUnderline] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const el = tab === 'props' ? propsTabBtnRef.current : inspectorTabBtnRef.current;
      if (el) setUnderline({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    // Re-measure on resize too (e.g. orientation change while the sheet is
    // open) — same SSR-safe listener idiom as useViewportWidth below.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tab, propCount]);

  // Never-reload seam: on mobile the expanded sheet is an overlay that covers
  // the device-frame rect, but the studio-context hosted iframe paints at
  // z-index 310 (AppFrameLayer's STUDIO_HOIST_Z_INDEX) — above the overlay —
  // so it would punch through the sheet's fields. Same fix as StudioCapture's
  // review overlay: toggle a body class that drops the hoist below the overlay
  // WHILE the sheet is expanded (the rule is scoped to the mobile layout in
  // styles.css, so the desktop docked panel — where `expanded` is inert and
  // there's no overlap — keeps the live app fully visible). Never unmounts the
  // frame; only its paint order changes, so no iframe reload.
  useEffect(() => {
    document.body.classList.toggle('studio-sheet-open', expanded);
    return () => document.body.classList.remove('studio-sheet-open');
  }, [expanded]);

  // Studio Phase E polish, F13: roving tabindex across the two REAL tabs
  // (Console never receives focus via arrows — it's `disabled` and has no
  // panel). Shared by both real tab buttons below. Selecting a tab also opens
  // the sheet (a no-op on desktop where `expanded` is inert).
  const selectTab = (next: SidePanelTab) => {
    setTab(next);
    setExpanded(true);
  };
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tab === 'props' ? 'inspector' : 'props';
    selectTab(next);
    requestAnimationFrame(() => document.getElementById(`studio-tab-${next}`)?.focus());
  };

  return (
    <div className="studio-side-panel" data-expanded={expanded ? 'true' : 'false'}>
      <button
        type="button"
        className="studio-sheet-grip"
        aria-label={expanded ? 'Collapse props sheet' : 'Expand props sheet'}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <GripHandleIcon className="studio-sheet-grip-ico" />
      </button>
      <div className="studio-side-head">
        <div className="studio-side-tabs" role="tablist">
          <button
            ref={propsTabBtnRef}
            type="button"
            role="tab"
            id="studio-tab-props"
            aria-selected={tab === 'props'}
            aria-controls="studio-tabpanel-props"
            tabIndex={tab === 'props' ? 0 : -1}
            className="studio-side-tab"
            onClick={() => selectTab('props')}
            onKeyDown={onTabKeyDown}
          >
            Props
            {propCount !== null && propCount > 0 && (
              <span className="studio-side-tab-count" aria-hidden="true">
                {propCount}
              </span>
            )}
          </button>
          <button
            ref={inspectorTabBtnRef}
            type="button"
            role="tab"
            id="studio-tab-inspector"
            aria-selected={tab === 'inspector'}
            aria-controls="studio-tabpanel-inspector"
            tabIndex={tab === 'inspector' ? 0 : -1}
            className="studio-side-tab"
            onClick={() => selectTab('inspector')}
            onKeyDown={onTabKeyDown}
          >
            Inspector
          </button>
          <button
            type="button"
            role="tab"
            id="studio-tab-console"
            aria-selected={false}
            tabIndex={-1}
            className="studio-side-tab studio-side-tab-disabled"
            disabled
            title="Console — coming soon"
          >
            Console
            <span className="studio-side-tab-soon" aria-hidden="true">
              soon
            </span>
          </button>
          <span
            className="studio-tab-underline"
            aria-hidden="true"
            style={{ transform: `translateX(${underline.x}px) scaleX(${underline.w})` }}
          />
        </div>
        <button
          type="button"
          className="studio-props-reset"
          aria-label="Reset to defaults"
          hidden={tab !== 'props'}
          onClick={() => propsRef.current?.reset()}
        >
          Reset
        </button>
      </div>
      <div
        className="studio-side-tab-body"
        role="tabpanel"
        id="studio-tabpanel-props"
        aria-labelledby="studio-tab-props"
        hidden={tab !== 'props'}
      >
        <StudioPropsPanel ref={propsRef} url={url} manifest={manifest} />
      </div>
      <div
        className="studio-side-tab-body"
        role="tabpanel"
        id="studio-tabpanel-inspector"
        aria-labelledby="studio-tab-inspector"
        hidden={tab !== 'inspector'}
      >
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

const DEVICE_MODE_ICONS: Record<DeviceModeId, typeof SmartphoneIcon> = {
  mobile: SmartphoneIcon,
  ipad: TabletIcon,
  desktop: MonitorIcon,
};

// Studio Phase B CP3 audit, FIX 3: `.studio-body` (styles.css) reserves
// 24px padding on every side (48px horizontal total) around `.studio-frame`,
// which itself carries a 1px border on every side (2px horizontal total) —
// 50px of chrome the device box's raw preset width doesn't account for.
//
// Studio Phase E polish, F2: the original 50px only accounted for
// `.studio-body`'s padding+border — it never counted the 320px
// `.studio-side-panel` flex-basis or the 20px `.studio-body` gap that sits
// between the frame and that panel, both of which also eat into the
// available width whenever the side panel is visible (i.e. always — it's
// permanently mounted, see StudioSidePanel's doc comment). 50 + 320 + 20 =
// 390.
//
// Mobile-UX fix #3: every preset is now always selectable — a device box
// that can't fit at 1:1 scales down to fit instead of the button disabling
// (see `studioFitScale`/`studioAvailableWidth` below). This constant no
// longer GATES which modes are reachable; it now (a) picks the *default*
// mode at open time (the largest preset that fits at scale 1, via
// `fitsById`) and (b) is the row-mode (side panel visible) available-width
// denominator that `studioAvailableWidth` uses to compute the fit scale.
// Column mode (side panel stacks below `.studio-frame`, narrow viewports —
// see the `@media (max-width:640px)` block in styles.css) uses
// `STUDIO_BODY_COLUMN_PADDING` instead, since the 320px side-panel width
// doesn't apply there.
const STUDIO_BODY_CHROME_WIDTH = 390;

// Mobile-UX fix #3: column-mode (side panel stacked, not side-by-side)
// available-width denominator — just `.studio-body`'s own padding+border,
// no side-panel width to subtract.
const STUDIO_BODY_COLUMN_PADDING = 24;

/**
 * Pure: the scale factor (≤1) that fits a `logicalWidth × logicalHeight` device
 * preset inside an `availableWidth × availableHeight` box, on BOTH axes
 * (Finding 1 — the width-only predecessor let a tall preset overflow the stage
 * vertically and paint off-screen). `min(1, availW/lw, availH/lh)`: the tighter
 * constraint wins, and it never upscales a preset that already fits.
 *
 * `availableHeight === Infinity` recovers the exact old width-only behavior —
 * the component passes Infinity as the height bound whenever it cannot measure
 * the live stage (SSR / jsdom, which has no ResizeObserver), so a real browser
 * fits on both axes while headless unit tests stay deterministic on width.
 */
export function studioFitScale(
  logicalWidth: number,
  logicalHeight: number,
  availableWidth: number,
  availableHeight: number,
): number {
  if (logicalWidth <= 0 || logicalHeight <= 0 || availableWidth <= 0 || availableHeight <= 0) return 1;
  return Math.min(1, availableWidth / logicalWidth, availableHeight / logicalHeight);
}

/** Pure: the width `.studio-frame` has to work with, minus whichever chrome applies for the current layout mode. */
export function studioAvailableWidth(innerWidth: number, columnMode: boolean): number {
  return Math.max(0, innerWidth - (columnMode ? STUDIO_BODY_COLUMN_PADDING : STUDIO_BODY_CHROME_WIDTH));
}

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

/**
 * Mobile-UX fix #3: raw `window.innerWidth`, tracked via a resize listener —
 * `useMinWidth` above answers yes/no boundary questions (matchMedia), but the
 * scale-to-fit computation needs the actual number to divide by.
 */
function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
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
        <CameraIcon className="studio-tool-ico" />
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
                  <XIcon className="studio-tool-ico" />
                  Cancel
                </button>
                <button type="button" className="studio-capture-save" onClick={save} disabled={!annotateReady}>
                  <CheckIcon className="studio-tool-ico" />
                  Save
                </button>
              </div>
            </div>
          )}
          {stage.kind === 'saving' && (
            <div className="studio-capture-saving">
              <span className="thread-loading-spinner" aria-hidden="true" /> Saving…
            </div>
          )}
          {stage.kind === 'saved' && (
            <div className="studio-capture-saved">
              <div className="studio-capture-saved-head">
                <span aria-hidden="true">✓</span> Saved
              </div>
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

  // Studio Phase B CP3 audit, FIX 3 (superseded by mobile-UX fix #3 below):
  // whether each preset fits at 1:1 scale — gates the DEFAULT mode choice
  // only now, not which modes are reachable (every preset is always
  // selectable; a mode that doesn't fit scales down instead — see `scale`
  // below).
  const mobileFits = useMinWidth(DEVICE_MODES[0].width + STUDIO_BODY_CHROME_WIDTH);
  const ipadFits = useMinWidth(DEVICE_MODES[1].width + STUDIO_BODY_CHROME_WIDTH);
  const desktopFits = useMinWidth(DEVICE_MODES[2].width + STUDIO_BODY_CHROME_WIDTH);
  const fitsById: Record<DeviceModeId, boolean> = {
    mobile: mobileFits,
    ipad: ipadFits,
    desktop: desktopFits,
  };

  // Default to the largest mode that fits at open time; users can switch
  // freely to any preset afterward — one that doesn't fit at 1:1 scales down
  // instead of disabling (mobile-UX fix #3).
  const [mode, setMode] = useState<DeviceModeId>(() =>
    fitsById.desktop ? 'desktop' : fitsById.ipad ? 'ipad' : 'mobile',
  );
  const device = DEVICE_MODES.find((d) => d.id === mode) ?? DEVICE_MODES[0];

  // Mobile-UX fix #3: DevTools-device-mode-style scale-to-fit. `.studio-body`
  // stacks the side panel below `.studio-frame` under the same breakpoint
  // (styles.css `@media (max-width:640px)`) that drives the rest of the
  // studio's column layout — `columnMode` mirrors that breakpoint so the
  // available-width denominator matches whichever chrome is actually in
  // play. `scale` never exceeds 1 (never upscale a preset that already
  // fits); `footprintW/H` is what `.studio-frame` actually reserves in
  // layout — the scaled-down footprint when scaling, the raw preset size
  // otherwise (byte-for-byte the old behavior in that case).
  const viewportW = useViewportWidth();
  const columnMode = !useMinWidth(641);

  // Finding 1: both-axis fit. The stage's true inner box (content rect —
  // excludes its padding and, on mobile, the reserved sheet-peek strip) is
  // measured live via ResizeObserver so the whole device fits and centers
  // regardless of safe-area insets, chrome height, or the sheet peek. When
  // measurement isn't available (SSR / jsdom has no ResizeObserver), width
  // falls back to the existing viewport arithmetic and height to Infinity —
  // exactly the pre-redesign width-only behavior, keeping unit tests
  // deterministic (a real browser always measures).
  const stageFitRef = useRef<HTMLDivElement | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = stageFitRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr && cr.width > 0 && cr.height > 0) setStageSize({ w: cr.width, h: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Findings 3/10: the "Disable cockpit hotkeys" toggle (and any future
  // secondary studio option) is demoted off the toolbar into a `⋯` overflow
  // popover in the head, recovering the toolbar to a single dense row. The
  // popover content is always mounted and toggled via `hidden` (never a
  // conditional render), so the hotkeys checkbox keeps a stable DOM identity.
  const [menuOpen, setMenuOpen] = useState(false);

  const availableW = stageSize?.w ?? studioAvailableWidth(viewportW, columnMode);
  const availableH = stageSize?.h ?? Number.POSITIVE_INFINITY;
  const scale = studioFitScale(device.width, device.height, availableW, availableH);
  const scaling = scale < 1;
  const footprintW = scaling ? Math.floor(device.width * scale) : device.width;
  const footprintH = scaling ? Math.floor(device.height * scale) : device.height;
  const scalePct = Math.round(scale * 100);

  // Studio Phase E polish, F9: cross-fades `.studio-frame` on a device-mode
  // switch via the Web Animations API (transform/opacity only — never a raw
  // width tween, which would fight the layout-driven resize) instead of a
  // hard cut. `frameRef` never gets a `key` — this must never remount the
  // frame, which would tear down EmbeddedApp's placeholder and force an
  // iframe reload. `frameFirstRef` skips the animation on first mount (only
  // a mode CHANGE should animate, not the initial render).
  const frameRef = useRef<HTMLDivElement | null>(null);
  const frameFirstRef = useRef(true);
  useEffect(() => {
    if (frameFirstRef.current) {
      frameFirstRef.current = false;
      return;
    }
    const el = frameRef.current;
    if (!el || prefersReducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { opacity: 0.4, transform: 'scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [mode]);

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

  // Studio Phase E polish, F13: roving tabindex + arrow traversal across the
  // device bar. Mobile-UX fix #3: every preset is reachable now (a mode that
  // doesn't fit at 1:1 scales down instead of disabling), so `enabledIds` is
  // simply all modes, not filtered by `fitsById`.
  const onDeviceKeyDown = (e: React.KeyboardEvent, currentId: DeviceModeId) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const enabledIds = DEVICE_MODES.map((d) => d.id);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const at = enabledIds.indexOf(currentId);
    const from = at === -1 ? 0 : at;
    const nextId = enabledIds[(from + dir + enabledIds.length) % enabledIds.length];
    setMode(nextId);
    requestAnimationFrame(() => document.getElementById(`studio-device-${nextId}`)?.focus());
  };

  return (
    <div className="studio-overlay" ref={rootRef} role="presentation">
      <div className="studio-panel" role="dialog" aria-modal="true" aria-label={`${name} studio`}>
        <div className="studio-head">
          <div className="studio-title-group">
            <span className="studio-title">{name}</span>
            <span className="studio-version">{versionTag}</span>
          </div>
          <div className="studio-head-actions">
            <div className="studio-overflow">
              <button
                type="button"
                className="studio-icon-btn studio-overflow-btn"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <EllipsisIcon className="studio-tool-ico" />
              </button>
              <div className="studio-overflow-menu" role="menu" hidden={!menuOpen}>
                <label className="studio-suppress-toggle" role="menuitemcheckbox" aria-checked={suppressOn}>
                  <input type="checkbox" checked={suppressOn} onChange={toggleSuppress} />
                  Disable cockpit hotkeys
                </label>
              </div>
            </div>
            <button
              type="button"
              className="studio-icon-btn studio-close"
              aria-label="Close studio"
              onClick={onClose}
            >
              <XIcon className="studio-tool-ico" />
            </button>
          </div>
        </div>

        <div className="studio-toolbar">
          <div className="studio-segmented studio-device-segmented" role="group" aria-label="Device size">
            {DEVICE_MODES.map((d) => {
              const Icon = DEVICE_MODE_ICONS[d.id];
              return (
                <button
                  key={d.id}
                  id={`studio-device-${d.id}`}
                  type="button"
                  className="studio-segment studio-device-segment"
                  aria-pressed={mode === d.id}
                  aria-label={`${d.label} ${d.width}`}
                  title={fitsById[d.id] ? undefined : `${d.label} ${d.width} — scaled to fit`}
                  tabIndex={mode === d.id ? 0 : -1}
                  onKeyDown={(e) => onDeviceKeyDown(e, d.id)}
                  onClick={() => setMode(d.id)}
                >
                  <Icon className="studio-tool-ico" />
                  <span className="studio-btn-label">{d.label}</span>
                </button>
              );
            })}
          </div>
          <div className="studio-toolbar-right">
            {/* Finding 12: persistent scale readout. Lives in the toolbar (not
                over the stage) because the studio-context hosted iframe paints
                at z-index 310 — above the overlay (300) — so any chip inside
                the stage would be occluded wherever the device rect sits. */}
            {scaling && (
              <span
                className="studio-scale-chip"
                title={`${device.label} · ${device.width}×${device.height} — scaled to fit`}
              >
                {scalePct}%
                <span className="studio-scale-dims">
                  · {device.width}×{device.height}
                </span>
              </span>
            )}
            <StudioCapture url={url} name={name} />
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
          <div className="studio-stage">
            <div className="studio-stage-fit" ref={stageFitRef}>
              <div className="studio-frame" ref={frameRef} style={{ width: footprintW, height: footprintH }}>
                <EmbeddedApp
                  url={url}
                  height={device.height}
                  context="studio"
                  logicalWidth={scaling ? device.width : undefined}
                  logicalHeight={scaling ? device.height : undefined}
                />
              </div>
            </div>
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
