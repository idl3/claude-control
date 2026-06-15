import { useEffect } from 'react';
import type { PanePrompt } from '../lib/types';

interface PromptModalProps {
  prompt: PanePrompt;
  onKey: (key: string) => void;
  onClose: () => void;
}

/**
 * Live TUI selection prompt (permission / trust / numbered menu) detected from
 * the pane. Tapping an option sends its number key; Esc sends Escape (cancel).
 * This is what unblocks a session that's waiting on "Do you want to proceed?"
 * — those prompts never reach the transcript, so the cockpit can't show them
 * otherwise and the session looks stuck.
 */
export function PromptModal({ prompt, onKey, onClose }: PromptModalProps) {
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

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
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
                  onClick={() => onKey(opt.key)}
                >
                  <span className="option-label">
                    {opt.key}. {opt.label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onKey('Escape')}
          >
            cancel (Esc)
          </button>
          <span className="modal-foot-spacer" />
        </div>
      </div>
    </div>
  );
}
