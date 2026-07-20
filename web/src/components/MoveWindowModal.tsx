import { useMemo, useState } from 'react';
import type { Session } from '../lib/types';
import { useModalTransition } from '../lib/anim';

interface MoveWindowModalProps {
  source: Session;
  /** Destination tmux session pre-picked by the rail drag-and-drop path —
   *  skips the picker and renders a direct one-line confirm sentence instead. */
  presetDest?: string;
  /** Full live session list — candidate destinations are every OTHER distinct
   *  tmux session name present here (the source's own session is excluded so
   *  a no-op move can never be offered). */
  sessions: Session[];
  onConfirm: (destSessionName: string) => void;
  onClose: () => void;
  onToast: (text: string, kind?: 'ok' | 'error' | '') => void;
}

/**
 * Confirm step for moving a tmux WINDOW (this client session's pane) to
 * another tmux SESSION. Gates BOTH entry points — the Cmd+K palette action
 * (no presetDest, shows a destination picker) and rail drag-and-drop (a
 * presetDest already chosen by the drop target, shows a direct sentence) —
 * before the 'move-window' op is ever sent. Modeled on PinModal: same
 * `.modal-backdrop`/`.modal` shell + useModalTransition enter/exit.
 */
export function MoveWindowModal({
  source,
  presetDest,
  sessions,
  onConfirm,
  onClose: rawClose,
  onToast,
}: MoveWindowModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);

  const candidates = useMemo(() => {
    const names = new Set<string>();
    for (const s of sessions) {
      if (s.sessionName && s.sessionName !== source.sessionName) names.add(s.sessionName);
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [sessions, source.sessionName]);

  const [selected, setSelected] = useState<string>(() => presetDest ?? candidates[0] ?? '');

  const dest = presetDest ?? selected;
  const confirmDisabled = !dest;
  const sourceLabel = source.name || source.id;

  const confirm = () => {
    if (!dest) {
      onToast('Pick a destination session first', 'error');
      return;
    }
    onConfirm(dest);
    onClose();
  };

  return (
    <div
      className="modal-backdrop move-window-modal"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="modal-title">Move window</span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          {presetDest ? (
            <p className="move-window-sentence">
              Move <strong>{sourceLabel}</strong> from <strong>{source.sessionName ?? '?'}</strong> to{' '}
              <strong>{presetDest}</strong>?
            </p>
          ) : (
            <>
              <p className="move-window-sentence">
                Move <strong>{sourceLabel}</strong> from <strong>{source.sessionName ?? '?'}</strong> to:
              </p>
              <select
                className="move-window-select"
                aria-label="Destination tmux session"
                value={selected}
                disabled={candidates.length === 0}
                onChange={(e) => setSelected(e.target.value)}
              >
                {candidates.length === 0 ? (
                  <option value="">no other sessions</option>
                ) : (
                  candidates.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))
                )}
              </select>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn-primary" disabled={confirmDisabled} onClick={confirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
