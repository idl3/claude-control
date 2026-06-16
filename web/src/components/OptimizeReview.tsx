import { useEffect, useRef, useState } from 'react';
import type { OptimizeResult } from '../lib/api';

interface OptimizeReviewProps {
  original: string;
  result: OptimizeResult;
  onAccept: (text: string) => void;
  onClose: () => void;
}

// Compute a simple line-level diff between two strings.
// Returns an array of {kind: 'add'|'del'|'same', text: string}.
interface DiffLine {
  kind: 'add' | 'del' | 'same';
  text: string;
}

function lineDiff(original: string, suggested: string): DiffLine[] {
  const aLines = original.split('\n');
  const bLines = suggested.split('\n');
  const aSet = new Set(aLines);
  const bSet = new Set(bLines);
  const result: DiffLine[] = [];

  // Two-pointer approach: walk both arrays in order.
  // Lines that appear in both sets are "same", lines only in a are "del",
  // lines only in b are "add". This is a simple heuristic (not LCS) — good
  // enough for the cosmetic diff display at v1.
  let ai = 0;
  let bi = 0;
  while (ai < aLines.length || bi < bLines.length) {
    const a = aLines[ai];
    const b = bLines[bi];

    if (ai >= aLines.length) {
      result.push({ kind: 'add', text: b });
      bi++;
    } else if (bi >= bLines.length) {
      result.push({ kind: 'del', text: a });
      ai++;
    } else if (a === b) {
      result.push({ kind: 'same', text: a });
      ai++;
      bi++;
    } else if (!bSet.has(a) && aSet.has(b)) {
      // a was deleted, b was inserted
      result.push({ kind: 'del', text: a });
      result.push({ kind: 'add', text: b });
      ai++;
      bi++;
    } else if (!bSet.has(a)) {
      result.push({ kind: 'del', text: a });
      ai++;
    } else if (!aSet.has(b)) {
      result.push({ kind: 'add', text: b });
      bi++;
    } else {
      // Both exist somewhere in the other — emit same for b's perspective
      result.push({ kind: 'same', text: a });
      ai++;
      bi++;
    }
  }
  return result;
}

export function OptimizeReview({ original, result, onAccept, onClose }: OptimizeReviewProps) {
  const [edited, setEdited] = useState(result.optimized);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea on mount.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Esc closes the modal.
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

  const diff = lineDiff(original, result.optimized);
  const hasDiff = diff.some((d) => d.kind !== 'same');

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal modal-optimize"
        role="dialog"
        aria-modal={true}
        aria-label="Review enhanced prompt"
      >
        <div className="modal-head">
          <div className="modal-head-group">
            <span className="modal-title modal-title-optimize">Enhanced prompt</span>
            <span className="optimize-mode-badge" data-mode={result.mode}>
              {result.mode === 'llm' ? 'claude -p' : 'rules'}
            </span>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {/* Editable suggestion — always editable before accepting */}
          <div className="optimize-section">
            <span className="optimize-section-label">Suggestion</span>
            <textarea
              ref={textareaRef}
              className="optimize-suggestion"
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              rows={6}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {/* Line-level diff */}
          {hasDiff ? (
            <div className="optimize-section">
              <span className="optimize-section-label">Changes vs original</span>
              <div className="optimize-diff">
                {diff.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === 'add'
                        ? 'diff-add'
                        : line.kind === 'del'
                          ? 'diff-del'
                          : 'diff-same'
                    }
                  >
                    {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                    {line.text || ' '}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Rationale list */}
          {result.rationale.length > 0 ? (
            <div className="optimize-section">
              <span className="optimize-section-label">Rationale</span>
              <ul className="optimize-list">
                {result.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Changes list */}
          {result.changes.length > 0 ? (
            <div className="optimize-section">
              <span className="optimize-section-label">What changed</span>
              <ul className="optimize-list">
                {result.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Discard
          </button>
          <span className="modal-foot-spacer" />
          <button
            type="button"
            className="btn-primary"
            onClick={() => onAccept(edited)}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
