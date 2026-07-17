// Shared, purely-presentational composer action-bar buttons: exact className +
// icon + a11y markup for the [attach] [mic] [raw-send] [send] cluster, so the
// live session composer (Composer.tsx) and the new-session draft
// (NewSessionDraft.tsx) render byte-identical chrome from ONE place instead of
// forking the markup/CSS per caller. Each leaf is driven entirely by props —
// no runtime coupling, no shared state — callers wire their own handlers.
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { PlusIcon, MicIcon, ArrowUpIcon, SparkleIcon } from './icons';

interface ComposerActionButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  ariaLabel: string;
  /** Rendered as data-hotkey, matching the toolbar's other hotkey badges. */
  dataHotkey?: string;
}

/**
 * Attach — leftmost. The LIVE composer doesn't render this directly: it
 * passes it to `ComposerPrimitive.AddAttachment`'s `render` prop, which
 * (via Radix Slot/asChild) clones this element and merges its own
 * onClick/disabled/aria props onto it — see Composer.tsx's usage. That's why
 * this accepts arbitrary passthrough props + a ref, unlike the other three
 * leaves below, which only ever receive plain handler props.
 */
export const ComposerAttachButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<'button'>>(
  function ComposerAttachButton({ className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={className ? `composer-attach ${className}` : 'composer-attach'}
        {...rest}
      >
        <PlusIcon />
      </button>
    );
  },
);

/** Voice input mic — sits just left of Raw Send. `active` is optional and
 *  purely visual (data-active pulse); the live composer never sets it. */
export function ComposerMicButton({
  onClick,
  disabled,
  title,
  ariaLabel,
  dataHotkey,
  active,
}: ComposerActionButtonProps & { active?: boolean }) {
  return (
    <button
      type="button"
      className="composer-mic"
      aria-label={ariaLabel}
      aria-pressed={active}
      title={title}
      disabled={disabled}
      data-hotkey={dataHotkey}
      data-active={active ? 'true' : undefined}
      onClick={onClick}
    >
      <MicIcon />
    </button>
  );
}

/** Secondary send — skip the optimiser, send the raw composer text as-is. */
export function ComposerRawSendButton({ onClick, disabled, title, ariaLabel, dataHotkey }: ComposerActionButtonProps) {
  return (
    <button
      type="button"
      className="composer-enhance composer-bypass"
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      data-hotkey={dataHotkey}
      onClick={onClick}
    >
      <ArrowUpIcon />
    </button>
  );
}

interface ComposerSendButtonProps extends ComposerActionButtonProps {
  /** Show the spinner instead of the sparkle glyph. */
  busy?: boolean;
  /** Live composer defaults to 'button' (composer.send() owns submission);
   *  NewSessionDraft passes 'submit' so its <form>'s native submit path
   *  (Enter in a text field) keeps working unchanged. */
  type?: 'button' | 'submit';
}

/** Primary send — forwards its ref: the live composer pulses it (scale
 *  tween) while a prompt optimisation is in flight (see Composer.tsx's
 *  sendBtnRef effect). */
export const ComposerSendButton = forwardRef<HTMLButtonElement, ComposerSendButtonProps>(
  function ComposerSendButton({ onClick, disabled, title, ariaLabel, dataHotkey, busy, type }, ref) {
    return (
      <button
        ref={ref}
        type={type ?? 'button'}
        className="composer-send"
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        data-hotkey={dataHotkey}
        onClick={onClick}
      >
        {busy ? <span className="composer-enhance-spinner" aria-hidden="true" /> : <SparkleIcon />}
      </button>
    );
  },
);
