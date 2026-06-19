import { useEffect, useRef, useState } from 'react';
import type { OptimizeResult } from '../lib/api';
import { Kbd } from './Kbd';
import { useModalTransition } from '../lib/anim';

interface OptimizeReviewProps {
  original: string;
  result: OptimizeResult;
  /** Primary: dispatch the rewritten prompt (also runs on the auto-send timer). */
  onSend: (text: string) => void;
  /** Secondary: drop the rewritten prompt into the composer WITHOUT dispatching. */
  onAccept: (text: string) => void;
  onClose: () => void;
}

const AUTO_SEND_SECS = 1.8;

// Compute a simple line-level diff between two strings.
// Returns an array of {kind: 'add'|'del'|'same', text: string}.
interface DiffLine {
  kind: 'add' | 'del' | 'same';
  text: string;
}

// Human label for the badge: the backend that actually produced the result.
// mlx → short model name; claude → "claude -p"; rules → "rules".
function backendLabel(result: OptimizeResult): string {
  if (result.backend === 'mlx') {
    const short = (result.model || '')
      .replace(/^mlx-community\//, '')
      .replace(/-Instruct-4bit$/i, '')
      .replace(/-4bit$/i, '');
    return short ? `MLX · ${short}` : 'MLX';
  }
  if (result.backend === 'claude') return 'claude -p';
  if (result.backend === 'rules') return 'rules';
  return result.mode === 'llm' ? 'llm' : 'rules';
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

export function OptimizeReview({ original, result, onSend, onAccept, onClose: rawClose }: OptimizeReviewProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [edited, setEdited] = useState(result.optimized);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Auto-send countdown: dispatch the rewrite after AUTO_SEND_SECS unless the
  // user intervenes (scrolls the review, edits the text, or hovers a button).
  // `armed=false` cancels it. The remaining time is shown as a depleting ring
  // around the Send button (CSS), not a number.
  const [armed, setArmed] = useState(true);
  const editedRef = useRef(edited);
  editedRef.current = edited;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const cancelAuto = () => setArmed(false);

  // Focus the textarea on mount. We DON'T cancel the countdown on focus —
  // focusing is implicit; only an actual edit/scroll cancels.
  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Single timer matched to the ring animation: fire onSend when it depletes.
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => onSendRef.current(editedRef.current), AUTO_SEND_SECS * 1000);
    return () => clearTimeout(t);
  }, [armed]);

  // Esc closes the modal; ⌘/Ctrl+Enter sends immediately (short-circuit the
  // 5 s auto-send countdown).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSendRef.current(editedRef.current);
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
      ref={rootRef}
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
              {backendLabel(result)}
            </span>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body" onScroll={cancelAuto} onWheel={cancelAuto} onTouchMove={cancelAuto}>
          {/* Editable suggestion — always editable before accepting */}
          <div className="optimize-section">
            <span className="optimize-section-label">Suggestion</span>
            <textarea
              ref={textareaRef}
              className="optimize-suggestion"
              value={edited}
              onChange={(e) => {
                setEdited(e.target.value);
                cancelAuto(); // editing means you want to review, not auto-send
              }}
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
          {/* Secondary: load into the composer, don't dispatch. */}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onAccept(edited)}
            onMouseEnter={cancelAuto}
          >
            To Composer
          </button>
          {/* Primary: dispatch the rewrite (auto-fires on the countdown). */}
          <button
            type="button"
            className={`btn-primary btn-send${armed ? ' btn-send-armed' : ''}`}
            style={
              armed
                ? ({ '--auto-send-secs': `${AUTO_SEND_SECS}s` } as React.CSSProperties)
                : undefined
            }
            onClick={() => onSend(edited)}
          >
            <span className="btn-send-label">
              Send <Kbd>⌘/Ctrl+↵</Kbd>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
