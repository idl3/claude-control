import { useEffect, useMemo, useState } from 'react';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { AssistantMessage, UserMessage } from './Messages';
import type { PanePrompt } from '../lib/types';

interface PromptModalProps {
  prompt: PanePrompt;
  onKey: (key: string) => void;
  onClose: () => void;
  /** When the prompt is a plan approval, the plan markdown to render for review. */
  planMarkdown?: string | null;
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
 * from the pane. Tapping an option sends its key — that single tap IS the submit
 * (no separate Confirm), so we show immediate "sending…" feedback and disable the
 * buttons to prevent a double-tap from sending twice. For plan approvals we first
 * render the full plan as markdown (scrollable) and put the approval options at
 * the very bottom, so the plan can be reviewed before deciding.
 */
export function PromptModal({ prompt, onKey, onClose, planMarkdown }: PromptModalProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const sig = JSON.stringify(prompt);
  useEffect(() => {
    setPendingKey(null);
  }, [sig]);

  const submit = (key: string) => {
    if (pendingKey) return;
    setPendingKey(key);
    onKey(key);
  };

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

  const sending = pendingKey !== null;
  const isPlan = !!planMarkdown;

  return (
    <div
      className="modal-backdrop"
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
          <span className="modal-title">{isPlan ? 'Review plan' : 'Claude needs a choice'}</span>
          <button type="button" className="modal-close" aria-label="Hide" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          {isPlan ? <PlanReview markdown={planMarkdown as string} /> : null}

          <div className="question">
            {!isPlan ? <div className="q-text">{prompt.question}</div> : null}
            <div className="q-options">
              {prompt.options.map((opt) => (
                <button
                  type="button"
                  key={opt.key}
                  className="option-btn"
                  data-on={opt.selected ? 'true' : 'false'}
                  data-sending={pendingKey === opt.key ? 'true' : undefined}
                  disabled={sending}
                  onClick={() => submit(opt.key)}
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
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn-secondary"
            disabled={sending}
            onClick={() => submit('Escape')}
          >
            cancel (Esc)
          </button>
          <span className="modal-foot-spacer" />
          {sending ? <span className="prompt-status">submitting your answer…</span> : null}
        </div>
      </div>
    </div>
  );
}
