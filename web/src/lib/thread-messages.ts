import type { ThreadMessageLike } from '@assistant-ui/react';

/**
 * Minimal shape of an optimistic pending send the thread assembler reads. A
 * structural subset of App.tsx's PendingSend so PendingSend[] passes directly.
 */
export interface OptimisticSend {
  key: number;
  at: number;
  label: string;
  status: string;
}

/**
 * Collapse any repeated message id to a single entry (last content wins, first
 * position kept for stable ordering). assistant-ui's MessageRepository THROWS
 * and unmounts the whole thread if the array it receives contains the same id
 * twice (see @assistant-ui/core message-repository.ts performOp/link), so this
 * is the final safety net before the array reaches the runtime.
 */
export function dedupeById(messages: ThreadMessageLike[]): ThreadMessageLike[] {
  const indexById = new Map<string, number>();
  const out: ThreadMessageLike[] = [];
  for (const m of messages) {
    const id = String(m.id);
    const at = indexById.get(id);
    if (at === undefined) {
      indexById.set(id, out.length);
      out.push(m);
    } else {
      out[at] = m; // last-write-wins, keep original position
    }
  }
  return out;
}

/**
 * Lowest safe starting value for the optimistic send-key counter so a key minted
 * this page-load can never collide with one REHYDRATED from localStorage (which
 * restarts the in-memory counter at 0 while old entries keep their keys). A
 * collision mints two `queued-<key>` bubbles with the same id → assistant-ui crash.
 */
export function initialSendSeq(pending: readonly { key: number }[]): number {
  return pending.reduce((max, e) => (e.key > max ? e.key : max), 0);
}

/**
 * Build the exact ThreadMessageLike[] handed to the composer's external-store
 * runtime: the capped transcript tail, then the optimistic pending-send bubbles,
 * then the "Working…" loader — all guaranteed id-unique via dedupeById.
 */
export function buildThreadMessages(
  fullConverted: ThreadMessageLike[],
  hiddenCount: number,
  pending: readonly OptimisticSend[],
  working: boolean,
): ThreadMessageLike[] {
  const base =
    hiddenCount > 0 ? fullConverted.slice(hiddenCount) : fullConverted.slice();
  // Pending sends pin to the BOTTOM (near the composer), FIFO, not interleaved
  // by time; once the real transcript echo lands the reconcile effect removes them.
  for (const e of pending) {
    base.push({
      role: 'user',
      id: `queued-${e.key}`,
      createdAt: new Date(e.at),
      content: [{ type: 'text', text: e.label }],
      metadata: { custom: { cockpitRole: 'user', optimistic: true, sendStatus: e.status } },
    } as ThreadMessageLike);
  }
  if (working) {
    base.push({
      role: 'assistant',
      id: 'optimistic-working',
      content: [{ type: 'text', text: 'Working…' }],
      metadata: { custom: { cockpitRole: 'assistant', working: true } },
    } as ThreadMessageLike);
  }
  return dedupeById(base);
}
