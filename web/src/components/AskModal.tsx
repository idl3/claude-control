import { useEffect, useMemo, useRef, useState } from 'react';
import type { Pending } from '../lib/types';

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

/**
 * AskUserQuestion dialog. Focus-trapped, Esc closes, aria-modal. Each question
 * renders its options as toggle buttons (multiSelect → many, single → radio).
 * "Send answer" stays disabled until every question has ≥1 selection.
 */
export function AskModal({
  pending,
  capture,
  onAnswer,
  onCapture,
  onClose,
}: AskModalProps) {
  const [selections, setSelections] = useState<Selections>(() =>
    initSelections(pending),
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  // Reset selections whenever a new pending question arrives.
  useEffect(() => {
    setSelections(initSelections(pending));
  }, [pending]);

  // Focus management: capture prior focus, focus the dialog, restore on unmount.
  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    const first = dialogRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [tabindex]',
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
          {pending.questions.map((q, qIdx) => (
            <div className="question" key={qIdx}>
              {q.header ? <div className="q-header">{q.header}</div> : null}
              <div className="q-text">{q.question}</div>
              {q.multiSelect ? (
                <div className="q-hint">select one or more</div>
              ) : null}
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
            </div>
          ))}

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
