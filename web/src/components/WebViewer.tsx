import { useEffect, useRef, useState } from 'react';

interface WebViewerProps {
  url: string;
  onClose: () => void;
}

// How long to wait (ms) for the iframe onLoad before declaring it blocked.
const LOAD_TIMEOUT_MS = 3500;

export function WebViewer({ url, onClose }: WebViewerProps) {
  const [maximized, setMaximized] = useState(false);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'timeout'>('loading');
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start a load-timeout on mount; clear it once the iframe fires onLoad.
  useEffect(() => {
    timeoutRef.current = setTimeout(() => {
      setLoadState((s) => (s === 'loading' ? 'timeout' : s));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
    };
  }, [url]);

  // Esc closes the viewer (unless focus is inside the iframe document — which we
  // can't reach cross-origin, so we catch it on the document and bail early only
  // if a modal/dialog already owns Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Let browser-native dialogs win.
      if (document.querySelector('[aria-modal="true"]')) return;
      e.stopPropagation();
      onClose();
    };
    // Use capture so this fires before the App-level Esc handlers.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const handleLoad = () => {
    if (timeoutRef.current != null) clearTimeout(timeoutRef.current);
    setLoadState('loaded');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable — silently ignore */
    }
  };

  // Truncate long URLs for the header label.
  const displayUrl = url.length > 80 ? `${url.slice(0, 77)}…` : url;

  return (
    <div
      className={`webviewer-overlay${maximized ? ' maximized' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Web viewer: ${url}`}
    >
      <div className="webviewer-head">
        <span className="webviewer-url" title={url}>{displayUrl}</span>
        <div className="webviewer-controls">
          <button
            type="button"
            className="webviewer-btn"
            aria-label={maximized ? 'Restore window size' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? '⊡' : '⤢'}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="webviewer-btn webviewer-btn--link"
            aria-label="Open in new window"
            title="Open in new window"
          >
            ↗
          </a>
          <button
            type="button"
            className="webviewer-btn"
            aria-label={copied ? 'Copied!' : 'Copy URL'}
            title={copied ? 'Copied!' : 'Copy URL'}
            onClick={handleCopy}
          >
            {copied ? '✓' : '⎘'}
          </button>
          <button
            type="button"
            className="webviewer-btn webviewer-btn--close"
            aria-label="Close viewer"
            title="Close (Esc)"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>

      {/* Persistent embed-hint: always visible, subtle. */}
      <div className="webviewer-embed-hint">
        If the page is blank, the site blocks embedding — use Open in new window ↗
      </div>

      {/* Blocked / timed-out state — prominent fallback. */}
      {loadState === 'timeout' ? (
        <div className="webviewer-blocked">
          <p>Could not load the page — the site may block embedding.</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="webviewer-open-btn"
          >
            Open in new window ↗
          </a>
        </div>
      ) : null}

      <iframe
        src={url}
        className="webviewer-frame"
        title="Web viewer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerPolicy="no-referrer"
        onLoad={handleLoad}
        // Hide the iframe once we've declared a timeout (shows the blocked state
        // instead). We keep it mounted so it doesn't re-request on state recovery.
        style={loadState === 'timeout' ? { display: 'none' } : undefined}
      />
    </div>
  );
}
