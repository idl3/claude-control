import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportClientError } from './lib/reportError';
import { isNativeShell } from './lib/nativeShell';
import { computeScreenH } from './lib/screenHeight';
import 'slot-text/style.css';
import './styles.css';
import './highlight-theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

// Desktop shell (Tauri, titleBarStyle: Overlay): flag the document before first
// paint so shell-only CSS (traffic-light clearance on the HUD) applies without
// a flash of the browser layout.
if (isNativeShell) document.documentElement.dataset.nativeShell = 'true';

// iOS installed-PWA (standalone) viewport fix. Measured on an iOS 26 sim: in an
// installed PWA (display-mode: standalone, black-translucent, viewport-fit=cover)
// EVERY viewport unit under-reports — 100dvh / 100vh / 100% / window.innerHeight /
// visualViewport.height ALL equal screen-height minus the status-bar (793 of 852 on
// an iPhone 15 Pro), so a .app sized with any of them leaves a ~59px dead band of
// background below the footer. window.screen.width/height are the only values equal
// to the FULL physical screen, but they are ORIENTATION-BLIND on iOS/iPadOS —
// window.screen.height stays pinned to the device's native/portrait height in BOTH
// orientations. On an iPhone (portrait-locked by the manifest) that's harmless. On
// an iPad, which supports landscape, reading it raw pins .app to the taller portrait
// height even in landscape, shoving the composer and the sidebar rail-footer off the
// bottom of the (shorter) landscape viewport. computeScreenH derives the correct
// dimension for the CURRENT orientation from the screen's own two measurements
// instead of trusting whichever one the platform labels "height". We fill the full
// screen ONLY in standalone (Safari, where the units are correct and track the
// browser chrome, keeps the dvh behavior — no pwa-fill class). See styles.css
// `html.pwa-fill`.
(function fillStandaloneViewport() {
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (window.navigator as { standalone?: boolean }).standalone === true;
  if (!standalone) return;
  const setScreenH = () => {
    const { width, height } = window.screen;
    const landscape = window.matchMedia('(orientation: landscape)').matches;
    document.documentElement.style.setProperty(
      '--screen-h',
      `${computeScreenH(width, height, landscape)}px`,
    );
  };
  setScreenH();
  document.documentElement.classList.add('pwa-fill');
  window.addEventListener('resize', setScreenH);
  window.addEventListener('orientationchange', setScreenH);
})();

// Catch crashes OUTSIDE React's render path too (async handlers, event callbacks,
// module init) — these never hit an ErrorBoundary but still break the app. Ship
// them to the same server sink so every crash is logged + traceable.
window.addEventListener('error', (e) => {
  reportClientError({
    source: 'window.onerror',
    message: e.message || String(e.error ?? 'unknown error'),
    stack: e.error?.stack,
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason as { message?: string; stack?: string } | undefined;
  reportClientError({
    source: 'unhandledrejection',
    message: String(reason?.message ?? reason ?? 'unhandled rejection'),
    stack: reason?.stack,
  });
});

// Clear the app's persisted UI state (cc: / cc_ keys) and reload — recovery for a
// crash caused by poisoned localStorage. Preserves the auth token so the user
// isn't logged out.
function clearCachedStateAndReload(): void {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k === 'claude-control.token') continue;
      if (k.startsWith('cc:') || k.startsWith('cc_')) localStorage.removeItem(k);
    }
  } catch {
    /* ignore storage access errors */
  }
  location.reload();
}

// ROOT firewall (fullscreen: safe-area-padded + centered so it isn't clipped under
// the mobile notch): without this, ANY throw above the in-app boundaries (the rail,
// a context provider, useCockpit, the app shell) unmounts the whole tree → a blank
// black screen. This shows the actual error + stack instead, with Retry + recovery.
//
// StrictMode intentionally OMITTED: @assistant-ui/react's runtime keys off a
// `devStrictMode` flag and does its own mount/unmount simulation when StrictMode is
// present — which double-unmounts one of its internal fibers ("Tried to unmount a
// fiber that is already unmounted"). Dropping StrictMode removes that trigger; it
// only added dev-time double-invoke checks, so there's no production downside.
createRoot(root).render(
  <ErrorBoundary
    fullscreen
    label="claude-control failed to load"
    onHardReset={clearCachedStateAndReload}
  >
    <App />
  </ErrorBoundary>,
);
