import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pending, PendingQuestion } from '../lib/types';
import { useModalTransition } from '../lib/anim';

interface AskModalProps {
  pending: Pending;
  capture: string | null;
  onAnswer: (toolUseId: string, selections: string[][]) => void;
  onCapture: () => void;
  onClose: () => void;
}

// One Set<label> of selected options per question.
type Selections = Set<string>[];

function initSelections(pending: Pending): Selections {
  return pending.questions.map(() => new Set<string>());
}

/** True when any option in the question carries a preview string. */
export function questionHasPreview(q: PendingQuestion): boolean {
  return q.options.some((o) => typeof o.preview === 'string' && o.preview.length > 0);
}

/**
 * AskUserQuestion dialog. Focus-trapped, Esc closes, aria-modal.
 *
 * When any option in a question carries a `preview` string the question
 * renders in a SIDE-BY-SIDE layout: a vertical selectable option list on the
 * left and the focused option's preview (monospace, scrollable) on the right.
 * Questions with no previews keep a button-list layout.
 *
 * Keyboard: ↑/↓ move focus within an option list; Space/Enter toggle
 * selection of the focused row; Tab/Shift-Tab cycle the modal focus-trap.
 */
export function AskModal({
  pending,
  capture,
  onAnswer,
  onCapture,
  onClose: rawClose,
}: AskModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const [selections, setSelections] = useState<Selections>(() =>
    initSelections(pending),
  );
  // Per-question focused option index for the split layout.
  const [focusedIdx, setFocusedIdx] = useState<number[]>(() =>
    pending.questions.map(() => 0),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Reset selections + focus when a new pending question arrives.
  useEffect(() => {
    setSelections(initSelections(pending));
    setFocusedIdx(pending.questions.map(() => 0));
  }, [pending]);

  // Focus management: capture prior focus, focus the dialog, restore on unmount.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [tabindex="0"]',
    );
    (first ?? dialogRef.current)?.focus();
    return () => {
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const ready = useMemo(
    () => selections.length > 0 && selections.every((s) => s.size > 0),
    [selections],
  );

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const next = prev.map((s) => new Set(s));
      const set = next[qIdx];
      if (multi) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        next[qIdx] = new Set([label]);
      }
      return next;
    });
  };

  const moveFocus = (qIdx: number, delta: number, optCount: number) => {
    setFocusedIdx((prev) => {
      const next = [...prev];
      next[qIdx] = Math.max(0, Math.min(optCount - 1, (prev[qIdx] ?? 0) + delta));
      return next;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex="0"]',
    );
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = () => {
    if (!ready) return;
    onAnswer(
      pending.toolUseId,
      selections.map((s) => [...s]),
    );
  };

  return (
    <div
      className="modal-backdrop"
      ref={rootRef}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Question from Claude"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <span className="modal-title">Claude is asking</span>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {pending.questions.map((q, qIdx) => {
            const hasSplit = questionHasPreview(q);
            const focused = focusedIdx[qIdx] ?? 0;
            const focusedOpt = q.options[focused];

            return (
              <div className="question" key={qIdx}>
                {q.header ? <div className="q-header">{q.header}</div> : null}
                <div className="q-text">{q.question}</div>
                {q.multiSelect ? (
                  <div className="q-hint">select one or more</div>
                ) : null}

                {hasSplit ? (
                  <div className="ask-split">
                    {/* Left: selectable option list */}
                    <div
                      className="ask-split-list"
                      role="listbox"
                      aria-multiselectable={!!q.multiSelect}
                      aria-label={q.question}
                    >
                      {q.options.map((opt, oIdx) => {
                        const selected = selections[qIdx]?.has(opt.label);
                        const isFocused = oIdx === focused;
                        return (
                          <div
                            key={opt.label}
                            className="ask-split-row"
                            data-focused={isFocused ? 'true' : 'false'}
                            data-selected={selected ? 'true' : 'false'}
                            role="option"
                            aria-selected={selected}
                            tabIndex={isFocused ? 0 : -1}
                            onMouseEnter={() => setFocusedIdx((prev) => {
                              const next = [...prev];
                              next[qIdx] = oIdx;
                              return next;
                            })}
                            onClick={() => {
                              setFocusedIdx((prev) => {
                                const next = [...prev];
                                next[qIdx] = oIdx;
                                return next;
                              });
                              toggle(qIdx, opt.label, !!q.multiSelect);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'ArrowDown') {
                                e.preventDefault();
                                moveFocus(qIdx, 1, q.options.length);
                              } else if (e.key === 'ArrowUp') {
                                e.preventDefault();
                                moveFocus(qIdx, -1, q.options.length);
                              } else if (e.key === ' ' || e.key === 'Enter') {
                                e.preventDefault();
                                toggle(qIdx, opt.label, !!q.multiSelect);
                              }
                            }}
                          >
                            <span className="ask-split-indicator">
                              {q.multiSelect ? (
                                <span className="ask-check" aria-hidden="true">
                                  {selected ? '▣' : '▢'}
                                </span>
                              ) : (
                                <span className="ask-radio" aria-hidden="true">
                                  {selected ? '◉' : '○'}
                                </span>
                              )}
                            </span>
                            <span className="ask-split-text">
                              <span className="option-label">{opt.label}</span>
                              {opt.description ? (
                                <span className="option-desc">{opt.description}</span>
                              ) : null}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    {/* Right: preview pane */}
                    <div className="ask-preview" aria-live="polite" aria-label="Option preview">
                      {focusedOpt?.preview ? (
                        <>
                          <div className="ask-preview-label">{focusedOpt.label}</div>
                          <pre className="ask-preview-content">{focusedOpt.preview}</pre>
                        </>
                      ) : (
                        <div className="ask-preview-empty">no preview</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="q-options">
                    {q.options.map((opt) => {
                      const on = selections[qIdx]?.has(opt.label);
                      return (
                        <button
                          type="button"
                          key={opt.label}
                          className="option-btn"
                          data-on={on ? 'true' : 'false'}
                          aria-pressed={on}
                          onClick={() => toggle(qIdx, opt.label, !!q.multiSelect)}
                        >
                          <span className="option-label">{opt.label}</span>
                          {opt.description ? (
                            <span className="option-desc">{opt.description}</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {capture != null ? (
            <pre className="capture-output">{capture}</pre>
          ) : null}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-secondary" onClick={onCapture}>
            Show Terminal
          </button>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!ready}
            onClick={submit}
          >
            Send Answer
          </button>
        </div>
      </div>
    </div>
  );
}
