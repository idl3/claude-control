import { useEffect, useMemo, useRef, useState } from 'react';
import { useHeightFlip } from './heightFlip.js';
import type { AskAnswer, AskOption, AskQuestion } from './types.js';

// ── Pure helpers ───────────────────────────────────────────────────────────────

type Selections = Set<string>[];

function initSelections(questions: AskQuestion[]): Selections {
  return questions.map(() => new Set<string>());
}

/** True when any option in the question carries a preview string. */
export function questionHasPreview(q: AskQuestion): boolean {
  return q.options.some((o) => typeof o.preview === 'string' && o.preview.length > 0);
}

/** True when the label indicates a "type something" / free-text option. */
export function isFreeTextOption(label: string): boolean {
  return /type something|chat about this/i.test(label);
}

/** Grow a textarea to fit its content (capped by the CSS max-height → scrolls). */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Claude's TUI always appends these two rows to an AskUserQuestion picker, but
 * they are NOT in the structured tool input — so a structured render adds them
 * to match what the TUI shows. Both route to the free-text flow. Hosts that
 * don't want TUI parity pass `freeTextRows={false}`.
 */
const SYNTHETIC_FREETEXT: AskOption[] = [
  { label: 'Type something' },
  { label: 'Chat about this' },
];

// ── AskQuestionForm ────────────────────────────────────────────────────────────

export interface AskQuestionFormProps {
  questions: AskQuestion[];
  /** One entry per question; free-text submits arrive as {kind,text} directives. */
  onSubmit: (answers: AskAnswer[]) => void;
  /**
   * When provided, free-text submits call THIS with the raw text instead of
   * building a directive for onSubmit — for hosts whose backend can't navigate
   * a structured free-text answer (claude-control uses it for synthesized
   * pendings that have no real picker behind them).
   */
  onFreeTextReply?: (text: string) => void;
  /** Append the TUI-parity "Type something"/"Chat about this" rows (default true). */
  freeTextRows?: boolean;
  /** Submit button label; claude-control keeps the default, the olam SPA sets its own. */
  submitLabel?: string;
  /** Height-FLIP target when the host owns the scroller; defaults to the kit root. */
  flipContainerRef?: React.RefObject<HTMLElement | null>;
  className?: string;
}

