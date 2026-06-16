import type { ReactNode } from 'react';

/**
 * Keyboard key-cap, semantically a native <kbd>. Mirrors the shadcn/ui Kbd look
 * (https://ui.shadcn.com/docs/components/radix/kbd) without pulling in the
 * Tailwind + Radix stack — this app is plain CSS, so a styled <kbd> is the
 * faithful, dependency-free equivalent. Styling lives in `.kbd` (styles.css).
 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
