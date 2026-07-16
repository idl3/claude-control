/**
 * lib/ws-poll-gate.js — Pause/resume gate for SessionRegistry + ResourceMonitor
 * polling, driven by live WebSocket client count (R8).
 *
 * server.js's main() starts both unconditionally at boot; from then on every
 * 4s/12s/2s refresh tick fires tmux capture-pane, and every 5s resources tick
 * fires vm_stat/pmset, whether or not anyone has the app open. This gate stops
 * both the instant the last WS client disconnects, and restarts + fires one
 * immediate tick on the next connection, so a reconnecting client sees fresh
 * data within one frame instead of waiting a full interval.
 *
 * Extracted from server.js so tests can drive it with fake registry/resources
 * spies without booting the HTTP/WS server — same reasoning as
 * lib/ws-heartbeat.js's pruneDeadClients.
 *
 * Gated ONLY on wss.clients.size (literally zero WS clients, of any kind) —
 * NOT the per-session sub.clients.size teardown in server.js's
 * maybeTeardown(), a separate mechanism for a separate concern (per-session
 * transcript tailers) left untouched. A client with no session open still
 * counts as "someone's watching": sidebar badges arrive via
 * registry.on('change') pushed to every connected client, not just ones
 * subscribed to a specific session.
 *
 * Exception — live push subscriptions: pausing on zero WS clients silently
 * defeated Web Push. registry.on('change') is the ONLY thing that drives
 * lib/push-trigger.js's ask/done edge detection (see server.js's
 * `registry.on('change', ...)` handler) — so once this gate stopped the
 * registry's setIntervals, the trigger stopped detecting anything the moment
 * the last tab/PWA disconnected, which is exactly when a push is needed (the
 * app is closed/backgrounded). `hasSubscribers()` keeps the poll loop armed
 * whenever at least one device has an active PushSubscription, so pushes
 * keep firing to devices with the app closed while still preserving the
 * original zero-clients-zero-subscribers battery-saving behaviour.
 */

/**
 * @param {{ start(): void, stop(): void }} registry
 * @param {{ start(): void, stop(): void, refreshNow(): Promise<void> }} resources
 * @param {{ hasSubscribers?: () => boolean }} [opts]
 */
export function createWsPollGate(registry, resources, { hasSubscribers = () => false } = {}) {
  // Both are already running -- server.js's main() calls .start() on both
  // unconditionally at boot -- so the gate starts "not paused". The first WS
  // client's onConnect() must be a no-op, not a redundant .start() call:
  // SessionRegistry.start() is idempotent as a defense-in-depth guard, but
  // reconnecting an already-active gate still should not trigger an extra
  // immediate refresh/poll pass.
  let paused = false;

  return {
    /** Call from wss.on('connection', ...). No-op unless resuming from a pause. */
    onConnect() {
      if (!paused) return;
      paused = false;
      registry.start();
      resources.start();
      // resources.start() only arms its timer (no self-tick, unlike
      // registry.start() which fires refresh()+_pollCtx()+_pollThinking()
      // once before its own setIntervals) -- fire one explicitly so the
      // reconnecting client's first 'resources' broadcast isn't stale until
      // the next 5s tick.
      resources.refreshNow().catch(() => {});
    },

    /**
     * Call from ws.on('close', ...) with wss.clients.size read AFTER this
     * socket's own removal. The `ws` library's internal 'close' listener
     * (which does `wss.clients.delete(ws)`) is registered during the
     * upgrade, before `wss.on('connection', ...)` ever fires -- so by the
     * time a handler registered inside that 'connection' callback runs,
     * wss.clients already reflects this socket's removal. No off-by-one risk.
     *
     * @param {number} remainingClients
     */
    onDisconnect(remainingClients) {
      if (paused || remainingClients > 0) return;
      // At least one device is subscribed to push — keep polling so
      // push-trigger.js can still detect ask/done edges and deliver a
      // notification while every tab is closed.
      if (hasSubscribers()) return;
      paused = true;
      registry.stop();
      resources.stop();
    },

    /** Test/debug hook. */
    isPaused() {
      return paused;
    },
  };
}
