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

// One event paired with its stable identity key (see keyOf below). The key —
// not the array index — is the selection anchor: raw events have no unique
// id, and the events array both gets filtered (search) AND front-evicted
// (useClaudeControl caps at RAW_EVENT_CAP and slices from the front), so an
// index-based selection silently drifts to an unrelated event over time. A
// content-derived key survives both; it only "misses" if the exact
// (ts, source, kind, summary) tuple repeats, which is an acceptable tradeoff
// for a raw-debug view.
interface KeyedEvent {
  event: RawEvent;
  key: string;
}

function keyOf(event: RawEvent): string {
  return `${event.ts}|${event.source}|${event.kind}|${event.summary}`;
}

export function RawEventPanel({ events, onClose }: RawEventPanelProps) {
  // Global search across source/kind/summary AND the serialized detail.
  const [query, setQuery] = useState('');
  // Stable identity key of the drilled-in event; null = table tier (no drill).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Escape drills back out of a selected event first, then closes the panel.
      if (selectedKey !== null) {
        setSelectedKey(null);
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, selectedKey]);

  // Newest-first, each row carrying its stable identity key.
  const indexed = useMemo<KeyedEvent[]>(
    () => events.map((event) => ({ event, key: keyOf(event) })).reverse(),
    [events],
  );

  // Case-insensitive match across source, kind, summary, and the full detail
  // text — same detailText() the detail tier renders, so a hit in the JSON body
  // is findable even when the summary doesn't mention it.
  const filtered = useMemo<KeyedEvent[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexed;
    return indexed.filter(({ event }) => {
      const hay = [event.source, event.kind, event.summary ?? '', detailText(event.detail)]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [indexed, query]);

  // The drilled-in event, looked up by identity key on every render. A filter
  // change can hide the selected row (detail still renders); a session switch
  // or front-eviction that drops the selected event from the array makes the
  // lookup fail closed to null instead of silently re-pointing at a neighbor.
  const selected = selectedKey !== null ? events.find((e) => keyOf(e) === selectedKey) ?? null : null;

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
              filtered.map(({ event, key }) => (
                <button
                  type="button"
                  role="listitem"
                  key={key}
                  className="raw-row"
                  aria-current={key === selectedKey ? 'true' : undefined}
                  data-on={key === selectedKey ? 'true' : undefined}
                  onClick={() => setSelectedKey(key)}
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
              <RawEventDetail event={selected} onBack={() => setSelectedKey(null)} />
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
