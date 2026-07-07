/**
 * lib/olam-client.js — per-org client for olam's remote-session surfaces.
 *
 * One instance per configured org (lib/olam-config.js). Recipes are the
 * live-verified contract in docs/olam-contract.md:
 *
 *   - list:     GET <spa>/api/plan-chat/v1/sessions?type=chat&scope=all
 *               (CF Access JWT via `cloudflared access token`)
 *   - enrich:   GET <runner>/agent-run/status?sessionId&pool (bearer) — phase
 *               + pool probe-confirmation (status 200s even for unknown
 *               sessions; a non-empty `phase` marks the right pool)
 *   - identity: session_id === Linear AgentSession id === planId (olam ADR-062)
 *
 * Auth material never leaves this module: the CF Access JWT and the runner
 * bearer live in memory, appear in no logs, and are never attached to
 * objects returned to callers.
 */
import { execFile } from 'node:child_process';
import { runnerTokenCandidates, readSecretCandidate } from './olam-config.js';
import { normalizePrs } from './olam-prs.js';

/** Thrown when no cloudflared Access session exists for the org's SPA app. */
export class NoAccessSession extends Error {
  constructor(spaBase) {
    super(`no cloudflared Access session for ${spaBase} — run: cloudflared access login ${spaBase}`);
    this.name = 'NoAccessSession';
    this.code = 'NO_ACCESS_SESSION';
  }
}

// Pool probe order: Linear-delegated sessions run on the `linear` pool,
// plan-origin on `sandbox`, ad-hoc dispatches on `agentrun` (olam runner
// routing). Origin isn't in the list rows, so we confirm by probing.
const POOL_ORDER = ['linear', 'sandbox', 'agentrun'];

