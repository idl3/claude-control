import { useEffect, useRef, useState } from 'react';
import { listSkills, type SkillEntry } from '../lib/api';
import { useIsNarrow } from '../hooks/useIsNarrow';

interface SkillBrowserProps {
  onPick: (name: string) => void;
  onClose: () => void;
}

/**
 * Browsable, searchable list of available slash-command skills.
 *
 * Presentation:
 *   - <760px (narrow / mobile): bottom sheet, search at top, scrollable list.
 *   - >=760px (desktop): centered modal using the existing modal-backdrop/modal
 *     pattern from PromptModal.
 *
 * Each skill renders as a tool-call-styled card, mirroring the visual of
 * ToolPart in MessageParts.tsx (▸ name — description).
 *
 * Invocation: tapping a card calls onPick(name) — the composer prefills
 * `/<name> ` and the browser closes. NEVER auto-sends.
 */
export function SkillBrowser({ onPick, onClose }: SkillBrowserProps) {
  const narrow = useIsNarrow();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Load skills on mount.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    listSkills()
      .then((s) => {
        if (alive) {
          setSkills(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Focus search input on open.
  useEffect(() => {
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : skills;

  const inner = (
    <div
      className="skill-browser"
      data-mode={narrow ? 'sheet' : 'modal'}
      role="dialog"
      aria-modal="true"
      aria-label="Skill browser"
    >
      <div className="skill-browser-head">
        <span className="skill-browser-title">Skills</span>
        <button
          type="button"
          className="modal-close"
          aria-label="Close skill browser"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="skill-browser-search">
        <input
          ref={searchRef}
          type="search"
          className="skill-search-input"
          placeholder="Search skills…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          aria-label="Search skills"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="skill-browser-list" role="list">
        {loading ? (
          <div className="skill-browser-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="skill-browser-empty">
            {q ? 'No skills match your search.' : 'No skills found.'}
          </div>
        ) : (
          filtered.map((skill) => (
            <button
              key={skill.name}
              type="button"
              className="skill-card"
              role="listitem"
              onClick={() => onPick(skill.name)}
              title={`Prefill /${skill.name}`}
            >
              {/* Mirror the ToolPart .block-tool-use layout */}
              <span className="tool-head">
                <span className="tool-arrow" aria-hidden="true">
                  ▸
                </span>
                <span className="tool-name skill-card-name">{skill.name}</span>
                {skill.description ? (
                  <>
                    <span className="tool-sep">—</span>
                    <span className="tool-input skill-card-desc">
                      {skill.description}
                    </span>
                  </>
                ) : null}
              </span>
              {skill.source === 'plugin' ? (
                <span className="skill-source-tag">plugin</span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );

  if (narrow) {
    // Bottom sheet: no backdrop click-dismiss (user must use close button or Esc)
    // to avoid accidental closes when scrolling.
    return <div className="skill-browser-sheet-wrap">{inner}</div>;
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {inner}
    </div>
  );
}
