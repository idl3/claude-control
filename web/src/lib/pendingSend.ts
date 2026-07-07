import type { Msg } from './types';

// Shared matching logic for optimistic sends (App.tsx's `PendingSend` queue).
// Both the transcript-echo reconcile effect and the Retry action (fired from
// a "Not delivered" bubble in Messages.tsx) need to answer the same question —
// "does a REAL transcript echo of this pending send already exist?" — so the
// rule lives here once instead of being duplicated at each call site.

/** The subset of a PendingSend needed to match it against a transcript echo. */
export interface EchoCandidate {
  text: string;
  label: string;
  at: number;
}

// Clock-skew tolerance between send time and transcript ts — an identical
// OLDER message already in history must not falsely resolve a fresh send.
const ECHO_SKEW_MS = 5000;

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Resolve a transcript message's `ts` (number | ISO string | missing) to epoch ms. */
export function toMs(ts: unknown): number {
  return typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) || 0 : 0;
}

/** Concatenate a transcript message's text blocks (to match a real user echo
 * against a queued send). */
export function msgText(msg: Msg): string {
  return (msg.blocks ?? [])
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join(' ');
}

/**
 * True when a single transcript echo (raw text + resolved ts) counts as a
 * delivery of `entry`: normalized text/label equality (with a startsWith
 * fallback for truncation) AND landing at/after entry.at minus clock-skew
 * tolerance.
 */
export function echoMatches(entry: EchoCandidate, echoText: string, echoTs: number): boolean {
  const t = normalize(echoText);
  if (!t) return false;
  if (echoTs < entry.at - ECHO_SKEW_MS) return false;
  const text = normalize(entry.text);
  const label = normalize(entry.label);
  return t === text || t === label || t.startsWith(label) || text.startsWith(t);
}

/**
 * True when `msgs` already contains a real user-transcript echo of `entry`.
 * Used by the Retry action to check "did this actually land already?" before
 * re-sending — a failed delivery ack doesn't always mean tmux never got it.
 */
export function hasDeliveredEcho(entry: EchoCandidate, msgs: readonly Msg[]): boolean {
  return msgs.some((m) => m.role === 'user' && echoMatches(entry, msgText(m), toMs(m.ts)));
}

/** Parse the PendingSend key out of an optimistic bubble's message id (`queued-<key>`). */
export function parsePendingKey(id: string): number | null {
  const m = /^queued-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
