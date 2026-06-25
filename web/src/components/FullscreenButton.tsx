import { useState, useEffect } from 'react';

// Guard: some browsers (iOS Safari on iPhone) don't support element fullscreen.
// If not supported, render nothing so we don't show a dead button.
const isSupported =
  typeof document !== 'undefined' &&
  typeof document.documentElement.requestFullscreen === 'function';

// Compact fullscreen toggle for the resource HUD. Reuses .notify-bell styling.
export function FullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(
    typeof document !== 'undefined' ? !!document.fullscreenElement : false,
  );

  useEffect(() => {
    if (!isSupported) return;

    const handler = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handler);
    return () => {
      document.removeEventListener('fullscreenchange', handler);
    };
  }, []);

  if (!isSupported) return null;

  const label = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';

  const onClick = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  };

  return (
    <button
      type="button"
      className="notify-bell"
      data-state={isFullscreen ? 'on' : 'off'}
      aria-pressed={isFullscreen}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {isFullscreen ? (
          // Compress: four arrows pointing inward toward center
          <>
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="10" y1="14" x2="3" y2="21" />
            <line x1="21" y1="3" x2="14" y2="10" />
          </>
        ) : (
          // Expand: four arrows pointing outward from center
          <>
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </>
        )}
      </svg>
    </button>
  );
}
