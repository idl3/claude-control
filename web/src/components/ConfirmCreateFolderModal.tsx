import { useModalTransition } from '../lib/anim';

interface ConfirmCreateFolderModalProps {
  /** The working directory that does not exist yet (as the user typed it). */
  cwd: string;
  /** Confirmed — create the folder and retry the session launch. */
  onConfirm: () => void;
  /** Dismissed — leave the draft open, folder untouched. */
  onClose: () => void;
}

/**
 * Confirm step for creating a missing working directory. Raised when
 * POST /api/session/new comes back with code:'cwd_missing' (the folder the
 * user picked doesn't exist). Confirming re-sends the create with
 * `createCwd: true`, which mkdir -p's the folder server-side before launching.
 * Modeled on MoveWindowModal: same `.modal-backdrop`/`.modal` shell +
 * useModalTransition enter/exit.
 */
export function ConfirmCreateFolderModal({
  cwd,
  onConfirm,
  onClose: rawClose,
}: ConfirmCreateFolderModalProps) {
  const { rootRef, requestClose: onClose } = useModalTransition(rawClose);

  const confirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <div
      className="modal-backdrop confirm-create-folder-modal"
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="modal-title">Create folder?</span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className="move-window-sentence">
            Folder <strong>{cwd}</strong> doesn&rsquo;t exist — create it?
          </p>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <span className="modal-foot-spacer" />
          <button type="button" className="btn-primary" onClick={confirm}>
            Create &amp; launch
          </button>
        </div>
      </div>
    </div>
  );
}
