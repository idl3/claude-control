import { useEffect, useState } from 'react';
import { getVersion, triggerUpdate } from '../lib/api';

const DISMISS_KEY = 'claude-control-update-dismissed';

/**
 * Dismissible "update available" banner with a one-press in-place update.
 * Polls /api/version on mount; shows when npm has a newer `claude-control` than
 * the running build. "Update now" POSTs /api/update — the server pulls,
 * rebuilds, and restarts itself; the page reconnects automatically. Dismissal
 * is remembered per-version so it never nags for the same release.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<{ current: string; latest: string } | null>(
    null,
  );
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let alive = true;
    getVersion().then((v) => {
      if (!alive || !v?.updateAvailable || !v.latest) return;
      if (localStorage.getItem(DISMISS_KEY) === v.latest) return;
      setInfo({ current: v.current, latest: v.latest });
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  if (updating) {
    return (
      <div className="update-banner" role="status">
        <span>Updating to v{info.latest}… the page will reconnect shortly.</span>
      </div>
    );
  }

  return (
    <div className="update-banner" role="status">
      <span>
        Update available — <b>v{info.latest}</b> (you’re on v{info.current}).
      </span>
      <span className="update-actions">
        <button
          type="button"
          className="update-now"
          onClick={() => {
            setUpdating(true);
            void triggerUpdate();
          }}
        >
          Update now
        </button>
        <button
          type="button"
          className="update-dismiss"
          aria-label="Dismiss update notice"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, info.latest);
            setInfo(null);
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
