import type { Msg } from './types';

// Safety bound on the client-retained transcript. Far above the server's bounded
// tail window (~1 MB ≈ tens–low-hundreds of messages) and the render cap, so it
// never causes the "disappearing" symptom in practice — it only stops a
// multi-hour session from growing the in-memory array without limit.
export const MAX_RETAINED_MESSAGES = 4000;

/**
 * Merge a server transcript snapshot into the client's accumulated history.
 *
 * The transcript is append-only with stable `uuid`s, but the server tails a
 * BOUNDED window and, on every (re)subscribe — which happens on each WS
 * reconnect, frequent on a phone over Tailscale — re-sends a `messages`
 * snapshot of its current, possibly-trimmed buffer. Blindly REPLACING the
 * client array with that snapshot drops older messages the client already
 * showed (the reported bug: user messages "disappearing after a while").
 *
 * Instead we keep everything we have and append only the snapshot messages we
 * haven't seen (by uuid), preserving order. Because the transcript is
 * append-only and immutable, union-by-uuid reconstructs the full history across
 * a slid window without ever losing a message.
 */
export function mergeMessages(
  existing: Msg[] | undefined,
  incoming: Msg[],
): Msg[] {
  if (!existing || existing.length === 0) return cap(incoming);
  if (incoming.length === 0) return existing;

  const seen = new Set<string>();
  for (const m of existing) seen.add(m.uuid);

  const fresh = incoming.filter((m) => !seen.has(m.uuid));
  if (fresh.length === 0) return existing;

  return cap([...existing, ...fresh]);
}

function cap(msgs: Msg[]): Msg[] {
  return msgs.length > MAX_RETAINED_MESSAGES
    ? msgs.slice(msgs.length - MAX_RETAINED_MESSAGES)
    : msgs;
}
