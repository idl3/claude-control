import { useEffect } from 'react';
import type { RawEvent } from '../lib/types';
import { XIcon } from './icons';

interface RawEventPanelProps {
  events: RawEvent[];
  onClose: () => void;
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return 'unknown';
  }
}

function detailText(detail: unknown): string {
  if (detail == null) return '';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

export function RawEventPanel({ events, onClose }: RawEventPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <aside className="raw-panel" role="complementary" aria-label="Raw session events">
      <div className="raw-panel-head">
        <span className="raw-title">Raw events</span>
        <span className="raw-count">{events.length}</span>
        <button type="button" className="raw-close" aria-label="Close raw events" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="raw-body">
        {events.length === 0 ? (
          <div className="raw-empty">No events captured yet.</div>
        ) : (
          [...events].reverse().map((event, index) => {
            const detail = detailText(event.detail);
            return (
              <div className="raw-event" key={`${event.ts}-${index}`}>
                <div className="raw-event-head">
                  <span className="raw-time">{formatTime(event.ts)}</span>
                  <span className="raw-chip">{event.source}</span>
                  <span className="raw-chip raw-chip-kind">{event.kind}</span>
                </div>
                {event.summary ? <div className="raw-summary">{event.summary}</div> : null}
                {detail ? (
                  <pre className="raw-detail" aria-label="Raw event detail">
                    {detail}
                  </pre>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
