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
    Object.defineProperty(this, '_runnerToken', { value: null, writable: true, enumerable: false }); // { value, label }
    this._pools = new Map(); // sessionId -> confirmed pool
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

  async _spaFetch(path) {
    let res = await this.fetch(`${this.cfg.spaBase}${path}`, { headers: await this._spaHeaders() });
    if (res.status === 401 || res.status === 403) {
      // Expired Access session or rotated app bearer: re-mint both once, then
      // surface NoAccessSession (the actionable operator state).
      this.invalidateAccessToken();
      res = await this.fetch(`${this.cfg.spaBase}${path}`, { headers: await this._spaHeaders() });
      if (res.status === 401 || res.status === 403) throw new NoAccessSession(this.cfg.spaBase);
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
      pool: this._pools.get(r.session_id) ?? null,
      phase: null,
    }));
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
          this._pools.set(s.sessionId, pool);
          break;
        }
      }
    }
    return { unenriched };
  }
}
