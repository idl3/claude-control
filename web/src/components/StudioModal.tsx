import { useEffect, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import { appNameFromUrl } from '../lib/appVersion';
import { mediaAppFramePath } from '../lib/mediaUrl';
import { setHotkeySuppressed } from '../lib/hotkeySuppression';

const SUPPRESS_STORAGE_KEY = 'cockpit:studio-suppress-hotkeys';

const DEVICE_MODES = [
  { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { id: 'ipad', label: 'iPad', width: 768, height: 1024 },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800 },
] as const;

type DeviceModeId = (typeof DEVICE_MODES)[number]['id'];

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

  const mobileEnabled = useMinWidth(DEVICE_MODES[0].width);
  const ipadEnabled = useMinWidth(DEVICE_MODES[1].width);
  const desktopEnabled = useMinWidth(DEVICE_MODES[2].width);
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
          {/* Phase B moves real component hosting in here; Phase A only
              reserves the exact device-sized box so the layout is stable
              ahead of time. No iframe is created or moved by opening or
              closing the studio — whatever's hosting `url` today (see
              AppFrameLayer.tsx) is untouched. */}
          <div className="studio-frame" style={{ width: device.width, height: device.height }}>
            component hosting arrives in Phase B
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
      if (url) setOpenUrl(url);
    };
    window.addEventListener('cockpit:studio-open', onOpen);
    return () => window.removeEventListener('cockpit:studio-open', onOpen);
  }, []);

  if (openUrl === null) return null;
  return <StudioPanel key={openUrl} url={openUrl} onClose={() => setOpenUrl(null)} />;
}
