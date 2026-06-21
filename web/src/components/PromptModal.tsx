import { useEffect, useMemo, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import { Kbd } from './Kbd';
import type { PanePrompt } from '../lib/types';
import { useModalTransition } from '../lib/anim';

interface PromptModalProps {
  prompt: PanePrompt;
  onKey: (key: string) => void;
  /** Called when the user confirms a multi-select prompt; receives the selected labels. */
  onSelect?: (labels: string[]) => void;
  onClose: () => void;
  /** When the prompt is a plan approval, the plan markdown to render for review. */
  planMarkdown?: string | null;
  /** Display name of the agent that raised the prompt (e.g. "Claude", "Codex"). */
  agentName?: string;
}

const messageComponents = {
  UserMessage,
  AssistantMessage,
  SystemMessage: AssistantMessage,
} as const;

/**
 * Render the plan as rich markdown using the SAME renderer as the chat (so
 * headings, lists, tables, fenced code all read properly) before the user is
 * asked to approve. A throwaway read-only runtime holds a single assistant
 * message = the plan text.
 */
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

/**
 * Live TUI selection prompt (permission / plan approval / numbered menu) detected
 * from the pane. Selection and submission are separated (separation of concern):
 * clicking an option only *selects* it (number keys 1-9 select too); the choice
 * is sent only when the user hits Confirm (or Enter). This prevents an accidental
 * tap from instantly approving a plan. For plan approvals we first render the full
 * plan as markdown (scrollable) and put the approval options at the very bottom,
 * so the plan can be reviewed before deciding.
 *
 * When `prompt.multiSelect` is true the options render as toggle buttons (checkbox
 * style). Confirm calls `onSelect(labels)` instead of `onKey`. The single-select
 * and plan-approval paths are byte-for-byte unchanged.
 */
export function PromptModal({
  prompt,
  onKey,
  onSelect,
  onClose: rawClose,
  planMarkdown,
  agentName = 'Claude',
}: PromptModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);
  const isMulti = !!prompt.multiSelect;

  // ── Single-select state ───────────────────────────────────────────────────
  // The TUI's own highlighted option is the initial selection; first option as
  // a fallback so Confirm always has a target.
  const defaultKey = useMemo(() => {
    if (isMulti) return null;
    const pre = prompt.options.find((o) => o.selected);
    return pre?.key ?? prompt.options[0]?.key ?? null;
  }, [prompt, isMulti]);

  const [selectedKey, setSelectedKey] = useState<string | null>(defaultKey);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // ── Multi-select state ────────────────────────────────────────────────────
  // Initialised from each option's `checked` field (already-checked in TUI).
  const initMultiSelected = useMemo(
    () => new Set(prompt.options.filter((o) => o.checked).map((o) => o.label)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(prompt)],
  );
  const [multiSelected, setMultiSelected] = useState<Set<string>>(initMultiSelected);
  const [multiSending, setMultiSending] = useState(false);

  const sig = JSON.stringify(prompt);
  useEffect(() => {
    if (!isMulti) {
      setSelectedKey(defaultKey);
      setPendingKey(null);
    } else {
      setMultiSelected(initMultiSelected);
      setMultiSending(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, defaultKey, isMulti]);

  // ── Single-select submit ──────────────────────────────────────────────────
  const submitSingle = (key: string) => {
    if (pendingKey) return;
    setPendingKey(key);
    onKey(key);
  };
  const confirmSingle = () => {
    if (selectedKey) submitSingle(selectedKey);
  };

  // ── Multi-select toggle + submit ──────────────────────────────────────────
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
    onSelect?.([...multiSelected]);
  };

  // ── Keyboard handling ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isMulti) {
        if (multiSending) return;
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        if (e.key === 'Enter') { e.preventDefault(); confirmMulti(); return; }
        // Number keys 1-9 TOGGLE the matching option in multi mode.
        const opt = prompt.options.find((o) => o.key === e.key);
        if (opt) { e.preventDefault(); toggleMulti(opt.label); }
      } else {
        if (pendingKey) return; // already submitting
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (selectedKey) submitSingle(selectedKey); return; }
        // Number keys 1-9 select the matching option (don't submit).
        if (prompt.options.some((o) => o.key === e.key)) {
          e.preventDefault();
          setSelectedKey(e.key);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, pendingKey, selectedKey, sig, isMulti, multiSending, multiSelected]);

  const sending = isMulti ? multiSending : pendingKey !== null;
  const isPlan = !!planMarkdown;

  return (
    <div
      className="modal-backdrop"
      ref={rootRef}
      onClick={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div
        className={isPlan ? 'modal modal-plan' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-label={isPlan ? 'Review plan' : 'Terminal prompt'}
      >
        <div className="modal-head">
          <span className="modal-title">{isPlan ? 'Review plan' : `${agentName} needs a choice`}</span>
          <button type="button" className="modal-close" aria-label="Hide" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {isPlan ? <PlanReview markdown={planMarkdown as string} /> : null}

          <div className="question">
            {!isPlan ? <div className="q-text">{prompt.question}</div> : null}
            {isMulti ? <div className="q-hint">select one or more</div> : null}

            {isMulti ? (
              <div className="q-options" aria-label="Options">
                {prompt.options.map((opt) => {
                  const on = multiSelected.has(opt.label);
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
                      <span className="option-label">
                        {opt.key}. {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="q-options" role="radiogroup" aria-label="Options">
                {prompt.options.map((opt) => (
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
                    <span className="option-label">
                      {opt.key}. {opt.label}
                    </span>
                    {pendingKey === opt.key ? (
                      <span className="option-sending" aria-live="polite">
                        <span className="working-spinner" aria-hidden="true" /> sending…
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn-secondary"
            disabled={sending}
            onClick={() => (isMulti ? onClose() : submitSingle('Escape'))}
          >
            Cancel <Kbd>Esc</Kbd>
          </button>
          <span className="modal-foot-spacer" />
          {sending ? <span className="prompt-status">submitting your answer…</span> : null}
          <button
            type="button"
            className="btn-primary"
            disabled={sending || (isMulti ? multiSelected.size === 0 : !selectedKey)}
            onClick={isMulti ? confirmMulti : confirmSingle}
          >
            Confirm <Kbd>↵</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
