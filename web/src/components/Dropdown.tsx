import { useEffect, useId, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  /** Muted secondary line under the label (e.g. a full directory path). */
  caption?: string;
  /** Small muted inline tag after the label (e.g. "Default"). */
  badge?: string;
  disabled?: boolean;
  /** Tooltip shown on hover — typically the reason a disabled option is unavailable. */
  title?: string;
}

export interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Which edge of the trigger the menu's own edge aligns to. Defaults to 'left'. */
  menuAlign?: 'left' | 'right';
  /** Extra class(es) merged onto the trigger button, alongside the shared `.dropdown-trigger` chrome. */
  className?: string;
}

/**
 * Reusable custom dropdown — a button that opens an upward-anchored listbox
 * menu, replacing native `<select>` chrome so it can sit inside a dark
 * composer toolbar without OS-native styling. Opens UPWARD
 * (`bottom: calc(100% + 4px)` in styles.css) because every current caller
 * lives in a bottom-anchored composer toolbar, where a downward menu would
 * run off the viewport.
 *
 * Follows the ARIA "listbox button" pattern (not a native <select>, not a
 * combobox — there's no text filtering): the trigger is a real <button> with
 * `aria-haspopup="listbox"` + `aria-controls` + `aria-activedescendant`
 * tracking a highlighted (not yet committed) option, and the popup is a
 * `role="listbox"` of `role="option"` rows. Focus stays on the trigger the
 * entire time (options are not individually focusable) — this is what makes
 * aria-activedescendant the right tool here instead of roving tabindex.
 */
export function Dropdown({ value, options, onChange, disabled, ariaLabel, menuAlign = 'left', className }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIndex];

  // Close on outside pointerdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setHighlight(selectedIndex);
    setOpen(true);
  }

  function commit(index: number) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  }

  function moveHighlight(delta: number) {
    setHighlight((i) => {
      const count = options.length;
      if (count === 0) return i;
      let next = i;
      for (let step = 0; step < count; step++) {
        next = (next + delta + count) % count;
        if (!options[next]?.disabled) return next;
      }
      return i;
    });
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit(highlight);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${menuId}-opt-${i}`;

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className={`dropdown-trigger${className ? ` ${className}` : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? optionId(highlight) : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="dropdown-trigger-label">{selected?.label ?? ''}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <ul
          className="dropdown-menu"
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          data-align={menuAlign === 'right' ? 'right' : undefined}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={optionId(i)}
              role="option"
              aria-selected={opt.value === value}
              aria-disabled={opt.disabled || undefined}
              title={opt.title}
              data-highlighted={i === highlight ? 'true' : undefined}
              className="dropdown-option"
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(i)}
            >
              <span className="dropdown-option-row">
                <CheckIcon selected={opt.value === value} />
                <span className="dropdown-option-label">{opt.label}</span>
                {opt.badge ? <span className="dropdown-option-badge">{opt.badge}</span> : null}
              </span>
              {opt.caption ? <span className="dropdown-option-caption">{opt.caption}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="dropdown-trigger-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ selected }: { selected: boolean }) {
  return (
    <svg
      className="dropdown-option-check"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ visibility: selected ? 'visible' : 'hidden' }}
    >
      <path d="M2 6.2l2.6 2.6L10 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
