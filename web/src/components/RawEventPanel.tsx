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
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal raw-panel" role="dialog" aria-modal="true" aria-label="Raw session events">
        <div className="modal-head">
          <span className="modal-title">Raw events</span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
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
                    <details className="raw-detail">
                      <summary>detail</summary>
                      <pre>{detail}</pre>
                    </details>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
