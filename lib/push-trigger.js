// lib/push-trigger.js — server-side push triggers for claude-control.
//
// Two edges are watched per session:
//   ask  — s.pending rises false→true (an AskUserQuestion opened).
//   done — a session goes active→idle and STAYS idle through a settle
//          window (the session finished or errored out).
//
// Two exported surfaces:
//   evaluateEdges(prev, sessions)  pure, no timers/I-O — fully unit testable.
//   createPushTrigger({...})       stateful wrapper server.js actually calls;
//                                  owns the settle timers + delivers pushes.
//
// Why the settle window on "done" (do not remove it): the `thinking` flag is
// a coarse ~2s TUI scrape that flickers off briefly between tool calls, so a
// naive active→idle edge would spam "done" mid-run. The settle window
// absorbs that flicker — if the session goes active or pending again before
// it elapses, the timer is cancelled and no push fires. It's also required
// because an idle session stops emitting `change` events altogether, so a
// purely change-cadence-gated check would never fire for it; the timer
// guarantees delivery ~settleMs after the session actually goes idle. The
// `doneFired` latch guarantees exactly one "done" push per active→idle
// transition — it only re-arms once the session goes active again.

import * as defaultPush from './push.js';

/** @returns {{primed:boolean, pending:Map<string,boolean>, active:Map<string,boolean>, doneFired:Map<string,boolean>}} a fresh, empty edge-tracking state. */
export function createEdgeState() {
  return { primed: false, pending: new Map(), active: new Map(), doneFired: new Map() };
}

function isActive(s) {
  return !!(s.thinking || s.compacting || s.subAgentActive);
}

/**
 * Pure rising/falling-edge evaluator over a session list — no timers, no I/O.
 * Mirrors the identical algorithm server.js runs on every `change` event.
 *
 * @param {{primed:boolean, pending:Map<string,boolean>, active:Map<string,boolean>, doneFired:Map<string,boolean>}} prev
 * @param {object[]} sessions
 * @returns {{
 *   asks: Array<{id:string, title:string, body:string, data:{id:string}}>,
 *   doneArm: string[],
 *   doneCancel: string[],
 *   next: {primed:boolean, pending:Map<string,boolean>, active:Map<string,boolean>, doneFired:Map<string,boolean>},
 * }}
 */
export function evaluateEdges(prev, sessions) {
  const pending = new Map();
  const active = new Map();
  const doneFired = new Map(prev.doneFired);

  // Priming: seed state from the current snapshot but never fire — avoids a
  // push storm for sessions that were already pending/active at boot.
  if (!prev.primed) {
    for (const s of sessions) {
      pending.set(s.id, !!s.pending);
      active.set(s.id, isActive(s));
    }
    return { asks: [], doneArm: [], doneCancel: [], next: { primed: true, pending, active, doneFired } };
  }

  const asks = [];
  const doneArm = [];
  const doneCancel = [];
  const seen = new Set();

  for (const s of sessions) {
    seen.add(s.id);
    const wasPending = prev.pending.get(s.id) ?? false;
    const wasActive = prev.active.get(s.id) ?? false;
    const nowPending = !!s.pending;
    const nowActive = isActive(s);

    if (nowPending && !wasPending) {
      asks.push({
        id: s.id,
        title: s.name || s.id,
        body: s.pendingQuestion || 'is asking a question',
        data: { id: s.id },
      });
    }

    if (wasActive && !nowActive && !nowPending) {
      // active → idle: arm a "done" candidate; the caller settles it.
      doneArm.push(s.id);
    } else if (!wasActive && !wasPending && (nowActive || nowPending)) {
      // Was idle (possibly mid-settle) and became active/pending again:
      // cancel any outstanding settle timer the caller may be holding.
      doneCancel.push(s.id);
    }

    // Re-entering active state re-arms the done latch for next time.
    if (nowActive) doneFired.set(s.id, false);

    pending.set(s.id, nowPending);
    active.set(s.id, nowActive);
  }

  // Forget sessions that disappeared so a returning id re-arms cleanly, and
  // cancel any settle timer that might still be outstanding for them.
  for (const id of prev.pending.keys()) {
    if (seen.has(id)) continue;
    const wasActive = prev.active.get(id) ?? false;
    const wasPending = prev.pending.get(id) ?? false;
    if (!wasActive && !wasPending) doneCancel.push(id);
    doneFired.delete(id);
  }

  return { asks, doneArm, doneCancel, next: { primed: true, pending, active, doneFired } };
}

/**
 * Stateful push trigger — what server.js calls on every registry `change`.
 * Wraps evaluateEdges() with an injectable timer + transport so it's testable
 * without real setTimeout/web-push.
 *
 * @param {object} [opts]
 * @param {(payload:{title:string, body:string, data:object}) => Promise<any>} [opts.send]
 * @param {(fn:() => void, ms:number) => any} [opts.schedule]
 * @param {(handle:any) => void} [opts.cancel]
 * @param {number} [opts.settleMs]
 * @returns {{onChange:(sessions:object[]) => void, _state:object}}
 */
export function createPushTrigger({
  send = defaultPush.sendToAll,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
  settleMs = Number(process.env.CLAUDE_CONTROL_DONE_SETTLE_MS) || 8000,
} = {}) {
  const state = createEdgeState();
  const handles = new Map(); // id -> timer handle, only while a "done" is armed and unsettled

  function onChange(sessions) {
    try {
      const { asks, doneArm, doneCancel, next } = evaluateEdges(state, sessions);
      Object.assign(state, next); // mutate in place so `_state` stays a live reference

      for (const ask of asks) {
        send({ title: ask.title, body: ask.body, data: ask.data }).catch((err) =>
          console.error('push: sendToAll failed:', err?.message || err),
        );
      }

      for (const id of doneCancel) {
        const h = handles.get(id);
        if (h !== undefined) {
          cancel(h);
          handles.delete(id);
        }
      }

      for (const id of doneArm) {
        const snapshot = sessions.find((s) => s.id === id);
        if (!snapshot) continue;
        const title = snapshot.name || snapshot.id;
        const errored = !!snapshot.errored;
        const handle = schedule(() => {
          handles.delete(id);
          send({
            title,
            body: errored ? '⚠️ stopped (error)' : '✅ finished',
            data: { id },
          }).catch((err) => console.error('push: sendToAll failed:', err?.message || err));
          state.doneFired.set(id, true);
        }, settleMs);
        handles.set(id, handle);
      }
    } catch (err) {
      // Never let push logic break the session broadcast.
      console.error('push: onChange error:', err?.message || err);
    }
  }

  return { onChange, _state: state };
}
