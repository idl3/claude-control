import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useModalTransition } from '../lib/anim';
import './CommandPalette.css';

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: string;
  /** Keycap shown on the row (e.g. a native shortcut "⌘,"). Falls back to the
   *  1–9 quick-select index. Display only — quick-select is always ⌘/Ctrl+N. */
  hotkey?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
}

// ── Scored matching ───────────────────────────────────────────────
// Returns a relevance score (higher = closer); 0 means no match. We rank by
// closeness to a FULL-TEXT match: exact > prefix > word-start > substring >
// fuzzy subsequence, with the label weighted far above hint/keywords so a query
// targets the visible name, not incidental metadata.

function subsequence(haystack: string, needle: string): boolean {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++;
  }
  return ni === needle.length;
}

function scoreCommand(cmd: PaletteCommand, query: string): number {
  if (!query) return 1; // no query → all match equally (preserve given order)
  const q = query.toLowerCase().trim();
  const label = cmd.label.toLowerCase();
  const meta = [cmd.hint ?? '', cmd.keywords ?? '', cmd.group ?? ''].join(' ').toLowerCase();

  if (label === q) return 1000;
  if (label.startsWith(q)) return 700 - label.length; // shorter label = closer
  const idx = label.indexOf(q);
  if (idx >= 0) {
    const wordStart = idx === 0 || !/[a-z0-9]/.test(label[idx - 1]);
    return (wordStart ? 550 : 400) - label.length;
  }
  const metaIdx = meta.indexOf(q);
  if (metaIdx >= 0) return 220 - metaIdx;
  if (subsequence(label, q)) return 120;
  if (subsequence(meta, q)) return 60;
  return 0;
}

// ── Grouping ──────────────────────────────────────────────────────
// Sections keep the ORDER the parent passed groups in (Sessions, Terminals,
// Actions). Within each section, matches sort by score (stable for ties via the
// original index). The rendered order IS the keyboard order — `flat` below is
// derived from these sections so activeIndex/⌘N/scroll never diverge from what
// the user sees (the cause of selecting the wrong target).

interface GroupedSection {
  group: string | undefined;
  items: PaletteCommand[];
}

function buildSections(commands: PaletteCommand[], query: string): {
  sections: GroupedSection[];
  flat: PaletteCommand[];
} {
  const order: (string | undefined)[] = [];
  const buckets = new Map<string | undefined, { cmd: PaletteCommand; score: number; i: number }[]>();
  commands.forEach((cmd, i) => {
    const score = scoreCommand(cmd, query);
    if (score <= 0) return;
    const key = cmd.group;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push({ cmd, score, i });
  });

  const sections: GroupedSection[] = order.map((key) => {
    const items = buckets
      .get(key)!
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((e) => e.cmd);
    return { group: key, items };
  });
  const flat = sections.flatMap((s) => s.items);
  return { sections, flat };
}

// ── Component ─────────────────────────────────────────────────────

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const { rootRef, requestClose } = useModalTransition(onClose);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Focus the input immediately on mount.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Sections (fixed group order, score-sorted within) + the flat list in the
  // EXACT rendered order — keyboard nav and ⌘N index into `flat`, so the
  // highlighted/selected row is always the one shown.
  const { sections, flat } = useMemo(() => buildSections(commands, query), [commands, query]);
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    flat.forEach((c, i) => m.set(c.id, i));
    return m;
  }, [flat]);

  // Keep the highlight in range as the result set shrinks/grows.
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setActiveIndex(0);
  }, []);

  // Run a command and close.
  const runCommand = useCallback(
    (cmd: PaletteCommand | undefined) => {
      if (!cmd) return;
      cmd.run();
      requestClose();
    },
    [requestClose],
  );

  // Keyboard: arrows/Tab move, Enter runs the highlight, ⌘/Ctrl+1‑9 jumps
  // straight to the Nth visible result (plain digits stay typeable in search).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const count = flat.length;
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        runCommand(flat[Number(e.key) - 1]);
        return;
      }
      if (count === 0) return;
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % count);
      } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + count) % count);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runCommand(flat[activeIndex]);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [flat, activeIndex, runCommand, requestClose]);

  // Scroll highlighted row into view on keyboard navigation.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLLIElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      className="cmdk-backdrop"
      ref={rootRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal
        aria-label="Command palette"
      >
        {/* Search row */}
        <div className="cmdk-search-row">
          <span className="cmdk-search-icon" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <line
                x1="10.5"
                y1="10.5"
                x2="14"
                y2="14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="cmdk-input"
            type="text"
            placeholder="Search commands…"
            value={query}
            onChange={handleQueryChange}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              className="cmdk-clear"
              onClick={() => {
                setQuery('');
                setActiveIndex(0);
                inputRef.current?.focus();
              }}
              tabIndex={-1}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Results */}
        <ul className="cmdk-list" ref={listRef} role="listbox" aria-label="Commands">
          {flat.length === 0 ? (
            <li className="cmdk-empty" role="option" aria-selected={false}>
              No matches
            </li>
          ) : (
            sections.map((section) => (
              <li key={section.group ?? '__ungrouped__'} className="cmdk-section">
                {section.group !== undefined && (
                  <div className="cmdk-group-header" role="presentation">
                    {section.group}
                  </div>
                )}
                <ul className="cmdk-section-list" role="presentation">
                  {section.items.map((cmd) => {
                    const flatIdx = indexById.get(cmd.id) ?? 0;
                    const isActive = flatIdx === activeIndex;
                    // Keycap: a native shortcut if the command declares one,
                    // else the ⌘N quick-select for the first nine results.
                    const cap = cmd.hotkey ?? (flatIdx < 9 ? `⌘${flatIdx + 1}` : null);
                    return (
                      <li
                        key={cmd.id}
                        className={`cmdk-row${isActive ? ' cmdk-row--active' : ''}`}
                        role="option"
                        aria-selected={isActive}
                        data-index={flatIdx}
                        onClick={() => runCommand(cmd)}
                        onMouseMove={() => setActiveIndex(flatIdx)}
                      >
                        <span className="cmdk-row-label">{cmd.label}</span>
                        {cmd.hint && <span className="cmdk-row-hint">{cmd.hint}</span>}
                        {cap && <span className="cmdk-row-key">{cap}</span>}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
