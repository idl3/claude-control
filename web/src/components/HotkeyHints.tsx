import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModifierHeld } from '../hooks/useModifierHeld';

interface HintPosition {
  key: string;
  label: string;
  top: number;
  left: number;
  width: number;
  placedAbove: boolean;
}

// Rough rendered badge width (chars include the ⌘ glyph + 0.22em letter-spacing
// + horizontal padding). Used only for de-collision math.
function estWidth(label: string): number {
  return label.length * 11 + 20;
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
    const left = rect.left + rect.width / 2;

    hints.push({ key: `hint-${idx}`, label, top, left, width, placedAbove });
  });

  // De-collide badges that share a row: when targets sit close together (e.g. the
  // detail-head icon buttons) their badges would overlap, so nudge each right of
  // the previous one's edge. Keeps them readable and evenly spaced.
  const GAP = 8;
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

  return hints;
}

export function HotkeyHints(): JSX.Element | null {
  // Only reveal after a deliberate ~500ms hold, not on a quick ⌘-combo tap.
  const held = useModifierHeld(500);
  const [hints, setHints] = useState<HintPosition[]>([]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!held) {
      setHints([]);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    // Initial compute
    setHints(computePositions());

    // Recompute on scroll / resize while held
    function recompute(): void {
      setHints(computePositions());
    }

    window.addEventListener('scroll', recompute, { capture: true, passive: true });
    window.addEventListener('resize', recompute, { passive: true });

    return () => {
      window.removeEventListener('scroll', recompute, { capture: true });
      window.removeEventListener('resize', recompute);
    };
  }, [held]);

  if (!held || hints.length === 0) return null;

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
