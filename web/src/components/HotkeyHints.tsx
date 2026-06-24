import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModifierHeld } from '../hooks/useModifierHeld';
import { prefersReducedMotion } from '../lib/anim';

interface HintPosition {
  key: string;
  label: string;
  top: number;
  left: number;
  width: number;
  placedAbove: boolean;
}

// Estimated rendered badge width. Font is 11px monospace with 0.22em letter-spacing
// (~2.4px/char) and 16px total horizontal padding + 2px border.
// Each character cell ≈ 6.6px wide + 2.4px spacing ≈ 9px/char.
// Using 8.5px/char + 18px overhead is conservative enough to prevent false
// collisions that cascade badges rightward, while still catching real overlap.
function estWidth(label: string): number {
  return label.length * 8.5 + 18;
}

function computePositions(): HintPosition[] {
  const targets = document.querySelectorAll<HTMLElement>('[data-hotkey]');
  const hints: HintPosition[] = [];

  targets.forEach((el, idx) => {
    const rect = el.getBoundingClientRect();
    // Skip elements with no visible area
    if (rect.width === 0 || rect.height === 0) return;

    const label = el.getAttribute('data-hotkey') ?? '';
    const dir = el.getAttribute('data-hotkey-dir'); // 'down' | 'up' | 'right' | null
    const badgeHeight = 28; // approximate height of the badge
    const gap = 6;
    const width = estWidth(label);

    // 'right' anchors the badge to the target's right edge, vertically centered
    // (wide rows like session cards — keeps the badge off the card content).
    // Badges render with translateX(-50%), so offset left by half the width to
    // land the badge's right edge just inside rect.right.
    if (dir === 'right') {
      const top = rect.top + rect.height / 2 - badgeHeight / 2;
      const left = rect.right - 8 - width / 2;
      hints.push({ key: `hint-${idx}`, label, top, left, width, placedAbove: false });
      return;
    }

    // Otherwise flip below when there's no room above (so top-bar controls don't
    // render their badge off-screen). 'down'/'up' force the side.
    const placedAbove =
      dir === 'down' ? false : dir === 'up' ? true : rect.top >= badgeHeight + gap + 4;
    const top = placedAbove ? rect.top - badgeHeight - gap : rect.bottom + gap;
    // Default: center the badge on the target element.
    const left = rect.left + rect.width / 2;

    hints.push({ key: `hint-${idx}`, label, top, left, width, placedAbove });
  });

  // De-collide badges that share a row: when targets sit close together (e.g. the
  // detail-head icon buttons) their badges would overlap. Nudge only the minimum
  // amount needed — prefer staying close to the target over cascading rightward.
  const GAP = 4;
  const rows = new Map<number, HintPosition[]>();
  for (const h of hints) {
    const row = Math.round(h.top / 8);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row)!.push(h);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.left - b.left);
    for (let i = 1; i < row.length; i++) {
      const prevRight = row[i - 1].left + row[i - 1].width / 2;
      const curLeft = row[i].left - row[i].width / 2;
      if (curLeft < prevRight + GAP) row[i].left = prevRight + GAP + row[i].width / 2;
    }
  }

  // Clamp every badge so its box stays fully within the viewport.
  // `h.left` is the badge's horizontal centre (translateX(-50%) applied in CSS).
  const M = 6; // minimum margin from viewport edge
  for (const h of hints) {
    h.left = Math.max(h.width / 2 + M, Math.min(window.innerWidth - h.width / 2 - M, h.left));
  }

  return hints;
}

export function HotkeyHints(): JSX.Element | null {
  // Only reveal after a deliberate ~500ms hold, not on a quick ⌘-combo tap.
  const held = useModifierHeld(500);
  const [hints, setHints] = useState<HintPosition[]>([]);
  // Once a hotkey is actually USED (any non-modifier key pressed while held), the
  // hints have served their purpose — hide them so they don't linger on screen
  // while ⌘ stays down. Cleared when the modifier is released (held → false).
  const [used, setUsed] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!held) {
      setHints([]);
      setUsed(false);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    if (used) {
      setHints([]); // a hotkey was used — stay hidden until ⌘ is released
      return;
    }

    // Dismiss the hints the moment a real hotkey fires (a non-modifier keydown
    // while held). Capture-phase so it runs regardless of focus / other handlers.
    const onHotkey = (e: KeyboardEvent) => {
      if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt') return;
      setUsed(true);
    };
    window.addEventListener('keydown', onHotkey, true);

    // Compute positions only AFTER the rail's Cmd-hold condense animation settles
    // (rows move during the collapse, so an immediate measure would mis-place the
    // badges). The badges then fade in sequentially (stagger applied per-badge in
    // render). Reduced-motion has no condense transition → measure immediately.
    const COLLAPSE_SETTLE_MS = prefersReducedMotion() ? 0 : 260;
    const t = setTimeout(() => setHints(computePositions()), COLLAPSE_SETTLE_MS);

    // Recompute on scroll / resize while held (immediate — already revealed).
    function recompute(): void {
      setHints(computePositions());
    }

    window.addEventListener('scroll', recompute, { capture: true, passive: true });
    window.addEventListener('resize', recompute, { passive: true });

    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onHotkey, true);
      window.removeEventListener('scroll', recompute, { capture: true });
      window.removeEventListener('resize', recompute);
    };
  }, [held, used]);

  if (!held || used || hints.length === 0) return null;

  return createPortal(
    <>
      {hints.map((h) => (
        <div
          key={h.key}
          className="hotkey-hint"
          data-above={h.placedAbove ? 'true' : 'false'}
          style={{
            position: 'fixed',
            top: h.top,
            left: h.left,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        >
          {h.label}
        </div>
      ))}
    </>,
    document.body,
  );
}