export function AskQuestionForm({
  questions,
  onSubmit,
  onFreeTextReply,
  freeTextRows = true,
  submitLabel = 'Send Answer',
  flipContainerRef,
  className,
}: AskQuestionFormProps) {
  const [selections, setSelections] = useState<Selections>(() => initSelections(questions));
  const [focusedIdx, setFocusedIdx] = useState<number[]>(() => questions.map(() => 0));
  // If a free-text option is selected, switch to textarea mode.
  const [freeTextQIdx, setFreeTextQIdx] = useState<number | null>(null);
  const [freeTextOptLabel, setFreeTextOptLabel] = useState<string>('');
  const [freeTextValue, setFreeTextValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const flipRef = flipContainerRef ?? rootRef;
  const flipHeight = useHeightFlip(flipRef, freeTextQIdx);

  const dispOptions = useMemo(
    () =>
      questions.map((q) => (freeTextRows ? [...q.options, ...SYNTHETIC_FREETEXT] : q.options)),
    [questions, freeTextRows],
  );

  useEffect(() => {
    setSelections(initSelections(questions));
    setFocusedIdx(questions.map(() => 0));
    setFreeTextQIdx(null);
    setFreeTextOptLabel('');
    setFreeTextValue('');
    setSubmitting(false);
  }, [questions]);

  // When entering free-text mode, focus the textarea and size it to any content.
  useEffect(() => {
    if (freeTextQIdx !== null) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        autoGrow(textareaRef.current);
      });
    }
  }, [freeTextQIdx]);

  const ready = useMemo(
    () => selections.length > 0 && selections.every((s) => s.size > 0),
    [selections],
  );

  const toggle = (qIdx: number, label: string, multi: boolean) => {
    if (submitting) return;
    // Free-text option: enter textarea mode instead of toggling.
    if (isFreeTextOption(label)) {
      flipHeight(); // capture height BEFORE the swap so the FLIP can animate it
      setFreeTextQIdx(qIdx);
      setFreeTextOptLabel(label);
      return;
    }
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

  const submit = () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    onSubmit(selections.map((s) => [...s]));
  };

  const submitFreeText = () => {
    const text = freeTextValue.trim();
    if (!text || submitting || freeTextQIdx === null) return;
    setSubmitting(true);
    // Host override: route the raw text as a plain reply (for pendings with no
    // real structured picker behind them).
    if (onFreeTextReply) {
      onFreeTextReply(text);
      return;
    }
    // Structured path: a DISTINCT free-text/chat directive for THIS question;
    // other questions keep their normal option-label arrays.
    const kind: 'text' | 'chat' = /chat about this/i.test(freeTextOptLabel) ? 'chat' : 'text';
    const answers: AskAnswer[] = selections.map((s) => [...s]);
    answers[freeTextQIdx] = { kind, text };
    onSubmit(answers);
  };

  // Free-text mode: keep the question context (header) for consistency; the
  // chosen option becomes a header above a focused borderless textarea.
  if (freeTextQIdx !== null) {
    const fq = questions[freeTextQIdx];
    const goBack = () => {
      flipHeight(); // animate the height back as the options return
      setFreeTextQIdx(null);
      setFreeTextOptLabel('');
      setFreeTextValue('');
    };
    return (
      <div ref={rootRef} className={className ? `agent-ui-kit ${className}` : 'agent-ui-kit'}>
        <div className="question ask-freetext-view">
          {fq?.header ? <div className="q-header">{fq.header}</div> : null}
          {fq?.question ? <div className="q-text">{fq.question}</div> : null}
          {/* The chosen option, now a header rather than a button. */}
          <div className="ask-freetext-chosen">{freeTextOptLabel}</div>
          <textarea
            ref={textareaRef}
            className="ask-inline-textarea"
            rows={3}
            value={freeTextValue}
            disabled={submitting}
            onChange={(e) => {
              setFreeTextValue(e.target.value);
              autoGrow(e.target);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submitFreeText();
              }
            }}
            placeholder="Type your reply…"
          />
          <div className="ask-inline-foot ask-inline-freetext-actions">
            <button type="button" className="btn-secondary" disabled={submitting} onClick={goBack}>
              Back
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!freeTextValue.trim() || submitting}
              onClick={submitFreeText}
            >
              {submitting ? <span className="working-spinner" aria-label="sending" /> : 'Send'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={className ? `agent-ui-kit ${className}` : 'agent-ui-kit'}>
      {questions.map((q, qIdx) => {
        const hasSplit = questionHasPreview(q);
        const dispOpts = dispOptions[qIdx];
        const focused = focusedIdx[qIdx] ?? 0;
        const focusedOpt = dispOpts[focused];
        const qSels = selections[qIdx];

        return (
          <div className="question" key={qIdx}>
            {q.header ? <div className="q-header">{q.header}</div> : null}
            <div className="q-text">{q.question}</div>
            {q.multiSelect ? <div className="q-hint">select one or more</div> : null}

            {hasSplit ? (
              <div className="ask-split">
                <div
                  className="ask-split-list"
                  role="listbox"
                  aria-multiselectable={!!q.multiSelect}
                  aria-label={q.question}
                >
                  {dispOpts.map((opt, oIdx) => {
                    const selected = qSels?.has(opt.label);
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
                        onMouseEnter={() =>
                          setFocusedIdx((prev) => {
                            const next = [...prev];
                            next[qIdx] = oIdx;
                            return next;
                          })
                        }
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
                            moveFocus(qIdx, 1, dispOpts.length);
                          } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            moveFocus(qIdx, -1, dispOpts.length);
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
                {dispOpts.map((opt) => {
                  const on = qSels?.has(opt.label);
                  const isFree = isFreeTextOption(opt.label);
                  return (
                    <button
                      type="button"
                      key={opt.label}
                      className="option-btn"
                      data-on={on ? 'true' : 'false'}
                      aria-pressed={isFree ? undefined : on}
                      disabled={submitting}
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

      <div className="ask-inline-foot">
        <button type="button" className="btn-primary" disabled={!ready || submitting} onClick={submit}>
          {submitting ? <span className="working-spinner" aria-label="sending" /> : submitLabel}
        </button>
      </div>
    </div>
  );
}
