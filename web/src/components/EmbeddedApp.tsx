import { useEffect, useState } from 'react';
import type { EmbedAppWidth } from '../lib/embeds';
import { resolveMediaUrl } from '../lib/mediaUrl';
import { loadAppSize, type AppSize } from '../lib/appSize';
import { GalleryIcon } from './icons';

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
 *    (panel-context always wins — see AppFrameLayer's tick()). Phase B, B1
 *    adds a third value, 'studio' — StudioModal renders one of these for the
 *    currently-open url, and it outranks panel too (studio > panel >
 *    transcript, see AppFrameLayer's pickHost) while the studio stays open.
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
 *
 * Wide/medium presentation embeds (`<embedded-app width="wide"|"medium">`,
 * lib/embeds.ts parseEmbedAppAttrs — the create-artifact skill's html/react
 * lanes emit these for slide decks / webpages / dashboards): `width`
 * ('default' default) adds an `embed-app-frame--wide` or
 * `embed-app-frame--medium` modifier class to the placeholder below.
 * styles.css widens the reserved box to `min(90%, 1400px)` (wide) or
 * `min(70%, 1100px)` (medium) of the transcript column on desktop/iPad
 * (`@media (min-width: 720px)`) only — mobile keeps today's 640px cap
 * unchanged. AppFrameLayer needs no update for this: it sizes the hoisted
 * iframe from the placeholder's own `getBoundingClientRect()` (see
 * AppFrameLayer.tsx's `tick()`/`syncPositions()`), so a wider CSS box
 * auto-widens the iframe with zero changes there. Ignored in effect for
 * panel/studio contexts — `.artifact-app-slot .embed-app-frame` already
 * overrides both the default and wide/medium max-width via higher selector
 * specificity, so those always fill their slot exactly regardless of this
 * prop's value.
 *
 * Resizable transcript embeds: AppFrameLayer renders a drag handle
 * (AppResizeHandle below) on the hoisted chrome that writes the new box size
 * directly onto THIS component's placeholder DOM node (same direct-DOM-write
 * idiom as AppFrameLayer's syncPositions()) and dispatches
 * `cockpit:app-resize` `{url, width, height}` on window. This component
 * listens for that event (transcript context only) so its own React-owned
 * `style` follows the same size on the next render — otherwise a later
 * re-render here would stomp the direct DOM write back to the tag's fixed
 * `height`/100% width (placeholder-follows-hoist invariant: the reserved box
 * and the hoisted iframe must never visually disagree). The persisted size
 * (lib/appSize.ts, localStorage-backed) is read once on mount so a resized
 * embed reopens at its last size instead of flashing at the default and then
 * jumping. A manual size also clears the CSS `max-width` cap inline (see
 * frameStyle below) — otherwise styles.css's default/wide/medium max-width
 * would silently reclamp a drag that grew past it.
 */
export function EmbeddedApp({
  url,
  height,
  context = 'transcript',
  hidden = false,
  trackLatest = true,
  suspended = false,
  width = 'default',
  logicalWidth,
  logicalHeight,
}: {
  url: string;
  height: number;
  context?: 'panel' | 'transcript' | 'studio';
  hidden?: boolean;
  trackLatest?: boolean;
  suspended?: boolean;
  width?: EmbedAppWidth;
  /**
   * Mobile-UX fix #3: when set (StudioModal scaling a device preset down to
   * fit), the TRUE device-viewport dims the app iframe should see — distinct
   * from the SCALED footprint this placeholder's own frame occupies in
   * layout. AppFrameLayer reads these via the `data-embed-app-logical-*`
   * attrs below to size the hoisted iframe to the logical dims and compose
   * the display scale into its transform, so the app always renders at its
   * real viewport and paints scaled to fit (DevTools device-mode style).
   * Undefined (the default, every non-scaling caller) means "no scaling" —
   * AppFrameLayer's hoist geometry falls back to the placeholder's own rect,
   * byte-for-byte the pre-existing behavior.
   */
  logicalWidth?: number;
  logicalHeight?: number;
}) {
  const resolution = resolveMediaUrl(url);

  // Persisted drag-resize size (transcript embeds only — panel/studio always
  // fill their slot). Read once on mount, then kept live by the
  // cockpit:app-resize listener below so this placeholder always matches
  // whatever AppFrameLayer just wrote directly onto its DOM node.
  const [size, setSize] = useState<AppSize | null>(() => (context === 'transcript' ? loadAppSize(url) : null));
  useEffect(() => {
    if (context !== 'transcript') return;
    setSize(loadAppSize(url));
    function onResize(ev: Event) {
      const detail = (ev as CustomEvent<{ url: string; width: number; height: number }>).detail;
      if (!detail || detail.url !== url) return;
      setSize({ width: detail.width, height: detail.height });
    }
    window.addEventListener('cockpit:app-resize', onResize);
    return () => window.removeEventListener('cockpit:app-resize', onResize);
  }, [context, url]);

  // resolveMediaUrl's 'direct' branch is media's allowance for http(s)
  // hotlinking — app embeds reject that branch too (see doc comment above),
  // not just 'rejected', so only 'fetch' (local media-root) proceeds.
  if (resolution.kind !== 'fetch') {
    return <code className="embed-media-rejected">app url rejected: {url}</code>;
  }

  // Panel and studio contexts both fill their slot exactly (ArtifactPanel/
  // .artifact-app-slot sizes the panel box; StudioModal's .studio-frame sizes
  // the device-preset box — see B2) instead of the transcript's reserved-box
  // width cap + fixed height from the tag's `height` attr.
  // maxWidth is CSS-owned now (styles.css .embed-app-frame / --wide/--medium),
  // so the modifier classes' media-query override isn't fighting a
  // higher-precedence inline style — see the width doc comment above. A
  // manual resize (`size` set) overrides both: explicit px width/height plus
  // maxWidth:'none', since the CSS max-width would otherwise silently
  // reclamp a drag that grew past the default/wide/medium cap.
  const frameStyle =
    context === 'panel' || context === 'studio'
      ? { width: '100%', height: '100%' }
      : size
        ? { width: `${size.width}px`, height: `${size.height}px`, maxWidth: 'none' }
        : { width: '100%', height: `${height}px` };
  const widthClass = width === 'wide' ? ' embed-app-frame--wide' : width === 'medium' ? ' embed-app-frame--medium' : '';

  return (
    <span
      className={`embed-media-frame embed-app-frame${widthClass}`}
      style={{
        ...frameStyle,
        visibility: hidden ? 'hidden' : undefined,
        pointerEvents: hidden ? 'none' : undefined,
      }}
      data-embed-app-url={url}
      data-embed-app-height={height}
      data-embed-app-context={context}
      data-embed-app-width={width !== 'default' ? width : undefined}
      data-embed-app-hidden={hidden ? 'true' : undefined}
      data-embed-app-track-latest={trackLatest === false ? 'false' : undefined}
      data-embed-app-suspended={suspended ? 'true' : undefined}
      data-embed-app-logical-width={logicalWidth != null ? logicalWidth : undefined}
      data-embed-app-logical-height={logicalHeight != null ? logicalHeight : undefined}
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

/**
 * Phase C, C3 (A2: relabeled "Pin to panel" -> "Open in panel"; className
 * tokens kept as-is since AppFrameLayer.tsx positions by them): "pin to
 * panel" affordance — rendered by AppFrameLayer next to
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
 *
 * Icon: reuses GalleryIcon (icons.tsx) — the same "layers" glyph as the
 * header's artifacts toggle — so this button visually reads as "send to the
 * artifacts gallery" rather than a generic pin. className tokens are
 * unchanged (embed-app-pin-btn*); only the glyph swapped.
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
      aria-label={pinned ? 'Opened in panel' : 'Open in panel'}
      aria-pressed={pinned}
      onClick={onClick}
      style={style}
    >
      <GalleryIcon className="act-ico" />
      {quiet ? null : pinned ? 'Opened' : 'Open'}
    </button>
  );
}

function FullscreenIcon() {
  return (
    <svg className="act-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H4v4M16 3h4v4M8 21H4v-4M16 21h4v-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A4: dispatches `cockpit:studio-open` — same window-CustomEvent idiom as
 * `cockpit:app-reload` above (AppReloadButton's doc comment) — carrying the
 * app's url in `detail`. StudioModal.tsx owns the actual studio (derives
 * name/version from the url, renders the fullscreen overlay); this button
 * only ever signals intent.
 *
 * BOUNDARY NOTE: like AppReloadButton/AppPinButton, this file owns only the
 * button's presentation — composing it into the actually-visible hoisted
 * chrome (next to the Reload/Pin buttons, in all three chrome states) is
 * AppFrameLayer.tsx's job (it is the sole caller of AppReloadButton/
 * AppPinButton). Phase B, B1 wires this in: AppFrameLayer now imports and
 * renders it alongside AppReloadButton/AppPinButton in every chrome state.
 */
export function AppFullscreenButton({
  url,
  quiet = true,
  style,
}: {
  url: string;
  quiet?: boolean;
  style?: React.CSSProperties;
}) {
  const onClick = () => {
    window.dispatchEvent(new CustomEvent('cockpit:studio-open', { detail: { url } }));
  };
  return (
    <button
      type="button"
      className={`act-btn embed-app-fullscreen-btn${quiet ? '' : ' embed-app-fullscreen-btn-labeled'}`}
      aria-label="Open in studio"
      onClick={onClick}
      style={style}
    >
      <FullscreenIcon />
      {quiet ? null : 'Fullscreen'}
    </button>
  );
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  // lucide's maximize-2 / minimize-2 pair (diagonal corner arrows) —
  // deliberately distinct from FullscreenIcon's static corner brackets above
  // so the two adjacent buttons don't read as duplicates of each other (this
  // one covers the transcript in place; AppFullscreenButton opens Studio).
  return expanded ? (
    <svg className="act-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 3H3v6M21 15v6h-6M15 9l6-6M3 21l6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg className="act-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Task 1: "cover the transcript" fullscreen — a SEPARATE control from
 * AppFullscreenButton above. AppFullscreenButton dispatches
 * `cockpit:studio-open`, handing the app off to StudioModal (a distinct
 * device-preset-aware surface, own routing/back-stack). This button instead
 * toggles AppFrameLayer's own `expandedRef` set for this url in place: the
 * SAME hoisted iframe (never remounted — never-reload seam) gets
 * re-positioned to cover the full viewport (AppFrameLayer's render +
 * syncPositions() source the rect from viewportRect() instead of the
 * placeholder while expanded) rather than being handed to another component.
 * Escape exits, same as this button toggled again. Do not conflate the two —
 * see AppFrameLayer.tsx's module doc comment and the PR description.
 *
 * Same presentation/composition split as AppPinButton: this file owns only
 * the button's look; AppFrameLayer owns `expandedRef` and the toggle
 * function, since only it has access to that ref.
 */
export function AppExpandButton({
  expanded,
  onClick,
  quiet = true,
  style,
}: {
  expanded: boolean;
  onClick: () => void;
  quiet?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className={`act-btn embed-app-expand-btn${quiet ? '' : ' embed-app-expand-btn-labeled'}${
        expanded ? ' embed-app-expand-btn-active' : ''
      }`}
      aria-label={expanded ? 'Exit fullscreen' : 'Enter fullscreen'}
      aria-pressed={expanded}
      onClick={onClick}
      style={style}
    >
      <ExpandIcon expanded={expanded} />
      {quiet ? null : expanded ? 'Exit fullscreen' : 'Fullscreen'}
    </button>
  );
}

/**
 * Task 1: drag-to-resize grip for a transcript embed's reserved box.
 * Presentation only — `onPointerDown` is wired by AppFrameLayer (the only
 * component with access to the placeholder's DOM node via `slot.hostEl`) to
 * begin a pointer-capture drag that writes width/height directly onto the
 * placeholder, dispatches `cockpit:app-resize` on every frame, and persists
 * the final size (lib/appSize.ts) on pointerup. Not rendered for panel/studio
 * contexts (those always fill their slot) or while a slot is expanded
 * (fullscreen ignores the placeholder's box entirely).
 */
export function AppResizeHandle({
  onPointerDown,
  style,
}: {
  onPointerDown: (ev: React.PointerEvent<HTMLSpanElement>) => void;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="embed-app-resize-handle"
      role="presentation"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      style={style}
    />
  );
}
