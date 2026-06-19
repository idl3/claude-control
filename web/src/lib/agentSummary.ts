import type { SubAgent } from './types';

const MAX_SUMMARY = 120;

/**
 * One-line "latest work" summary for a sub-agent, for the above-composer strip.
 * Prefers the agent's most recent text (or thinking) output; falls back to its
 * description. Collapses whitespace and truncates. Pure.
 */
export function latestAgentSummary(agent: SubAgent): string {
  const msgs = agent?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = (msgs[i]?.blocks ?? [])
      .filter(
        (b): b is { kind: 'text' | 'thinking'; text: string } =>
          b.kind === 'text' || b.kind === 'thinking',
      )
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return truncate(text);
  }
  const desc = (agent?.description ?? '').replace(/\s+/g, ' ').trim();
  return desc ? truncate(desc) : '';
}

function truncate(s: string): string {
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY - 1) + '…' : s;
}
