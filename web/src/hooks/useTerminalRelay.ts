import { useCallback, useMemo, useRef, useState } from 'react';
import { relayDiff, controlToken, interceptToken, isLetter, type Mods } from '../lib/terminalKeys';

export interface TerminalOps {
  /** Forward literal keystroke text (no Enter). */
  sendText: (s: string) => void;
  /** Send a named tmux control key (SHELL_KEYS allow-list). */
  sendKey: (k: string) => void;
}

/**
 * Reusable terminal input relay over a plain controlled <textarea>. The textarea
 * is a VISIBLE buffer the user types into normally (so the iOS soft keyboard +
 * autocorrect work); each change is diffed and the delta is relayed live to the
 * target (the pane echoes it back), keeping Tab-complete working. Sticky Ctrl/Opt
 * are one-shot — tap Ctrl, then a letter, for Ctrl-<letter> "in succession".
 *
 * This is the same algorithm the composer's cc-shell mode uses, generalized so
 * any pane's ops can drive it. Pair the returned `sticky`/`toggleMod` with the
 * TerminalView key bar so the on-screen modifier toggles share one state.
 */
export function useTerminalRelay(ops: TerminalOps) {
  const [value, setValue] = useState('');
  const [sticky, setSticky] = useState<Mods>({ ctrl: false, alt: false });
  const prevRef = useRef('');
  const stickyRef = useRef(sticky);
  stickyRef.current = sticky;
  const opsRef = useRef(ops);
  opsRef.current = ops;

  const toggleMod = useCallback((m: keyof Mods) => {
    setSticky((s) => ({ ...s, [m]: !s[m] }));
  }, []);

  const relay = useCallback((next: string) => {
    const prev = prevRef.current;
    if (next === prev) return;
    const { removed, added } = relayDiff(prev, next);
    const s = stickyRef.current;
    const o = opsRef.current;

    // Sticky modifier + a single inserted letter → control key; drop the letter.
    if ((s.ctrl || s.alt) && removed === 0 && added.length === 1 && isLetter(added)) {
      const tok = controlToken(s, added);
      if (tok) o.sendKey(tok);
      setSticky({ ctrl: false, alt: false });
      setValue(prev); // revert
      return;
    }
    // A newline in the delta == Enter (soft-keyboard return that slipped past keydown).
    const nl = added.indexOf('\n');
    if (nl !== -1) {
      for (let i = 0; i < removed; i += 1) o.sendKey('BSpace');
      if (added.slice(0, nl)) o.sendText(added.slice(0, nl));
      o.sendKey('Enter');
      prevRef.current = '';
      setValue('');
      return;
    }
    for (let i = 0; i < removed; i += 1) o.sendKey('BSpace');
    if (added) o.sendText(added);
    prevRef.current = next;
    setValue(next);
  }, []);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => relay(e.target.value),
    [relay],
  );

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.metaKey) return; // ⌘ combos belong to the browser/OS
    const s = stickyRef.current;
    const o = opsRef.current;
    const ctrl = e.ctrlKey || s.ctrl;
    const alt = e.altKey || s.alt;
    // Ctrl/Opt + letter (hardware keyboards fire keydown for letters).
    if ((ctrl || alt) && e.key.length === 1 && isLetter(e.key)) {
      e.preventDefault();
      const tok = controlToken({ ctrl, alt }, e.key);
      if (tok) o.sendKey(tok);
      if (s.ctrl || s.alt) setSticky({ ctrl: false, alt: false });
      return;
    }
    const tok = interceptToken(e.key, e.shiftKey);
    if (tok) {
      e.preventDefault();
      o.sendKey(tok);
      if (tok === 'Enter') {
        prevRef.current = '';
        setValue('');
      }
    }
  }, []);

  return useMemo(
    () => ({ value, onChange, onKeyDown, sticky, toggleMod }),
    [value, onChange, onKeyDown, sticky, toggleMod],
  );
}
