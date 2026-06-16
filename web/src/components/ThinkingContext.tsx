import { createContext, useContext } from 'react';

/**
 * The id of the message whose reasoning is being generated right now (the live
 * "thinking" block), or `null` when the selected session isn't actively
 * generating. Driven by the server's per-session `thinking` signal (parsed from
 * Claude's "esc to interrupt" TUI line) combined with the last message id.
 *
 * A reasoning block flashes multicolour while its message id matches this; once
 * the session stops thinking (or a newer message lands) it settles to solid.
 */
export const LiveThinkingContext = createContext<string | null>(null);

export function useLiveThinkingId(): string | null {
  return useContext(LiveThinkingContext);
}