export class OlamOrgClient {
  /**
   * @param {object} orgCfg normalised org entry from loadOlamConfig()
   * @param {{ fetchImpl?: typeof fetch, execFileImpl?: typeof execFile }} [deps] test seams
   */
  constructor(orgCfg, deps = {}) {
    this.org = orgCfg.org;
    this.cfg = orgCfg;
    this.fetch = deps.fetchImpl ?? fetch;
    this.execFile = deps.execFileImpl ?? execFile;
    // Token material is deliberately NON-ENUMERABLE: a stray
    // console.log(client) / JSON.stringify(client) / structuredClone must never
    // carry bearers (CP3 audit, T1). Caching is intentional — re-reading GSM
    // per call would shell out twice per tick for a remote-likelihood threat;
    // process-compromise is covered by T5 (mandatory auth, localhost bind).
    Object.defineProperty(this, '_jwt', { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, '_appBearer', { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, '_operatorEmail', { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, '_runnerToken', { value: null, writable: true, enumerable: false }); // { value, label }
    // sessionId -> confirmed pool (filled by enrich()'s runner probe).
    //
    // NOTE (CP3 audit follow-up, Finding 1): this cache used to be load-bearing
    // for liveness too — isExecuteShaped(session) with no liveness argument
    // reads session.pool as its only positive signal, and pool is set ONLY
    // here. A fresh process (this Map empty) meant a genuinely-dormant execute
    // session's liveness was NEVER even fetched (pool=null → isExecuteShaped
    // false → server.js's old getSessionLiveness gate skipped the fetch
    // entirely — the exact "silently stays steer after a cockpit restart"
    // bug). Liveness is now probed unconditionally for every remote session
    // (see server.js's getSessionLiveness) regardless of this cache's state.
    // _pools remains load-bearing for enrich()'s own probe-candidate
    // filtering (below) and for the phase/pool UI display — just no longer
    // for gating whether a liveness check happens.
    this._pools = new Map();
  }

  // --- CF Access JWT (operator identity via cloudflared) -------------------

  /** Mint (or return cached) Access JWT. Throws NoAccessSession when absent. */
  async accessToken() {
    if (this._jwt) return this._jwt;
    const jwt = await new Promise((resolve) => {
      this.execFile(
        'cloudflared',
        ['access', 'token', `--app=${this.cfg.spaBase}`],
        { timeout: 15_000 },
        (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
      );
    });
    if (!jwt) throw new NoAccessSession(this.cfg.spaBase);
    this._jwt = jwt;
    return jwt;
  }

  /** Drop the cached JWT + app bearer (on 401 from the SPA; next call re-mints). */
  invalidateAccessToken() {
    this._jwt = null;
    this._appBearer = null;
    this._operatorEmail = null;
  }

  /**
   * The operator's own email, read from the CF Access JWT's `email` claim. The
   * edge already verified the JWT (we only read a claim for a UI hint — the
   * authoritative steer gate is the SPA's ownership check, which 404s a
   * non-owned session). Returns '' when unavailable. Cached per JWT.
   */
  async operatorEmail() {
    if (this._operatorEmail != null) return this._operatorEmail;
    const jwt = await this.accessToken();
    let email = '';
    try {
      const payload = jwt.split('.')[1];
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof json.email === 'string') email = json.email;
    } catch {
      email = '';
    }
    this._operatorEmail = email;
    return email;
  }

  /**
   * Second auth layer (live-verified 2026-07-02): API routes also require the
   * app bearer, which GET /api/bootstrap hands to CF-Access-authenticated
   * clients by design ("token" field). Cached alongside the JWT.
   */
  async _bootstrapBearer(jwt) {
    if (this._appBearer) return this._appBearer;
    const res = await this.fetch(`${this.cfg.spaBase}/api/bootstrap`, {
      headers: { 'cf-access-token': jwt },
    });
    if (!res.ok) throw new Error(`[${this.org}] bootstrap HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new Error(`[${this.org}] bootstrap handed no app bearer`);
    }
    this._appBearer = body.token;
    return this._appBearer;
  }

  async _spaHeaders() {
    const jwt = await this.accessToken();
    const bearer = await this._bootstrapBearer(jwt);
    return { 'cf-access-token': jwt, Authorization: `Bearer ${bearer}` };
  }

  /**
   * Public two-layer-authed GET against the org's SPA (both auth layers, single
   * 401 re-mint). Used by the chunks shape subscriber (lib/olam-transcript.js).
   * @param {string} path path+query beginning with '/'
   * @returns {Promise<Response>}
   */
  apiFetch(path) {
    return this._spaFetch(path, { method: 'GET' });
  }

  /**
   * Public two-layer-authed POST against the org's SPA (JSON body, single 401
   * re-mint). Used by the steer transport (lib/olam-transport.js).
   * @param {string} path path beginning with '/'
   * @param {object} body JSON-serialisable request body
   * @returns {Promise<Response>}
   */
  apiPost(path, body) {
    return this._spaFetch(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async _spaFetch(path, init = {}) {
    const build = async () => ({
      ...init,
      headers: {
        ...(await this._spaHeaders()),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    // An expired CF Access session does NOT return 401 — the edge answers with a
    // 302 → login page (HTML, 200 after fetch follows it). Because this._jwt is
    // cached, a stale token would otherwise ride EVERY request until a process
    // restart, and the shape subscriber silently swallows the HTML into [] and
    // hangs on "Loading transcript…" forever (no 401 → no re-mint). Treat a
    // redirect-to-login OR an HTML body on a JSON API route as an auth-expiry
    // signal alongside 401/403: invalidate + re-mint once (transparently picks up
    // a fresh `cloudflared access login` with NO restart), then surface
    // NoAccessSession — the actionable operator state — if it still isn't JSON.
    const accessWall = (r) =>
      r.status === 401 ||
      r.status === 403 ||
      r.redirected === true ||
      (r.headers?.get?.('content-type') || '').includes('text/html');
    let res = await this.fetch(`${this.cfg.spaBase}${path}`, await build());
    if (accessWall(res)) {
      this.invalidateAccessToken();
      res = await this.fetch(`${this.cfg.spaBase}${path}`, await build());
      if (accessWall(res)) throw new NoAccessSession(this.cfg.spaBase);
    }
    return res;
  }

  // --- Sessions list --------------------------------------------------------

  /**
   * List the org's chat-scope sessions, normalised for the cockpit registry.
   * Rows carry NO secrets. `linearRef` is the ADR-062 identity (the session
   * id IS the Linear AgentSession id); pool is filled by enrich().
   */
  async listSessions() {
    const res = await this._spaFetch('/api/plan-chat/v1/sessions?type=chat&scope=all');
    if (!res.ok) throw new Error(`[${this.org}] sessions list HTTP ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body?.sessions ?? []);
    // scope=all returns EVERY org member's sessions. One owned by a different
    // operator is view-only: steering it would present as the wrong actor (the
    // SPA 404s that too, but the flag disables the composer up front). CP3 Phase C.
    const me = await this.operatorEmail();
    // DEV-ONLY, one row per tick: the Pleri Gateway ingests GitHub + Linear
    // webhooks and writes canonical archive/merge status onto the Neon
    // session row, but the exact field vocabulary hasn't been live-confirmed
    // yet — this surfaces the real key set once so lib/olam-archive.js's
    // STATUS_FIELDS/TRUTHY_FIELDS can be tightened. Remove once confirmed.
    if (!this._loggedKeys && rows.length > 0) {
      this._loggedKeys = true;
      // eslint-disable-next-line no-console
      console.log(`[olam:${this.org}] session row keys:`, Object.keys(rows[0]));
    }
    return rows.map((r) => ({
      org: this.org,
      sessionId: r.session_id,
      worldId: r.world_id ?? null,
      title: r.title ?? null,
      summary: r.summary ?? '',
      lastActivity: r.last_turn_at ?? r.created_at ?? null,
      inFlight: r.in_flight_turn_id != null,
      halted: r.halted_at != null,
      linearRef: r.session_id, // ADR-062: session_id === Linear AgentSession id
      linearIssueId: r.linear_issue_id ?? null, // live list carries it (verified)
      planStatus: r.plan_status ?? null,
      ownerEmail: r.owner_email ?? null,
      readOnly: !!(me && r.owner_email && r.owner_email !== me), // org-mate's session

      // --- canonical archive-lifecycle status (Gateway-written; lib/olam-archive.js) ---
      // Defensively captured under BOTH snake_case source names and camelCase
      // aliases so deriveArchived() can match on whichever field the Gateway
      // actually uses — only set when present on the row (never invents a value).
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.state !== undefined ? { state: r.state } : {}),
      ...(r.closed !== undefined ? { closed: r.closed } : {}),
      ...(r.closed_at !== undefined ? { closedAt: r.closed_at } : {}),
      ...(r.cancelled !== undefined ? { cancelled: r.cancelled } : {}),
      ...(r.canceled !== undefined ? { canceled: r.canceled } : {}),
      ...(r.archived !== undefined ? { archived: r.archived } : {}),
      ...(r.archived_at !== undefined ? { archivedAt: r.archived_at } : {}),
      ...(r.pr_state !== undefined ? { prState: r.pr_state } : {}),
      ...(r.merged !== undefined ? { merged: r.merged } : {}),
      ...(r.merged_at !== undefined ? { mergedAt: r.merged_at } : {}),
      ...(r.linear_state !== undefined ? { linearState: r.linear_state } : {}),
      ...(r.linear_status !== undefined ? { linearStatus: r.linear_status } : {}),

      pool: this._pools.get(r.session_id) ?? null,
      phase: null,

      // --- model / context-remaining (SPA-computed; same fields local rows
      // use, so SessionRail's .session-meta render lights up as-is) ---
      model: r.last_model ?? undefined,
      ctxPct: typeof r.last_ctx_pct === 'number' ? r.last_ctx_pct : undefined,
    }));
  }

  // --- Liveness (Phase A, on-demand only — see lib/olam-liveness.js) --------

  /**
   * Liveness for one session: `GET <spa>/api/session-liveness?session_id=`.
   * Called ONLY on session select + immediately pre-send (never on a tick —
   * lib/olam-sessions.js must stay liveness-free, R5). Fail-CLOSED to
   * `{state:'unknown'}` on any network error or non-200 — a liveness read
   * that can't complete must never be mistaken for 'live' (that would let a
   * dormant session through the composer as if it could still be steered).
   *
   * @param {string} sessionId
   * @returns {Promise<{ state: 'live'|'dormant'|'unknown', phase?: string, done?: boolean, containerSessionId?: string }>}
   */
  async sessionLiveness(sessionId) {
    try {
      const res = await this.apiFetch(`/api/session-liveness?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return { state: 'unknown' };
      const body = await res.json().catch(() => null);
      if (!body || typeof body.state !== 'string') return { state: 'unknown' };
      return body;
    } catch {
      return { state: 'unknown' };
    }
  }

  // --- Runner bearer (probe-arbitrated candidate walk) ----------------------

  /**
   * Resolve the runner bearer: walk GSM-first candidates, keep the first that
   * the live runner accepts. Both stores have been observed stale — the probe
   * is the arbiter (docs/olam-contract.md). Cached after first success.
   */
  async runnerToken() {
    if (this._runnerToken) return this._runnerToken.value;
    for (const cand of runnerTokenCandidates(this.cfg)) {
      const value = await readSecretCandidate(cand, { execFileImpl: this.execFile });
      if (!value) continue;
      const res = await this.fetch(
        `${this.cfg.runnerUrl}/agent-run/status?sessionId=token-probe&pool=agentrun`,
        { headers: { Authorization: `Bearer ${value}` } },
      ).catch(() => null);
      if (res?.ok) {
        this._runnerToken = { value, label: cand.label };
        return value;
      }
    }
    throw new Error(`[${this.org}] no working runner bearer among candidates (GSM + files)`);
  }

  /**
   * Runner status for one session. On 401 (rotation mid-flight, T2) the cached
   * bearer is dropped and the candidate walk re-runs ONCE; a second 401 throws
   * so the health probe can mark the org unhealthy.
   */
  async runnerStatus(sessionId, pool, { retried = false } = {}) {
    const token = await this.runnerToken();
    const res = await this.fetch(
      `${this.cfg.runnerUrl}/agent-run/status?sessionId=${encodeURIComponent(sessionId)}&pool=${encodeURIComponent(pool)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401 && !retried) {
      this._retiredLabel = this._runnerToken?.label ?? null;
      this._runnerToken = null; // single re-walk (rotation suspected)
      return this.runnerStatus(sessionId, pool, { retried: true });
    }
    if (!res.ok) {
      const via = retried && this._runnerToken?.label
        ? ` after re-walk [now ${this._runnerToken.label}${this._retiredLabel ? `; retired ${this._retiredLabel}` : ''}]`
        : '';
      throw new Error(`[${this.org}] runner status HTTP ${res.status} (${sessionId})${via}`);
    }
    return res.json();
  }

  // --- Terminal / replay token (runner HMAC; Phase D) ------------------------

  /**
   * Mint a short-TTL terminal-token for a session (docs/olam-contract.md). The
   * runner returns { uiUrl, replayUiUrl, wsUrl, ... } whose URLs embed the
   * HMAC `?token=` — the ONLY credential allowed to reach the browser. TTL is
   * clamped [5m, 60m] (default 15m). Returns just the browser-facing URLs.
   *
   * @param {string} sessionId
   * @param {string} pool
   * @param {number} [ttlSeconds]
   * @returns {Promise<{ uiUrl: string|null, replayUiUrl: string|null, expiresAt: string|null }>}
   */
  async terminalToken(sessionId, pool, ttlSeconds = 900) {
    const ttl = Math.max(300, Math.min(3600, Number(ttlSeconds) || 900));
    const token = await this.runnerToken();
    const url = `${this.cfg.runnerUrl}/agent-run/terminal-token?sessionId=${encodeURIComponent(sessionId)}&pool=${encodeURIComponent(pool)}&ttl=${ttl}`;
    let res = await this.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      this._runnerToken = null; // rotation — single re-walk
      const fresh = await this.runnerToken();
      res = await this.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) throw new Error(`[${this.org}] terminal-token HTTP ${res.status}`);
    const body = await res.json().catch(() => ({}));
    return {
      uiUrl: body.uiUrl ?? null,
      replayUiUrl: body.replayUiUrl ?? null,
      expiresAt: body.expiresAt ?? null,
    };
  }

  // --- Enrichment (phase + pool probe-confirm) -------------------------------

  /**
   * Fill `phase`/`pool` on normalised rows by probing the runner. Pool is
   * confirmed once per session (cached — olam pins a session to its pool at
   * dispatch): a non-empty `phase` (or done=true) marks the pool that ran it.
   *
   * Only sessions that can have a LIVE phase are probed — in-flight rows plus
   * pool-cached rows (1 cheap probe each). Idle/halted rows without a cached
   * pool stay list-only. Never silently truncates: returns the count of
   * in-flight rows the budget could not cover so callers can surface it
   * (CP3 audit HIGH — partial enrichment must be visible, not implied).
   *
   * @returns {Promise<{ unenriched: number }>}
   */
  async enrich(sessions, { maxProbes = 30 } = {}) {
    let probes = 0;
    let unenriched = 0;
    const candidates = sessions.filter((s) => s.inFlight || this._pools.has(s.sessionId));
    for (const s of candidates) {
      const pools = s.pool ? [s.pool] : (this._pools.has(s.sessionId) ? [this._pools.get(s.sessionId)] : POOL_ORDER);
      if (probes + pools.length > maxProbes && !this._pools.has(s.sessionId)) {
        unenriched += 1; // budget can't cover a full pool walk — count, don't guess
        continue;
      }
      for (const pool of pools) {
        if (probes >= maxProbes) { unenriched += 1; break; }
        probes += 1;
        let status;
        try {
          status = await this.runnerStatus(s.sessionId, pool);
        } catch {
          break; // runner unreachable/unhealthy — leave row list-only
        }
        if (status.phase || status.done) {
          s.pool = pool;
          s.phase = status.phase || (status.done ? 'done' : null);
          // Runner status carries { prs, prCount } (docs/olam-contract.md);
          // normalize defensively since the element shape (string[] of URLs
          // vs {url,number,state}[]) hasn't been live-confirmed.
          s.prs = normalizePrs(status.prs);
          s.prCount = status.prCount ?? s.prs.length;
          this._pools.set(s.sessionId, pool);
          break;
        }
      }
    }
    return { unenriched };
  }
}
