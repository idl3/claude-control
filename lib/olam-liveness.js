/**
 * lib/olam-liveness.js — on-demand session-liveness cache (cloud-session-chat
 * Phase A, task A4).
 *
 * Liveness is fetched from ONLY two call sites: session select (GET
 * /api/olam/liveness in server.js) and immediately before a send (the WS
 * 'reply' handler's olam branch in server.js). It must NEVER be added to
 * lib/olam-sessions.js's 10s background tick — R5 requires that tick to gain
 * zero new requests. This cache is not a poller and starts no timer of its
 * own; it exists purely so a select immediately followed by a send doesn't
 * double the network round-trip within a short window.
 *
 * Held keyed by the composite session id (`olam:<org>:<sessionId>`) and NEVER
 * folded onto the polled Session row objects the registry hands out — the
 * merge with a session row happens only at the point composerMode() /
 * preSendGate() (lib/olam-transport.js) are computed.
 */
export class LivenessCache {
  /** @param {{ ttlMs?: number, now?: () => number }} [opts] */
  constructor({ ttlMs = 4000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, { liveness: object, fetchedAt: number }>} */
    this._map = new Map();
  }

  /** Cached entry (regardless of freshness), or null. Test/inspection seam. */
  peek(id) {
    return this._map.get(id) ?? null;
  }

  /**
   * Fresh liveness for `id`: serves a cached value inside the TTL window;
   * otherwise calls `fetcher()` exactly once and caches the result with a
   * fetched-at timestamp. `fetcher` is never called speculatively or more
   * than once per miss.
   * @param {string} id
   * @param {() => Promise<object>} fetcher
   * @returns {Promise<object>}
   */
  async get(id, fetcher) {
    const cached = this._map.get(id);
    const now = this.now();
    if (cached && now - cached.fetchedAt < this.ttlMs) return cached.liveness;
    const liveness = await fetcher();
    this._map.set(id, { liveness, fetchedAt: now });
    return liveness;
  }

  /** Drop one cached entry so the next read is forced fresh. */
  invalidate(id) {
    this._map.delete(id);
  }

  /** Drop everything (tests / full reset). */
  clear() {
    this._map.clear();
  }
}
