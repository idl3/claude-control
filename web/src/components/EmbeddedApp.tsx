import { APP_FRAME_MAX_WIDTH } from '../lib/embeds';
import { resolveMediaUrl } from '../lib/mediaUrl';

/**
 * Renders one <embedded-app url="…" height="…" /> transcript block as a
 * sandboxed, isolated live iframe micro-app.
 *
 * url handling — STRICTER than EmbeddedMedia. Apps get real code execution
 * inside the transcript surface, so only local media-root content (operator-
 * trusted, same trust boundary as any other file under ~/.claude-control/media)
 * is allowed: bare/relative paths and urls already shaped like /api/media/…
 * (resolveMediaUrl's 'fetch' branch). http(s) urls — which EmbeddedMedia
 * allows straight through as a hotlinked <img src> — are REJECTED here too: a
 * remote iframe would run arbitrary third-party code inside the cockpit
 * origin's tab, an exfil/XSS surface media elements don't have. Every other
 * scheme, absolute path, or traversal segment is rejected the same as media.
 *
 * The HTML is fetched with authFetch (an <iframe src> can't send the bearer
 * header — the same reason EmbeddedMedia blob-fetches instead of using
 * <img src> directly for relative urls) and set via `srcDoc` on an
 * `sandbox="allow-scripts"` iframe. Deliberately NOT `allow-same-origin`:
 * srcdoc + sandbox WITHOUT allow-same-origin gives the iframe an opaque
 * (null) origin, so the embedded app cannot reach the parent DOM, the
 * cockpit's localStorage bearer token, or any cookie — even though its JS
 * runs. Do not add allow-same-origin here.
 *
 * Layout: like EmbeddedMedia, a reserved box (width capped, fixed height
 * from the `height` attr — already clamped by parseEmbedAppAttrs) is present
 * from mount so there is no scroll jump; a skeleton shimmer fills it until
 * the fetch resolves. A failed/non-ok fetch renders the same rejected-chip
 * treatment as an unsupported url.
 *
 * The live iframe itself does NOT live here. Transcript row DOM churns on
 * every message-list update (A2 churn-spike verdict — see
 * docs/plans/cockpit-pinned-artifacts/phase-a-tasks.md, A3), and a moved/
 * reparented iframe reloads by spec regardless of why it moved. This
 * component renders only a placeholder (a `data-embed-app-url`/
 * `data-embed-app-height` span, cheap to remount) that AppFrameLayer.tsx
 * tracks from a single always-mounted portal layer — the fetch, the
 * skeleton, and the failed-chip for fetch errors all happen there. The
 * rejected-url check stays here since it's synchronous and belongs inline
 * in the transcript flow, not floating in the hoisted layer.
 *
 * Phase C, C2: two optional props feed AppFrameLayer's multi-placeholder
 * host arbitration and always-mounted panel bodies —
 *  - `context` ('transcript' default): rides as `data-embed-app-context` so
 *    AppFrameLayer can pick a single deterministic host per url when the same
 *    app is embedded in both the transcript AND pinned into the panel
 *    (panel-context always wins — see AppFrameLayer's tick()).
 *  - `hidden` (false default): the panel renders EVERY open app artifact's
 *    placeholder simultaneously so tab switches never tear one down (that
 *    would reload the iframe), but only the ACTIVE tab's should actually be
 *    visible. Setting `hidden` applies `visibility: hidden` + disables
 *    pointer events on the placeholder itself — deliberately NOT
 *    `display: none`, which would collapse the rect to zero and trip
 *    AppFrameLayer's FIX-2 zero-rect eviction (see AppFrameLayer.tsx) — and
 *    rides as `data-embed-app-hidden="true"` so AppFrameLayer folds it into
 *    the same paneHidden (hide, never evict) treatment as a scrolled-out-of-
 *    pane placeholder.
 *
 * D2/D4: `trackLatest` (true default) rides as `data-embed-app-track-latest`
 * (only emitted when false, so the common case adds zero DOM weight).
 * AppFrameLayer's shouldReloadOnFrame gate reads it to decide whether a
 * `media-app-changed` WS frame should hot-reload this url's slot — the
 * mechanism is built entirely in D2 (unused, defaults true, everyone keeps
 * today's behavior); D4 is the first caller to ever pass `false`, from a
 * per-tab "pin to this version" choice (a pinned version must never get
 * silently replaced by a newer rebuild's frame).
 *
 * H2 (Codex review): `suspended` (false default) rides as
 * `data-embed-app-suspended="true"`. ArtifactAppStack renders a marker with
 * this prop set for a cap-suspended app INSTEAD of a live `context="panel"`
 * placeholder — it never fetches or hosts anything itself, it only tells
 * AppFrameLayer's host arbitration "this url is suspended in the panel right
 * now". AppFrameLayer bars hosting for a url entirely while ANY placeholder
 * for it carries this marker (see AppFrameLayer.tsx's tick()), which is the
 * fix for the bug where a suspended-past-cap app would silently fall back to
 * hosting its live iframe in a transcript placeholder instead — defeating the
 * live-frame cap. A transcript placeholder for the same url renders the
 * existing non-host "open in panel" chip, relabeled "suspended in panel".
 */
