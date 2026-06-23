import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import gsap, { ANIM, prefersReducedMotion } from '../lib/anim';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import type { Pending, PendingQuestion, PendingOption, PanePrompt } from '../lib/types';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ActivePrompt =
  | { kind: 'ask'; pending: Pending }
  | {
      kind: 'prompt';
      prompt: PanePrompt;
      planMarkdown: string | null;
      agentName: string;
    };

export interface AskInlineProps {
  activePrompt: ActivePrompt | null;
  /** Ref passed down from Composer so the morph driver can read/write display. */
  bodyRef: React.RefObject<HTMLDivElement>;
  onAnswer: (toolUseId: string, selections: string[][]) => void;
  onKey: (key: string) => void;
  onSelect: (labels: string[]) => void;
  /** Called to send a normal freeform reply (for "type something" options). */
  onReply: (text: string) => void;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

type Selections = Set<string>[];

function initSelections(pending: Pending): Selections {
  return pending.questions.map(() => new Set<string>());
}

/** True when any option in the question carries a preview string. */
export function questionHasPreview(q: PendingQuestion): boolean {
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
 * they are NOT in the structured tool input — so the structured render must add
 * them to match what the TUI shows. Both route to the free-text flow. Labels
 * mirror the TUI text so the answer navigation matches the live picker row.
 */
const SYNTHETIC_FREETEXT: PendingOption[] = [
  { label: 'Type something' },
  { label: 'Chat about this' },
];

/** Real options + the TUI's always-appended free-text rows (parity with the TUI,
 *  which appends these to EVERY AskUserQuestion picker regardless of content). */
function withFreeText(q: PendingQuestion): PendingOption[] {
  return [...q.options, ...SYNTHETIC_FREETEXT];
}

/**
 * Animate the ask body's height across a content swap (options ↔ free-text). The
 * card is auto-height and follows the body. A ResizeObserver can't do this — by
 * the time it fires the DOM already snapped — so we capture the height in the
 * click handler BEFORE setState, then FLIP from it after the re-render.
 * Returns `capture()` to call synchronously before the state change.
 */
function useHeightFlip(bodyRef: React.RefObject<HTMLElement>, dep: unknown) {
  const beforeRef = useRef<number | null>(null);
  const capture = () => {
    beforeRef.current = bodyRef.current?.offsetHeight ?? null;
  };
  useLayoutEffect(() => {
    const from = beforeRef.current;
    beforeRef.current = null;
    const body = bodyRef.current;
    if (from == null || !body || prefersReducedMotion()) return;
    body.style.height = 'auto';
    const to = body.offsetHeight;
    if (Math.abs(to - from) < 2) {
      body.style.height = '';
      return;
    }
    body.style.height = `${from}px`;
    void body.offsetHeight; // reflow so the tween starts from `from`
    gsap.to(body, {
      height: to,
      duration: 0.2,
      ease: ANIM.enterEase,
      onComplete: () => {
        body.style.height = '';
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
  return capture;
}

// ── PlanReview (shared renderer, matches PromptModal's) ───────────────────────

const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

function PlanReview({ markdown }: { markdown: string }) {
  const messages = useMemo<ThreadMessageLike[]>(
    () => [
      {
        role: 'assistant',
        id: 'plan',
        content: [{ type: 'text', text: markdown }],
        metadata: { custom: { cockpitRole: 'assistant' } },
      } as ThreadMessageLike,
    ],
    [markdown],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    isDisabled: true,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="plan-review">
        <ThreadPrimitive.Viewport className="plan-review-viewport">
          <ThreadPrimitive.Messages components={messageComponents} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

// ── AskBody: renders the structured AskUserQuestion (kind='ask') ───────────────

interface AskBodyProps {
  pending: Pending;
  bodyRef: React.RefObject<HTMLDivElement>;
  onAnswer: (toolUseId: string, selections: string[][]) => void;
  onReply: (text: string) => void;
}

function AskBody({ pending, bodyRef, onAnswer, onReply }: AskBodyProps) {
  const [selections, setSelections] = useState<Selections>(() => initSelections(pending));
  const [focusedIdx, setFocusedIdx] = useState<number[]>(() =>
    pending.questions.map(() => 0),
  );
  // If a free-text option is selected, switch to textarea mode.
  const [freeTextQIdx, setFreeTextQIdx] = useState<number | null>(null);
  const [freeTextOptLabel, setFreeTextOptLabel] = useState<string>('');
  const [freeTextValue, setFreeTextValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flipHeight = useHeightFlip(bodyRef, freeTextQIdx);

  useEffect(() => {
    setSelections(initSelections(pending));
    setFocusedIdx(pending.questions.map(() => 0));
    setFreeTextQIdx(null);
    setFreeTextOptLabel('');
    setFreeTextValue('');
    setSubmitting(false);
  }, [pending]);

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
    onAnswer(pending.toolUseId, selections.map((s) => [...s]));
  };

  const submitFreeText = () => {
    const text = freeTextValue.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    // Include the free-text option label in selections for its question.
    if (freeTextQIdx !== null) {
      const sels = selections.map((s) => new Set(s));
      sels[freeTextQIdx] = new Set([freeTextOptLabel]);
      onAnswer(pending.toolUseId, sels.map((s) => [...s]));
    }
    onReply(text);
  };

  // Free-text mode: keep the question context (header) for consistency; the
  // chosen option becomes a header above a focused borderless textarea.
  if (freeTextQIdx !== null) {
    const fq = pending.questions[freeTextQIdx];
    const goBack = () => {
      flipHeight(); // animate the height back as the options return
      setFreeTextQIdx(null);
      setFreeTextOptLabel('');
      setFreeTextValue('');
    };
    return (
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
            {submitting ? (
              <span className="working-spinner" aria-label="sending" />
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {pending.questions.map((q, qIdx) => {
        const hasSplit = questionHasPreview(q);
        const dispOpts = withFreeText(q); // real options + TUI free-text rows
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
        <button
          type="button"
          className="btn-primary"
          disabled={!ready || submitting}
          onClick={submit}
        >
          {submitting ? (
            <span className="working-spinner" aria-label="sending" />
          ) : (
            'Send Answer'
          )}
        </button>
      </div>
    </>
  );
}

// ── PromptBody: renders PanePrompt (kind='prompt') ────────────────────────────

interface PromptBodyProps {
  prompt: PanePrompt;
  planMarkdown: string | null;
  agentName: string;
  bodyRef: React.RefObject<HTMLDivElement>;
  onKey: (key: string) => void;
  onSelect: (labels: string[]) => void;
  onReply: (text: string) => void;
}

function PromptBody({ prompt, planMarkdown, agentName, bodyRef, onKey, onSelect, onReply }: PromptBodyProps) {
  const isMulti = !!prompt.multiSelect;
  const isPlan = !!planMarkdown;

  const defaultKey = useMemo(() => {
    if (isMulti) return null;
    const pre = prompt.options.find((o) => o.selected);
    return pre?.key ?? prompt.options[0]?.key ?? null;
  }, [prompt, isMulti]);

  const [selectedKey, setSelectedKey] = useState<string | null>(defaultKey);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const initMultiSelected = useMemo(
    () => new Set(prompt.options.filter((o) => o.checked).map((o) => o.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(prompt)],
  );
  const [multiSelected, setMultiSelected] = useState<Set<string>>(initMultiSelected);
  const [multiSending, setMultiSending] = useState(false);

  // Free-text mode for prompt options.
  const [freeTextKey, setFreeTextKey] = useState<string | null>(null);
  const [freeTextValue, setFreeTextValue] = useState('');
  const [freeTextSending, setFreeTextSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flipHeight = useHeightFlip(bodyRef, freeTextKey);
  const freeTextLabel = useMemo(
    () => prompt.options.find((o) => o.key === freeTextKey)?.label ?? '',
    [prompt, freeTextKey],
  );

  const sig = JSON.stringify(prompt);
  useEffect(() => {
    if (!isMulti) {
      setSelectedKey(defaultKey);
      setPendingKey(null);
    } else {
      setMultiSelected(initMultiSelected);
      setMultiSending(false);
    }
    setFreeTextKey(null);
    setFreeTextValue('');
    setFreeTextSending(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, defaultKey, isMulti]);

  useEffect(() => {
    if (freeTextKey !== null) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        autoGrow(textareaRef.current);
      });
    }
  }, [freeTextKey]);

  const submitSingle = (key: string) => {
    if (pendingKey) return;
    setPendingKey(key);
    onKey(key);
  };

  const toggleMulti = (label: string) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const confirmMulti = () => {
    if (multiSending || multiSelected.size === 0) return;
    setMultiSending(true);
    onSelect([...multiSelected]);
  };

  // Keyboard: 1-9 select; Enter confirms.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (freeTextKey !== null) return; // textarea handles its own keys
      if (isMulti) {
        if (multiSending) return;
        if (e.key === 'Enter') { e.preventDefault(); confirmMulti(); return; }
        const opt = prompt.options.find((o) => o.key === e.key);
        if (opt) { e.preventDefault(); toggleMulti(opt.label); }
      } else {
        if (pendingKey) return;
        if (e.key === 'Enter') { e.preventDefault(); if (selectedKey) submitSingle(selectedKey); return; }
        if (prompt.options.some((o) => o.key === e.key)) {
          e.preventDefault();
          setSelectedKey(e.key);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freeTextKey, pendingKey, selectedKey, sig, isMulti, multiSending, multiSelected]);

  const sending = isMulti ? multiSending : pendingKey !== null;

  const submitFreeText = () => {
    const text = freeTextValue.trim();
    if (!text || !freeTextKey || freeTextSending) return;
    setFreeTextSending(true);
    onKey(freeTextKey);
    onReply(text);
  };

  // Free-text mode: keep the question context (header); the chosen option becomes
  // a header above a focused borderless textarea.
  if (freeTextKey !== null) {
    const goBack = () => {
      flipHeight();
      setFreeTextKey(null);
      setFreeTextValue('');
    };
    return (
      <div className="question ask-freetext-view">
        {!isPlan ? <div className="q-text">{`${agentName} needs a choice`}</div> : null}
        {!isPlan && prompt.question ? <div className="q-hint">{prompt.question}</div> : null}
        <div className="ask-freetext-chosen">{freeTextLabel}</div>
        <textarea
          ref={textareaRef}
          className="ask-inline-textarea"
          rows={3}
          value={freeTextValue}
          disabled={freeTextSending}
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
          <button
            type="button"
            className="btn-secondary"
            disabled={freeTextSending}
            onClick={goBack}
          >
            Back
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!freeTextValue.trim() || freeTextSending}
            onClick={submitFreeText}
          >
            {freeTextSending ? (
              <span className="working-spinner" aria-label="sending" />
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {isPlan ? <PlanReview markdown={planMarkdown as string} /> : null}

      <div className="question">
        {!isPlan ? (
          <div className="q-text">{`${agentName} needs a choice`}</div>
        ) : null}
        {!isPlan ? <div className="q-hint">{prompt.question}</div> : null}
        {isMulti ? <div className="q-hint">select one or more</div> : null}

        {isMulti ? (
          <div className="q-options" aria-label="Options">
            {prompt.options.map((opt) => {
              const on = multiSelected.has(opt.label);
              const isFree = isFreeTextOption(opt.label);
              if (isFree) {
                return (
                  <button
                    type="button"
                    key={opt.key}
                    className="option-btn"
                    disabled={sending}
                    onClick={() => { flipHeight(); setFreeTextKey(opt.key); }}
                  >
                    <span className="option-label">{opt.key}. {opt.label}</span>
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  key={opt.key}
                  className="option-btn"
                  aria-pressed={on}
                  data-on={on ? 'true' : 'false'}
                  disabled={sending}
                  onClick={() => toggleMulti(opt.label)}
                >
                  <span className="option-label">{opt.key}. {opt.label}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="q-options" role="radiogroup" aria-label="Options">
            {prompt.options.map((opt) => {
              const isFree = isFreeTextOption(opt.label);
              if (isFree) {
                return (
                  <button
                    type="button"
                    key={opt.key}
                    className="option-btn"
                    disabled={sending}
                    onClick={() => { flipHeight(); setFreeTextKey(opt.key); }}
                  >
                    <span className="option-label">{opt.key}. {opt.label}</span>
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  key={opt.key}
                  className="option-btn"
                  role="radio"
                  aria-checked={selectedKey === opt.key}
                  data-on={selectedKey === opt.key ? 'true' : 'false'}
                  data-sending={pendingKey === opt.key ? 'true' : undefined}
                  disabled={sending}
                  onClick={() => setSelectedKey(opt.key)}
                >
                  <span className="option-label">{opt.key}. {opt.label}</span>
                  {pendingKey === opt.key ? (
                    <span className="option-sending" aria-label="sending">
                      <span className="working-spinner" aria-hidden="true" />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="ask-inline-foot">
        <button
          type="button"
          className="btn-primary"
          disabled={sending || (isMulti ? multiSelected.size === 0 : !selectedKey)}
          onClick={isMulti ? confirmMulti : () => { if (selectedKey) submitSingle(selectedKey); }}
        >
          {sending ? (
            <span className="working-spinner" aria-label="sending" />
          ) : (
            'Confirm'
          )}
        </button>
      </div>
    </>
  );
}

// ── AskInline: the always-mounted shell ───────────────────────────────────────

/**
 * Always-mounted inline prompt shell — display:none when idle, revealed by the
 * Composer morph on `askActive`. Renders either a structured AskUserQuestion
 * (kind='ask') or a PanePrompt (kind='prompt'). Non-dismissible: no Esc, no ✕.
 * Cleared only when the server nulls pending/prompt.
 */
export function AskInline({
  activePrompt,
  bodyRef,
  onAnswer,
  onKey,
  onSelect,
  onReply,
}: AskInlineProps) {
  return (
    <div className="ask-inline-body" ref={bodyRef}>
      {activePrompt?.kind === 'ask' ? (
        <AskBody
          key={activePrompt.pending.toolUseId}
          pending={activePrompt.pending}
          bodyRef={bodyRef}
          onAnswer={onAnswer}
          onReply={onReply}
        />
      ) : activePrompt?.kind === 'prompt' ? (
        <PromptBody
          key={JSON.stringify(activePrompt.prompt)}
          prompt={activePrompt.prompt}
          planMarkdown={activePrompt.planMarkdown}
          agentName={activePrompt.agentName}
          bodyRef={bodyRef}
          onKey={onKey}
          onSelect={onSelect}
          onReply={onReply}
        />
      ) : null}
    </div>
  );
}
