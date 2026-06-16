import { useCallback, useEffect, useState } from 'react';
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  useComposerRuntime,
  type Attachment,
} from '@assistant-ui/react';
import { Kbd } from './Kbd';
import { optimizePrompt, type OptimizeResult } from '../lib/api';
import { OptimizeReview } from './OptimizeReview';
import { SkillBrowser } from './SkillBrowser';

interface ComposerProps {
  disabled: boolean;
  /** Active session id — used to scope the enhance/review state so an
   *  improvement from one session can't leak into another on switch. */
  sessionId?: string | null;
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
/** Per-session enhance state: an in-progress flag + a ready review. */
type EnhanceState = {
  optimizing: boolean;
  review: (OptimizeResult & { original: string }) | null;
};
const EMPTY_ENHANCE: EnhanceState = { optimizing: false, review: null };

export function Composer({ disabled, sessionId }: ComposerProps) {
  const composer = useComposerRuntime();
  const [empty, setEmpty] = useState(true);
  const [skillBrowserOpen, setSkillBrowserOpen] = useState(false);
  // Enhance state BOUND PER SESSION (keyed by session id), like the per-session
  // AskUserQuestion pending state. The Composer stays mounted across session
  // switches, so this map persists: switching away preserves an in-progress or
  // ready improvement, switching back restores it, and an improvement can never
  // leak into (or be accepted onto) a different session.
  const [enhanceBySession, setEnhanceBySession] = useState<Record<string, EnhanceState>>({});
  const key = sessionId ?? '';
  const { optimizing, review } = enhanceBySession[key] ?? EMPTY_ENHANCE;

  const patchEnhance = useCallback((sid: string, patch: Partial<EnhanceState>) => {
    setEnhanceBySession((m) => ({ ...m, [sid]: { ...(m[sid] ?? EMPTY_ENHANCE), ...patch } }));
  }, []);

  useEffect(
    () => composer.subscribe(() => setEmpty(!(composer.getState().text ?? '').trim())),
    [composer],
  );

  // Close the (session-agnostic) skill browser on a session switch.
  useEffect(() => {
    setSkillBrowserOpen(false);
  }, [sessionId]);

  const pickSkill = useCallback(
    (name: string) => {
      composer.setText(`/${name} `);
      setSkillBrowserOpen(false);
      // Return focus to the composer input so the user can add args and send.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>('.composer-input');
        el?.focus();
      });
    },
    [composer],
  );

  const runEnhance = useCallback(async () => {
    if (disabled || optimizing) return;
    const original = composer.getState().text ?? '';
    if (!original.trim()) return;
    const sid = key; // the session this enhancement belongs to
    patchEnhance(sid, { optimizing: true });
    try {
      const result = await optimizePrompt(original);
      // Store the review UNDER ITS SESSION — if the user switched away, it waits
      // there until they return; it never appears on the wrong session.
      patchEnhance(sid, { optimizing: false, review: { ...result, original } });
    } catch {
      patchEnhance(sid, { optimizing: false });
    }
  }, [composer, disabled, optimizing, key, patchEnhance]);

  return (
    <ComposerPrimitive.Root className="composer">
      {/* Centered card (max-width on desktop): input on top, attachments below,
          then a toolbar with attach on the left and send on the right. */}
      <div className="composer-card">
        {/* Placeholder needs the Kbd component, but a native placeholder is
            text-only — so use a space placeholder (keeps :placeholder-shown
            working + invisible) and overlay a hint shown only while empty. */}
        <div className="composer-input-wrap">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder={disabled ? 'Select a session…' : ' '}
            submitOnEnter={false}
            onKeyDown={(e) => {
              // Enter inserts a newline; ⌘/Ctrl+Enter sends.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!disabled && !optimizing) composer.send();
              }
              // ⌘/Ctrl+O triggers the enhance button.
              if (e.key.toLowerCase() === 'o' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runEnhance();
              }
            }}
            rows={1}
            disabled={disabled}
            autoComplete="off"
          />
          {!disabled ? (
            <div className="composer-hint" aria-hidden="true">
              <span className="composer-hint-lead">Reply…</span>
              <span className="composer-hint-keys">
                <Kbd>⌘/Ctrl+↵</Kbd> to send
                <span className="composer-hint-dot">·</span>
                <Kbd>↵</Kbd> newline
              </span>
            </div>
          ) : null}
        </div>

        {/* children render form: invoked once per composer attachment. */}
        <div className="composer-attachments">
          <ComposerPrimitive.Attachments>
            {({ attachment }) => <AttachmentChip attachment={attachment} />}
          </ComposerPrimitive.Attachments>
        </div>

        <div className="composer-toolbar">
          <ComposerPrimitive.AddAttachment
            className="composer-attach"
            aria-label="Attach a file"
            title="Attach a file"
            multiple
            disabled={disabled}
          >
            <PlusIcon />
          </ComposerPrimitive.AddAttachment>
          <button
            type="button"
            className="composer-skills-btn"
            aria-label="Browse skills"
            title="Browse skills"
            disabled={disabled}
            onClick={() => setSkillBrowserOpen((v) => !v)}
          >
            <SlashIcon />
          </button>
          <span className="composer-toolbar-spacer" />
          <button
            type="button"
            className="composer-enhance"
            aria-label="Enhance prompt"
            title="Enhance prompt (⌘/Ctrl+O)"
            disabled={disabled || optimizing || empty}
            onClick={() => void runEnhance()}
          >
            {optimizing ? (
              <span className="composer-enhance-spinner" aria-hidden="true" />
            ) : (
              <SparkleIcon />
            )}
          </button>
          <ComposerPrimitive.Send
            className="composer-send"
            aria-label="Send reply"
            disabled={disabled || optimizing}
          >
            <ArrowUpIcon />
          </ComposerPrimitive.Send>
        </div>
      </div>
      {review ? (
        <OptimizeReview
          original={review.original}
          result={review}
          onAccept={(text) => {
            composer.setText(text);
            patchEnhance(key, { review: null });
          }}
          onClose={() => patchEnhance(key, { review: null })}
        />
      ) : null}
      {skillBrowserOpen ? (
        <SkillBrowser
          onPick={pickSkill}
          onClose={() => setSkillBrowserOpen(false)}
        />
      ) : null}
    </ComposerPrimitive.Root>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M6 11l6-6 6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SlashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 20L17 4"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* 4-point sparkle: vertical diamond + horizontal diamond */}
      <path
        d="M12 2 L13.5 9.5 L21 11 L13.5 12.5 L12 20 L10.5 12.5 L3 11 L10.5 9.5 Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path
        d="M19 2 L19.8 4.2 L22 5 L19.8 5.8 L19 8 L18.2 5.8 L16 5 L18.2 4.2 Z"
        fill="currentColor"
        opacity="0.6"
      />
    </svg>
  );
}
