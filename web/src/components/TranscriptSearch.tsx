/**
 * TranscriptSearch — in-page search overlay for the chat transcript.
 *
 * Highlighting strategy: CSS Custom Highlight API (CSS.highlights) so we never
 * mutate the React-owned DOM. Two named highlights are registered:
 *   • `transcript-search`        — all matches (amber tint)
 *   • `transcript-search-active` — the current hit (stronger tint)
 *
 * Feature-detect: if `CSS.highlights` is absent (older engines), the component
 * still works — it counts matches and scrollIntoView's the active hit's parent
 * element, but no highlight tint is painted.
 *
 * Match recomputation is debounced (120 ms) on query change, and throttled via
 * a MutationObserver while the panel is open so streaming content stays in sync.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from './icons';

// ─────────────────────────────────────────────────────────────────────────────
// Highlight API feature detection
// ─────────────────────────────────────────────────────────────────────────────

const HAS_HIGHLIGHT_API = typeof CSS !== 'undefined' && 'highlights' in CSS;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const HIGHLIGHT_ALL = 'transcript-search';
const HIGHLIGHT_ACTIVE = 'transcript-search-active';

function clearHighlights(): void {
  if (!HAS_HIGHLIGHT_API) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

/** Walk all text nodes under `root`, skipping `skipEl` and its subtree. */
function textNodesUnder(root: Element, skipEl: Element | null): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (skipEl && skipEl.contains(node)) continue;
    if ((node as Text).data.trim()) nodes.push(node as Text);
  }
  return nodes;
}

interface Hit {
  range: Range;
  /** Parent element used for scrollIntoView fallback */
  el: Element;
}

/**
 * Find all query occurrences across the text nodes, returning Range objects
 * (needed for the Highlight API) plus element references (for scrollIntoView).
 */
function findHits(textNodes: Text[], query: string): Hit[] {
  if (!query) return [];
  const lowerQuery = query.toLowerCase();
  const hits: Hit[] = [];

  for (const tn of textNodes) {
    const data = tn.data;
    const lower = data.toLowerCase();
    let pos = 0;
    while (pos <= lower.length - lowerQuery.length) {
      const idx = lower.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      const range = document.createRange();
      range.setStart(tn, idx);
      range.setEnd(tn, idx + lowerQuery.length);
      hits.push({
        range,
        el: (tn.parentElement ?? document.body) as Element,
      });
      pos = idx + lowerQuery.length;
    }
  }

  return hits;
}

function applyHighlights(hits: Hit[], activeIdx: number): void {
  if (!HAS_HIGHLIGHT_API) return;
  const allRanges = hits.map((h) => h.range);
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...allRanges));
  if (hits.length > 0 && activeIdx >= 0 && activeIdx < hits.length) {
    CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(hits[activeIdx].range));
  } else {
    CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  }
}

function scrollHitIntoView(hit: Hit): void {
  // Prefer Range's bounding rect for precise scrolling; fallback to element.
  if (hit.range.getBoundingClientRect) {
    const rect = hit.range.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      hit.el.scrollIntoView({ block: 'center' });
      return;
    }
  }
  hit.el.scrollIntoView({ block: 'center' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface TranscriptSearchProps {
  open: boolean;
  onClose: () => void;
}

export function TranscriptSearch({ open, onClose }: TranscriptSearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selfRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moRef = useRef<MutationObserver | null>(null);
  const moThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Compute hits ────────────────────────────────────────────────────────────

  const recompute = useCallback((q: string) => {
    const vp = document.querySelector<Element>('.thread-viewport');
    if (!vp) {
      clearHighlights();
      setHits([]);
      setActiveIdx(0);
      return;
    }

    const trimmed = q.trim();
    if (!trimmed) {
      clearHighlights();
      setHits([]);
      setActiveIdx(0);
      return;
    }

    const nodes = textNodesUnder(vp, selfRef.current);
    const found = findHits(nodes, trimmed);
    setHits(found);
    setActiveIdx((prev) => {
      const next = found.length > 0 ? Math.min(prev, found.length - 1) : 0;
      applyHighlights(found, next);
      if (found.length > 0) scrollHitIntoView(found[next]);
      return next;
    });
  }, []);

  const scheduleRecompute = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => recompute(q), 120);
    },
    [recompute],
  );

  // ── Mutation observer: keep highlights in sync while transcript streams ─────

  useEffect(() => {
    if (!open) return;

    const vp = document.querySelector<Element>('.thread-viewport');
    if (!vp) return;

    moRef.current = new MutationObserver(() => {
      if (moThrottleRef.current) return;
      moThrottleRef.current = setTimeout(() => {
        moThrottleRef.current = null;
        // Re-read current query from the input (not closure-captured state)
        const q = inputRef.current?.value ?? '';
        recompute(q);
      }, 200);
    });

    moRef.current.observe(vp, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      moRef.current?.disconnect();
      moRef.current = null;
      if (moThrottleRef.current) {
        clearTimeout(moThrottleRef.current);
        moThrottleRef.current = null;
      }
    };
  }, [open, recompute]);

  // ── Open/close lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    if (open) {
      // Focus the input on open; re-run the last query if re-opened.
      setTimeout(() => inputRef.current?.focus(), 0);
      if (query.trim()) scheduleRecompute(query);
    } else {
      clearHighlights();
      setHits([]);
      setActiveIdx(0);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    }
    // Intentionally not listing `query` — we only want this on open/close edge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearHighlights();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Active index changes: update highlight + scroll ─────────────────────────

  const goTo = useCallback(
    (idx: number) => {
      if (!hits.length) return;
      const next = ((idx % hits.length) + hits.length) % hits.length; // wrap
      setActiveIdx(next);
      applyHighlights(hits, next);
      scrollHitIntoView(hits[next]);
    },
    [hits],
  );

  const goNext = useCallback(() => goTo(activeIdx + 1), [goTo, activeIdx]);
  const goPrev = useCallback(() => goTo(activeIdx - 1), [goTo, activeIdx]);

  // ── Keyboard handling inside the search box ─────────────────────────────────

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      }
    },
    [onClose, goNext, goPrev],
  );

  if (!open) return null;

  const total = hits.length;
  const current = total > 0 ? activeIdx + 1 : 0;

  return (
    <div className="transcript-search" ref={selfRef} role="search" aria-label="Search transcript">
      <input
        ref={inputRef}
        className="transcript-search-input"
        type="search"
        placeholder="Search…"
        value={query}
        aria-label="Search query"
        onChange={(e) => {
          setQuery(e.target.value);
          scheduleRecompute(e.target.value);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
      />
      <span className="transcript-search-count" aria-live="polite" aria-atomic="true">
        {total === 0 ? (query.trim() ? '0' : '') : `${current}/${total}`}
      </span>
      <button
        type="button"
        className="transcript-search-nav"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        onClick={goPrev}
        disabled={total === 0}
      >
        ↑
      </button>
      <button
        type="button"
        className="transcript-search-nav"
        title="Next match (Enter)"
        aria-label="Next match"
        onClick={goNext}
        disabled={total === 0}
      >
        ↓
      </button>
      <button
        type="button"
        className="transcript-search-close"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
