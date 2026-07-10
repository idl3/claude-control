import { useEffect, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import { appNameFromUrl } from '../lib/appVersion';
import { mediaAppFramePath } from '../lib/mediaUrl';
import { setHotkeySuppressed } from '../lib/hotkeySuppression';
import { EmbeddedApp } from './EmbeddedApp';

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
