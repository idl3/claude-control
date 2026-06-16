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
 * from the pane. Selection and submission are separated (separation of concern):
 * clicking an option only *selects* it (number keys 1-9 select too); the choice
 * is sent only when the user hits Confirm (or Enter). This prevents an accidental
 * tap from instantly approving a plan. For plan approvals we first render the full
 * plan as markdown (scrollable) and put the approval options at the very bottom,
 * so the plan can be reviewed before deciding.
 */
export function PromptModal({ prompt, onKey, onClose, planMarkdown }: PromptModalProps) {
  // The TUI's own highlighted option is the initial selection; first option as
  // a fallback so Confirm always has a target.
  const defaultKey = useMemo(() => {
    const pre = prompt.options.find((o) => o.selected);
    return pre?.key ?? prompt.options[0]?.key ?? null;
  }, [prompt]);

  const [selectedKey, setSelectedKey] = useState<string | null>(defaultKey);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const sig = JSON.stringify(prompt);
  useEffect(() => {
    setSelectedKey(defaultKey);
    setPendingKey(null);
  }, [sig, defaultKey]);

  const submit = (key: string) => {
    if (pendingKey) return;
    setPendingKey(key);
    onKey(key);
  };
  const confirm = () => {
    if (selectedKey) submit(selectedKey);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (pendingKey) return; // already submitting
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedKey) submit(selectedKey);
        return;
      }
      // Number keys 1-9 select the matching option (don't submit).
      if (prompt.options.some((o) => o.key === e.key)) {
        e.preventDefault();
        setSelectedKey(e.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, pendingKey, selectedKey, sig]);

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
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn-secondary"
            disabled={sending}
            onClick={() => submit('Escape')}
          >
            Cancel <Kbd>Esc</Kbd>
          </button>
          <span className="modal-foot-spacer" />
          {sending ? <span className="prompt-status">submitting your answer…</span> : null}
          <button
            type="button"
            className="btn-primary"
            disabled={sending || !selectedKey}
            onClick={confirm}
          >
            Confirm <Kbd>↵</Kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
