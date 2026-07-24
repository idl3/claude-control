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
 * Returns the delegation directive to prepend to outgoing text, or `""` when
 * the mode is off / falsy.
 *
 * The cockpit's only channel is the PARENT tmux Claude session — sub-agents are
 * spawned BY the parent via the Task/Agent tool, so "send into the sub-agent"
 * has to be an imperative to the parent to delegate. A soft "Using a sub-agent"
 * note read like a hint the parent could ignore (it usually just answered the
 * prompt itself); this is a hard instruction to dispatch instead.
 *
 * - `false` / falsy string → `""`
 * - `true` → generic "dispatch to a sub-agent" directive
 * - `"<name>"` (non-empty string) → directive naming the `<name>` sub-agent
 */
export function subAgentPrefix(mode: SubAgentMode): string {
  if (!mode) return '';
  const who = mode === true ? 'a sub-agent' : `the ${mode} sub-agent`;
  return `Dispatch this to ${who} — use the Task/Agent tool to delegate it, do not do the work yourself:`;
}

/**
 * Applies the sub-agent directive to user text.
 * Returns the original text unchanged when mode is off or text is empty.
 * Separator is a single space; the directive already ends with a colon so it
 * reads as an instruction immediately followed by the user's message.
 */
export function applySubAgentPrefix(text: string, mode: SubAgentMode): string {
  const prefix = subAgentPrefix(mode);
  if (!prefix || !text) return text;
  return `${prefix} ${text}`;
}
