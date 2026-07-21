import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import { uploadFile } from './api';

// Files Claude can usefully read: images, PDF, and any text-ish file.
export const ATTACH_ACCEPT = 'image/*,application/pdf,text/*,.md,.json,.csv,.log';

/**
 * Whether a dropped/picked file matches an HTML `accept` list. The native
 * `<input accept>` filters the file picker, but drag-and-drop has no such gate,
 * so the composer's drop handler screens files with this before uploading.
 *
 * Supports the three token shapes in ATTACH_ACCEPT:
 *   - extension: `.md` → matches by filename suffix (covers files the OS gives
 *     an empty/odd MIME type, e.g. .log)
 *   - wildcard:  `image/*` / `text/*` → matches by MIME prefix
 *   - exact MIME: `application/pdf`
 * An empty accept list accepts everything (mirrors a missing `accept` attr).
 */
export function acceptsFile(file: File, accept: string = ATTACH_ACCEPT): boolean {
  const patterns = accept
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1)); // keep "image/"
    return type === pattern;
  });
}

// Reserved key on a completed attachment's content text part carrying the
// uploaded absolute server path. onNew reads it back to build the reply text.
const PATH_PREFIX = ' cockpit-path:';

export function encodePath(path: string): string {
  return PATH_PREFIX + path;
}

// id -> uploaded absolute server path. Populated in `add` (upload happens
// eagerly so the chip shows an "uploaded" state immediately), read in `send`
// and as a fallback in onNew. Cleared in `remove`.
const uploadedPaths = new Map<string, string>();

/** Uploaded absolute path for a composer attachment id, if any. */
export function pathForId(id: string): string | null {
  return uploadedPaths.get(id) ?? null;
}

/** Pull the uploaded absolute path out of a completed attachment, if any. */
export function attachmentPath(att: CompleteAttachment): string | null {
  for (const part of att.content ?? []) {
    if (part.type === 'text' && part.text.startsWith(PATH_PREFIX)) {
      return part.text.slice(PATH_PREFIX.length);
    }
  }
  // Fallback: the path stashed at add-time (robust if the runtime didn't
  // thread the send() content into onNew's message.attachments).
  return pathForId(att.id);
}

type ToastFn = (msg: string, kind?: 'ok' | 'error') => void;

function attachmentId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

/**
 * Composer attachment adapter wired to the claude-control upload endpoint.
 *
 * Upload happens EAGERLY in `add` (not deferred to send) so the chip reaches a
 * `complete` (uploaded) state with a thumbnail immediately — no perpetual
 * "uploading" spinner. The returned PendingAttachment keeps its `file` so the
 * composer renders an image thumbnail. `send` then wraps the already-uploaded
 * path into the message content (also kept in `uploadedPaths` as a fallback).
 *
 * Trade-off: a file removed before send was still uploaded; the server's TTL
 * sweep (`sweepUploads`) reclaims orphans, so this is harmless and the UX win
 * (instant uploaded state) is worth it.
 */
export function createClaudeControlAttachmentAdapter(
  onToast: ToastFn,
): AttachmentAdapter {
  return {
    accept: ATTACH_ACCEPT,

    async add({ file }: { file: File }): Promise<PendingAttachment> {
      const id = attachmentId(file);
      const isImage = file.type.startsWith('image/');
      const isPdf = file.type === 'application/pdf';
      const base = {
        id,
        type: (isImage ? 'image' : isPdf ? 'document' : 'file') as
          | 'image'
          | 'document'
          | 'file',
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        file,
      };
      onToast(`Uploading ${file.name}…`);
      try {
        const res = await uploadFile(file);
        uploadedPaths.set(id, res.path);
        onToast(`Attached ${res.name}`, 'ok');
        // The upload already finished (we awaited it), so the chip should show
        // the uploaded thumbnail, NOT a spinner. A composer attachment can't be
        // `complete` (that's post-send) — `requires-action` is the "ready, will
        // send on submit" state; the chip treats anything that isn't `running`
        // as uploaded. send() threads the path into the message on submit.
        return { ...base, status: { type: 'requires-action', reason: 'composer-send' } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onToast(`Attach failed: ${msg}`, 'error');
        // Leave it actionable (remove + retry); never 'complete' when it isn't.
        return { ...base, status: { type: 'incomplete', reason: 'error' } };
      }
    },

    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
      const path = uploadedPaths.get(attachment.id);
      if (!path) {
        throw new Error(`attachment ${attachment.name} was not uploaded`);
      }
      return {
        ...attachment,
        status: { type: 'complete' },
        content: [{ type: 'text', text: encodePath(path) }],
      };
    },

    async remove(attachment: PendingAttachment): Promise<void> {
      uploadedPaths.delete(attachment.id);
    },
  };
}
