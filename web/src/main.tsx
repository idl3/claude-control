import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportClientError } from './lib/reportError';
import 'slot-text/style.css';
import './styles.css';
import './highlight-theme.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

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
