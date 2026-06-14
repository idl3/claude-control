import { useEffect, useState } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  type Attachment,
} from '@assistant-ui/react';

interface ComposerProps {
  disabled: boolean;
}

// Image preview for an image attachment that still carries its File (pending),
// otherwise a placeholder. Object URLs are revoked on unmount.
function AttachmentThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!url) return <div className="chip-thumb chip-thumb-empty" />;
  // Tap the thumbnail to open the full image in a new tab (preview).
  return (
    <img
      className="chip-thumb"
      src={url}
      alt=""
      role="button"
      tabIndex={0}
      title="Open preview"
      onClick={() => window.open(url, '_blank', 'noopener')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.open(url, '_blank', 'noopener');
        }
      }}
    />
  );
}

// Composer attachment chip: image thumbnail for images, filename otherwise,
// with a remove button. Rendered inside ComposerPrimitive.Attachments, which
// provides each attachment's runtime context (so AttachmentPrimitive.Remove
// works).
function AttachmentChip({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.type === 'image';
  // The adapter uploads eagerly in add(), so by the time a chip renders the
  // upload is already done — show the spinner ONLY while genuinely running.
  // (Composer attachments are never `complete`; that status is post-send.)
  const uploading = attachment.status.type === 'running';
  return (
    <AttachmentPrimitive.Root className="attach-chip" data-pending={uploading}>
      {isImage && attachment.file ? (
        <AttachmentThumb file={attachment.file} />
      ) : (
        <span className="chip-icon" aria-hidden="true">
          {attachment.type === 'document' ? '📄' : '📎'}
        </span>
      )}
      <span className="chip-name" title={attachment.name}>
        {attachment.name}
      </span>
      {uploading ? <span className="chip-spinner" aria-hidden="true" /> : null}
      <AttachmentPrimitive.Remove
        className="chip-remove"
        aria-label={`Remove ${attachment.name}`}
      >
        ×
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

/**
 * assistant-ui composer wired to the cockpit:
 * - Enter sends (submitOnEnter), Shift+Enter inserts a newline.
 * - The reply send + "sent →" toast happen in App's onNew adapter (where the
 *   WS reply is dispatched); this just renders the UI.
 * - Attachments use assistant-ui's native attachment system: the 📎 button is
 *   ComposerPrimitive.AddAttachment (driven by the attachment adapter on the
 *   runtime), pending/uploaded files render as chips above the input, and on
 *   send onNew appends each attachment's uploaded absolute path to the reply
 *   text. Paths are NEVER injected into the textarea.
 */
export function Composer({ disabled }: ComposerProps) {
  return (
    <ComposerPrimitive.Root className="composer">
      {/* children render form: invoked once per composer attachment. */}
      <div className="composer-attachments">
        <ComposerPrimitive.Attachments>
          {({ attachment }) => <AttachmentChip attachment={attachment} />}
        </ComposerPrimitive.Attachments>
      </div>

      <div className="composer-row">
        <ComposerPrimitive.AddAttachment
          className="composer-attach"
          aria-label="Attach a file"
          title="Attach a file"
          multiple
          disabled={disabled}
        >
          📎
        </ComposerPrimitive.AddAttachment>
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={disabled ? 'select a session…' : 'reply…  (Enter for newline · ↑ to send)'}
          submitOnEnter={false}
          rows={1}
          disabled={disabled}
          autoComplete="off"
        />
        <ComposerPrimitive.Send
          className="composer-send"
          aria-label="Send reply"
          disabled={disabled}
        >
          ↑
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}
