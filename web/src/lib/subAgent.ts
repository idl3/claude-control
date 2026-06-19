/**
 * Sub-agent prefix helper.
 *
 * Structured for a future agent PICKER: `agent` will accept a name string
 * (e.g. "researcher", "coder") and produce the appropriate prefix.
 * Today only the boolean-on case (no explicit agent) is wired.
 */

/** The value stored per session.  A string agent name is the extension point. */
export type SubAgentMode = boolean | string;

/**
 * Returns the prefix string to prepend to outgoing text, or `""` when the
 * mode is off / falsy.
 *
 * - `false` / falsy string → `""`
 * - `true` → `"Using a sub-agent"`
 * - `"<name>"` (non-empty string) → `"Using the <name> sub-agent"`
 */
export function subAgentPrefix(mode: SubAgentMode): string {
  if (!mode) return '';
  if (mode === true) return 'Using a sub-agent';
  return `Using the ${mode} sub-agent`;
}

/**
 * Applies the sub-agent prefix to user text.
 * Returns the original text unchanged when mode is off or text is empty.
 * Separator is a period + space so the prefix reads as a sentence fragment
 * followed by the user's message.
 */
export function applySubAgentPrefix(text: string, mode: SubAgentMode): string {
  const prefix = subAgentPrefix(mode);
  if (!prefix || !text) return text;
  return `${prefix}. ${text}`;
}
