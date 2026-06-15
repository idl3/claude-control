import { useEffect, useState } from 'react';
import type { PanePrompt } from '../lib/types';

interface PromptModalProps {
  prompt: PanePrompt;
  onKey: (key: string) => void;
  onClose: () => void;
}

/**
 * Live TUI selection prompt (permission / trust / numbered menu) detected from
 * the pane. Tapping an option sends its key — that single tap IS the submit
 * (no separate Confirm), so we show immediate "sending…" feedback and disable
 * the buttons to prevent a confused double-tap from sending the key twice. The
 * modal clears on its own once the server's pane poll sees the prompt resolve.
 * These prompts never reach the transcript, so this is the only way the cockpit
 * can surface them.
 */
export function PromptModal({ prompt, onKey, onClose }: PromptModalProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // Re-enable when a new/changed prompt arrives (server only re-broadcasts on
  // change), so a follow-up prompt isn't stuck disabled.
  const sig = JSON.stringify(prompt);
  useEffect(() => {
    setPendingKey(null);
  }, [sig]);

  const submit = (key: string) => {
    if (pendingKey) return; // guard: one submission per prompt
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

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Terminal prompt">
        <div className="modal-head">
          <span className="modal-title">Claude needs a choice</span>
          <button type="button" className="modal-close" aria-label="Hide" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="question">
            <div className="q-text">{prompt.question}</div>
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
