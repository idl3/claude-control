import type { Msg, SubAgent } from './types';

const MAX_SUMMARY = 120;

function messageText(msg: Msg): string {
  return (msg?.blocks ?? [])
    .filter(
      (b): b is { kind: 'text' | 'thinking'; text: string } =>
        b.kind === 'text' || b.kind === 'thinking',
    )
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One-line "latest work" summary for a sub-agent, for the above-composer strip.
 * Prefers the agent's most recent text (or thinking) output; falls back to its
 * description. Collapses whitespace and truncates. Pure.
 */
export function latestAgentSummary(agent: SubAgent): string {
  return recentAgentSummaries(agent, 1)[0] ?? '';
}

/**
 * Last `limit` DISTINCT activity lines for `agent`, in chronological order
 * (oldest first, most recent LAST) — same source and truncation as
 * `latestAgentSummary`, but keeps a short trailing window instead of only
 * the newest line. Feeds the sub-agent strip's hover-expand quick view.
 *
 * Consecutive duplicate lines collapse to one: an agent frequently re-emits
 * the same status line across several transcript records (e.g. a thinking
 * block immediately followed by a text block repeating it), and without
 * dedup the quick view would show "Inspecting foo" five times in a row
 * instead of five distinct recent lines. Falls back to the agent's
 * description when no message text is found at all, so it's never empty
 * while `latestAgentSummary` would show something.
 */
export function recentAgentSummaries(agent: SubAgent, limit = 5): string[] {
  const msgs = agent?.messages ?? [];
  const out: string[] = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < limit; i--) {
    const text = messageText(msgs[i]);
    if (!text) continue;
    const truncated = truncate(text);
    if (out[out.length - 1] === truncated) continue;
    out.push(truncated);
  }
  if (out.length === 0) {
    const desc = (agent?.description ?? '').replace(/\s+/g, ' ').trim();
    if (desc) out.push(truncate(desc));
  }
  return out.reverse();
}

function truncate(s: string): string {
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + '…' : s;
}
