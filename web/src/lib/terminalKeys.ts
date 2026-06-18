/**
 * Terminal (>_) input relay. The composer's textarea is a VISIBLE buffer the
 * user types into normally — so the iOS soft keyboard, autocorrect, and on-screen
 * feedback all work (the previous raw `preventDefault` model fought the soft
 * keyboard and dropped letters). On every buffer change we diff old→new and relay
 * just the delta to the shell pane, which echoes it back:
 *   - appended text      → send literally (tmux `send-keys -l`)
 *   - removed-from-end    → send that many BSpace
 *   - replacement (autocorrect) → BSpace the changed tail, then send the new tail
 *
 * Live relay (not send-on-Enter) keeps Tab-complete working: the partial word is
 * already on the shell line, so a Tab tap completes it.
 */
export interface Mods {
  ctrl: boolean;
  alt: boolean;
}

export interface Delta {
  /** Characters removed from the end of the common region → BSpace count. */
  removed: number;
  /** Characters added after the common prefix → literal text to send. */
  added: string;
}

/**
 * Minimal edit between two buffer strings, expressed as "delete N from the tail,
 * then insert `added`". Computed from the common prefix + common suffix, so plain
 * appends, backspaces, and autocorrect replacements all map to the right relay.
 *
 * Caveat: a cursor move + mid-line edit is modelled as an end-of-line edit (the
 * shell cursor is assumed to be at the end). Append + backspace — the overwhelming
 * common case — are exact; mid-line surgery may drift until the next Enter.
 */
export function relayDiff(prev: string, next: string): Delta {
  if (prev === next) return { removed: 0, added: '' };
  let p = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (p < maxPrefix && prev[p] === next[p]) p += 1;
  let s = 0;
  const maxSuffix = Math.min(prev.length - p, next.length - p);
  while (s < maxSuffix && prev[prev.length - 1 - s] === next[next.length - 1 - s]) s += 1;
  return { removed: prev.length - p - s, added: next.slice(p, next.length - s) };
}

export const isLetter = (c: string): boolean => /^[a-z]$/i.test(c);

/** Build the tmux control token for a sticky modifier + letter (C-a / M-a). */
export function controlToken(mods: Mods, letter: string): string | null {
  if (!isLetter(letter)) return null; // allow-list only covers C-/M- + a..z
  if (mods.ctrl) return `C-${letter.toLowerCase()}`;
  if (mods.alt) return `M-${letter.toLowerCase()}`;
  return null;
}

// Keys we intercept on keydown (they have no buffer meaning and must go straight
// to the shell). Everything else flows into the visible buffer and is relayed via
// the diff. KeyboardEvent.key → tmux token.
const KEYDOWN_INTERCEPT: Record<string, string> = {
  Enter: 'Enter',
  Escape: 'Escape',
};

/**
 * Token for a keydown we intercept (Enter, Tab/Shift-Tab, Escape), or null to let
 * the key edit the visible buffer normally (letters, backspace, arrows, …).
 */
export function interceptToken(key: string, shift = false): string | null {
  if (key === 'Tab') return shift ? 'BTab' : 'Tab';
  return KEYDOWN_INTERCEPT[key] ?? null;
}

// Navigation keys → tmux base token. Modifier prefixes are added by navToken.
const NAV: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PPage',
  PageDown: 'NPage',
};

/**
 * Map an arrow / nav key + hardware modifiers to a tmux token, prefixing
 * C- (Ctrl), M- (Opt/Meta), S- (Shift) in that order — e.g. Opt+Shift+Left →
 * "M-S-Left". These must be present in the backend SHELL_KEYS allow-list. ⌘
 * (Cmd) is deliberately NOT a prefix: the browser/OS reserves it and it isn't a
 * terminal modifier. Returns null for non-nav keys.
 */
export function navToken(key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }): string | null {
  const base = NAV[key];
  if (!base) return null;
  const prefix = `${mods.ctrl ? 'C-' : ''}${mods.alt ? 'M-' : ''}${mods.shift ? 'S-' : ''}`;
  return prefix + base;
}
