import { useEffect, useState } from 'react';
import { getVersion, triggerUpdate } from '../lib/api';

const DISMISS_KEY = 'claude-control-update-dismissed';

interface Info {
  current: string;
  latest: string | null;
  behind: number;
}

/** Headline describing the available update (version bump, else commit count). */
function headline(info: Info): string {
  if (info.latest && info.latest !== info.current) {
    return `Update available — v${info.latest} (you’re on v${info.current}).`;
  }
  const n = info.behind || 1;
  return `Update available — ${n} new commit${n === 1 ? '' : 's'} (v${info.current}).`;
}

/**
 * Dismissible "update available" banner with a one-press in-place update.
 * Polls /api/version on mount; shows when the git upstream (origin) is ahead.
 * "Update now" POSTs /api/update — the server pulls, rebuilds, and restarts
 * itself; the page reconnects automatically. Dismissal is remembered per
 * upstream version/commit so it won't nag for the same release.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<Info | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let alive = true;
    getVersion().then((v) => {
      if (!alive || !v?.updateAvailable) return;
      const tag = v.latest ?? `behind-${v.behind ?? 0}`;
      if (localStorage.getItem(DISMISS_KEY) === tag) return;
      setInfo({ current: v.current, latest: v.latest, behind: v.behind ?? 0 });
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!info) return null;

  if (updating) {
    return (
      <div className="update-banner" role="status">
        <span>Updating… the page will reconnect shortly.</span>
      </div>
    );
  }

  return (
    <div className="update-banner" role="status">
      <span>{headline(info)}</span>
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
            localStorage.setItem(DISMISS_KEY, info.latest ?? `behind-${info.behind}`);
            setInfo(null);
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
