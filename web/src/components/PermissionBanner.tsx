import { useState } from 'react';

const DISMISS_KEY = 'claude-control-fda-dismissed';

/**
 * One-time banner shown when any pane hits macOS "Operation not permitted" — the
 * launchd service lacks Full Disk Access (TCC), so panes can't read ~/Documents
 * etc. Points the user at the fix instead of a silently broken session.
 * Dismissal is remembered so it won't nag once the user has handled it.
 */
export function PermissionBanner({ show }: { show: boolean }) {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  );
  if (!show || dismissed) return null;

  return (
    <div className="update-banner perm-banner" role="alert">
      <span>
        <strong>macOS permission needed.</strong> A pane hit “Operation not
        permitted” — grant <strong>Full Disk Access</strong> to the{' '}
        <code>node</code> that runs claude-control (System Settings → Privacy &amp;
        Security → Full Disk Access), then restart the service and run{' '}
        <code>tmux kill-server</code>.
      </span>
      <span className="update-actions">
        <a
          className="update-now"
          href="https://github.com/idl3/claude-control#macos-full-disk-access"
          target="_blank"
          rel="noopener noreferrer"
        >
          How to fix
        </a>
        <button
          type="button"
          className="update-dismiss"
          aria-label="Dismiss permission notice"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setDismissed(true);
          }}
        >
          ×
        </button>
      </span>
    </div>
  );
}
