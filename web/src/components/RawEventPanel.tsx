import { useEffect, useMemo, useState } from 'react';
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

// One event paired with its original index in the (chronological) events array.
// The index is the stable selection key: it survives filtering, so narrowing the
// search never silently re-points the open detail at a different event.
interface IndexedEvent {
  event: RawEvent;
  idx: number;
}

export function RawEventPanel({ events, onClose }: RawEventPanelProps) {
  // Global search across source/kind/summary AND the serialized detail.
  const [query, setQuery] = useState('');
  // Original-array index of the drilled-in event; null = table tier (no drill).
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Escape drills back out of a selected event first, then closes the panel.
      if (selectedIdx !== null) {
        setSelectedIdx(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, selectedIdx]);

  // Newest-first, each row carrying its stable original index.
  const indexed = useMemo<IndexedEvent[]>(
    () => events.map((event, idx) => ({ event, idx })).reverse(),
    [events],
  );

  // Case-insensitive match across source, kind, summary, and the full detail
  // text — same detailText() the detail tier renders, so a hit in the JSON body
  // is findable even when the summary doesn't mention it.
  const filtered = useMemo<IndexedEvent[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexed;
    return indexed.filter(({ event }) => {
      const hay = [event.source, event.kind, event.summary ?? '', detailText(event.detail)]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [indexed, query]);

  // The drilled-in event (guarded — a filter change can hide the selected row,
  // but the detail keeps rendering from the stable original index until the user
  // navigates away or picks another row).
  const selected = selectedIdx !== null ? events[selectedIdx] ?? null : null;

  return (
    <aside className="raw-panel" role="complementary" aria-label="Raw session events">
      <div className="raw-panel-head">
        <span className="raw-title">Raw events</span>
        <span className="raw-count">{filtered.length}</span>
        <button type="button" className="raw-close" aria-label="Close raw events" onClick={onClose}>
          <XIcon size={16} />
        </button>
      </div>
      <div className="raw-search">
        <input
          type="search"
          className="raw-search-input"
          placeholder="Filter events…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter raw events"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      {events.length === 0 ? (
        <div className="raw-body">
          <div className="raw-empty">No events captured yet.</div>
        </div>
      ) : (
        // data-detail flips the mobile (≤760px) drill-in: the table is replaced
        // by the detail. On desktop (>760px) both panes stay side-by-side.
        <div className="raw-split" data-detail={selected ? 'true' : undefined}>
          <div className="raw-table" role="list" aria-label="Raw event list">
            {filtered.length === 0 ? (
              <div className="raw-empty">No events match “{query}”.</div>
            ) : (
              filtered.map(({ event, idx }) => (
                <button
                  type="button"
                  role="listitem"
                  key={`${event.ts}-${idx}`}
                  className="raw-row"
                  aria-current={idx === selectedIdx ? 'true' : undefined}
                  data-on={idx === selectedIdx ? 'true' : undefined}
                  onClick={() => setSelectedIdx(idx)}
                >
                  <span className="raw-row-time">{formatTime(event.ts)}</span>
                  <span className="raw-row-chips">
                    <span className="raw-chip">{event.source}</span>
                    <span className="raw-chip raw-chip-kind">{event.kind}</span>
                  </span>
                  {event.summary ? (
                    <span className="raw-row-summary">{event.summary}</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          <div className="raw-detail-pane">
            {selected ? (
              <RawEventDetail event={selected} onBack={() => setSelectedIdx(null)} />
            ) : (
              <div className="raw-detail-empty">Select an event to see its detail.</div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}

function RawEventDetail({ event, onBack }: { event: RawEvent; onBack: () => void }) {
  const detail = detailText(event.detail);
  return (
    <div className="raw-detail-body">
      <div className="raw-detail-head">
        {/* Mobile-only affordance to drill back to the table (CSS-hidden on desktop). */}
        <button type="button" className="raw-back" onClick={onBack} aria-label="Back to event list">
          ← Back
        </button>
        <span className="raw-time">{formatTime(event.ts)}</span>
        <span className="raw-chip">{event.source}</span>
        <span className="raw-chip raw-chip-kind">{event.kind}</span>
      </div>
      {event.summary ? <div className="raw-summary">{event.summary}</div> : null}
      {detail ? (
        <pre className="raw-detail" aria-label="Raw event detail">
          {detail}
        </pre>
      ) : (
        <div className="raw-detail-empty">No structured detail on this event.</div>
      )}
    </div>
  );
}