export function EmbeddedApp({
  url,
  height,
  context = 'transcript',
  hidden = false,
  trackLatest = true,
  suspended = false,
}: {
  url: string;
  height: number;
  context?: 'panel' | 'transcript';
  hidden?: boolean;
  trackLatest?: boolean;
  suspended?: boolean;
}) {
  const resolution = resolveMediaUrl(url);

  // resolveMediaUrl's 'direct' branch is media's allowance for http(s)
  // hotlinking — app embeds reject that branch too (see doc comment above),
  // not just 'rejected', so only 'fetch' (local media-root) proceeds.
  if (resolution.kind !== 'fetch') {
    return <code className="embed-media-rejected">app url rejected: {url}</code>;
  }

  // Panel context fills its slot exactly (ArtifactPanel/.artifact-app-slot
  // sizes the box); transcript context keeps the reserved-box width cap +
  // fixed height from the tag's `height` attr.
  const frameStyle =
    context === 'panel'
      ? { width: '100%', height: '100%' }
      : { width: '100%', maxWidth: APP_FRAME_MAX_WIDTH, height: `${height}px` };

  return (
    <span
      className="embed-media-frame embed-app-frame"
      style={{
        ...frameStyle,
        visibility: hidden ? 'hidden' : undefined,
        pointerEvents: hidden ? 'none' : undefined,
      }}
      data-embed-app-url={url}
      data-embed-app-height={height}
      data-embed-app-context={context}
      data-embed-app-hidden={hidden ? 'true' : undefined}
      data-embed-app-track-latest={trackLatest === false ? 'false' : undefined}
      data-embed-app-suspended={suspended ? 'true' : undefined}
      aria-label="embedded app"
    />
  );
}

function ReloadIcon() {
  return (
    <svg className="act-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 4v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M4.5 15a8 8 0 1 0 2-8.5L4 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Dispatches `cockpit:app-reload` — the same window-CustomEvent idiom as
 * cockpit:ack / cockpit:pending-retry (see Messages.tsx's
 * dispatchPendingAction) — carrying the app's url in `detail`.
 * AppFrameLayer.tsx owns the actual reload (re-fetch, srcdoc replace, iframe
 * remount); this button only ever signals intent, the same division of
 * labor as the pending-send Retry button.
 *
 * Rendered by AppFrameLayer, not by EmbeddedApp's in-flow placeholder above:
 * AppFrameLayer's hoisted portal layer paints on top of the placeholder at
 * the exact same screen position (see AppFrameLayer.tsx's module doc
 * comment), so a control placed on the placeholder itself would be visually
 * covered and unclickable. This file only owns the button's presentation;
 * AppFrameLayer composes it into the actually-visible frame.
 *
 * `quiet` (default) renders a small icon-only corner affordance meant to sit
 * unobtrusively over a healthy iframe; the crashed strip passes
 * `quiet={false}` for a labeled, primary "Reload" CTA.
 *
 * `style` (B audit follow-up, CP3-B, FIX 1): optional inline override for
 * the button's CSS `top`/`right` (styles.css .embed-app-reload-btn defaults
 * to 6px/6px). AppFrameLayer passes a clamped top/right — see
 * clampChromeInsets — so the button stays inside the visible slice of a
 * partially clip-pane-clipped placeholder instead of the un-clipped box.
 */
export function AppReloadButton({
  url,
  quiet = true,
  style,
}: {
  url: string;
  quiet?: boolean;
  style?: React.CSSProperties;
}) {
  const onClick = () => {
    window.dispatchEvent(new CustomEvent('cockpit:app-reload', { detail: { url } }));
  };
  return (
    <button
      type="button"
      className={`act-btn embed-app-reload-btn${quiet ? '' : ' embed-app-reload-btn-labeled'}`}
      aria-label="Reload app"
      onClick={onClick}
      style={style}
    >
      <ReloadIcon />
      {quiet ? null : 'Reload'}
    </button>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg className="act-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 21s7-7.58 7-12A7 7 0 1 0 5 9c0 4.42 7 12 7 12Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        fill={filled ? 'currentColor' : 'none'}
      />
    </svg>
  );
}

/**
 * Phase C, C3: "pin to panel" affordance — rendered by AppFrameLayer next to
 * AppReloadButton in every chrome state (healthy iframe corner, failed strip,
 * crashed strip), same presentation/composition split as AppReloadButton
 * above: this file owns only the button's look; AppFrameLayer owns the
 * action, since only it has both `useArtifactPanel()` and the slot's actual
 * reserved height.
 *
 * Deliberately NOT a toggle — clicking always calls `onClick` unconditionally,
 * which AppFrameLayer wires to `open({ ..., pinned: true })`. Pinning an
 * already-pinned app is a no-op-that-focuses (openReducer's re-open path
 * moves it to MRU-front + activates it — see ArtifactContext.tsx's
 * OpenArtifactInput doc comment), never a click-to-unpin. Unpinning only ever
 * happens from the panel side (tab close). `pinned` only drives the visual
 * (filled icon + aria-pressed) so the control still reads as a real toggle to
 * the user even though the click handler is one-directional.
 */
export function AppPinButton({
  pinned,
  onClick,
  quiet = true,
  style,
}: {
  pinned: boolean;
  onClick: () => void;
  quiet?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`act-btn embed-app-pin-btn${quiet ? '' : ' embed-app-pin-btn-labeled'}${
        pinned ? ' embed-app-pin-btn-active' : ''
      }`}
      aria-label={pinned ? 'Pinned to panel' : 'Pin to panel'}
      aria-pressed={pinned}
      onClick={onClick}
      style={style}
    >
      <PinIcon filled={pinned} />
      {quiet ? null : pinned ? 'Pinned' : 'Pin'}
    </button>
  );
}
