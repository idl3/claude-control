import { useEffect, useMemo, useRef, useState } from 'react';
import { AskQuestionForm, isFreeTextOption, useHeightFlip } from '@idl3/agent-ui-kit';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import type { AnswerSelection, Pending, PanePrompt } from '../lib/types';
import { FLAG_PENDING_TOOL_USE_ID } from '../lib/answerSettle';

// The structured-ask renderer now lives in @idl3/agent-ui-kit; re-export its
// helpers so existing imports (tests, AskModal suite) keep working.
export { questionHasPreview } from '@idl3/agent-ui-kit';
export { isFreeTextOption };

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
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onAnswer: (toolUseId: string, selections: AnswerSelection[]) => void;
  onKey: (key: string) => void;
  onSelect: (labels: string[]) => void;
  /** Called to send a normal freeform reply (for "type something" options). */
  onReply: (text: string) => void;
  /**
   * Dismiss the current question WITHOUT answering it — sends nothing over the
   * wire, purely hides a stale dialog (e.g. the session errored/hit a usage
   * limit and the question can no longer be answered). Must never be wired to
   * onAnswer/onReply.
   */
  onDismiss: () => void;
  /** True when the selected session hit an API error and stalled (rate limit /
   *  overload / 5xx) — the question can no longer be delivered. Shows an
   *  inline note and makes the Dismiss control prominent. */
  errored?: boolean;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** Grow a textarea to fit its content (capped by the CSS max-height → scrolls). */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
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

// ── PromptBody: renders PanePrompt (kind='prompt') ────────────────────────────

interface PromptBodyProps {
  prompt: PanePrompt;
  planMarkdown: string | null;
  agentName: string;
  bodyRef: React.RefObject<HTMLDivElement | null>;
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
                  {opt.description ? (
                    <span className="option-desc">{opt.description}</span>
                  ) : null}
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
                  {opt.description ? (
                    <span className="option-desc">{opt.description}</span>
                  ) : null}
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
 * (kind='ask') or a PanePrompt (kind='prompt'). Normally cleared only when the
 * server nulls pending/prompt; the header's Dismiss control (×) is the escape
 * hatch for a STALE question the server keeps re-reporting (e.g. the session
 * errored and can no longer deliver an answer) — it hides the dialog locally
 * without sending anything.
 */
/** Short header shown on the minimized yellow bar. */
export function promptHeader(p: ActivePrompt | null): string {
  if (p?.kind === 'ask') {
    const q = p.pending.questions[0];
    return q?.header || q?.question || 'Question';
  }
  if (p?.kind === 'prompt') {
    return p.prompt.question || `${p.agentName} needs a choice`;
  }
  return '';
}

export function AskInline({
  activePrompt,
  bodyRef,
  onAnswer,
  onKey,
  onSelect,
  onReply,
  onDismiss,
  errored = false,
}: AskInlineProps) {
  // Minimize: collapse the whole question to a single yellow bar so the
  // transcript is fully visible while you process the context. Reset whenever a
  // new prompt arrives so a fresh question always opens expanded.
  const [minimized, setMinimized] = useState(false);
  const flipHeight = useHeightFlip(bodyRef, minimized);
  const promptKey =
    activePrompt?.kind === 'ask'
      ? activePrompt.pending.toolUseId
      : activePrompt?.kind === 'prompt'
        ? JSON.stringify(activePrompt.prompt)
        : null;
  useEffect(() => {
    setMinimized(false);
  }, [promptKey]);

  const minimize = () => {
    flipHeight();
    setMinimized(true);
  };
  const maximize = () => {
    flipHeight();
    setMinimized(false);
  };

  return (
    <div className="ask-inline-body" ref={bodyRef}>
      {activePrompt && minimized ? (
        <button type="button" className="ask-min-bar" onClick={maximize} aria-label="Maximise question">
          <span className="ask-min-q">{promptHeader(activePrompt)}</span>
          <span className="ask-min-action">Maximise</span>
        </button>
      ) : activePrompt ? (
        /* agent-ui-kit scope: PromptBody reuses the kit's base classes
           (.question, .option-btn, free-text view), so the host opts this
           subtree into the kit stylesheet; cockpit overrides still win by
           cascade order. */
        <div className="ask-inline-full agent-ui-kit">
          {/* Sticky, zero-height header: `.ask-inline-body` (the bodyRef div)
              is the actual overflow-y:auto scroller, so pinning the button
              needs `position: sticky` on something INSIDE it, not `fixed` —
              `.ask-inline-full` itself is a normal in-flow child of that
              scroller, so the old plain `position: absolute` button (relative
              to `.ask-inline-full`) scrolled away with the rest of the
              question. This wrapper sticks to the scroller's top edge;
              height:0 + overflow:visible keeps it from adding layout height
              or pushing the question content down. */}
          <div className="ask-min-header">
            <button
              type="button"
              className="ask-dismiss-btn"
              data-prominent={errored ? 'true' : undefined}
              aria-label="Dismiss question"
              title="Dismiss (does not answer)"
              onClick={onDismiss}
            >
              ×
            </button>
            <button
              type="button"
              className="ask-min-btn"
              aria-label="Minimise question"
              title="Minimise"
              onClick={minimize}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          {errored ? (
            <div className="ask-errored-note" role="alert">
              <span>
                This session hit a usage limit — the answer can&rsquo;t be delivered. You can dismiss this question.
              </span>
              <button type="button" className="ask-errored-dismiss" onClick={onDismiss}>
                Dismiss
              </button>
            </div>
          ) : null}
          {activePrompt.kind === 'ask' ? (
            <AskQuestionForm
              key={activePrompt.pending.toolUseId}
              questions={activePrompt.pending.questions}
              onSubmit={(answers) => onAnswer(activePrompt.pending.toolUseId, answers)}
              // Synthesized (tailer-less) ask: the server has no real pending to
              // navigate for the sentinel toolUseId, so free-text routes through
              // the plain reply path instead of a structured directive.
              onFreeTextReply={
                activePrompt.pending.toolUseId === FLAG_PENDING_TOOL_USE_ID ? onReply : undefined
              }
              flipContainerRef={bodyRef}
            />
          ) : (
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
          )}
        </div>
      ) : null}
    </div>
  );
}
