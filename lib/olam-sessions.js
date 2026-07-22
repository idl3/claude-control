/**
 * lib/olam-sessions.js — RemoteSessionSource: the olam side of the session list.
 *
 * Owns one OlamOrgClient + OlamHealthProbe per configured org, polls each
 * org's session list every `intervalMs` (default 10s — remote lists change on
 * agent-turn cadence, not keystrokes), and hands Session-shaped rows to
 * `SessionRegistry.setRemoteSessions()`. Local tmux discovery never waits on
 * a remote org: each org is fetched independently and failures degrade to
 * that org's last-known rows marked `stale: true` (greyed, not dropped).
 *
 * Visibility note (CP3 audit): remote rows are server-scoped — every client of
 * THIS cockpit sees the same org sessions. Cockpit is a single-operator tool
 * (mandatory auth token gates the whole surface); per-operator scoping is an
 * explicit non-goal this epic (plan §Out of scope).
 *
 * Row shape (superset of the frontend Session type; additive fields only):
 *   id: `olam:<org>:<sessionId>`   kind: 'remote'   transport: 'olam'
 *   org, sessionId, pool, phase, linearRef, summary, lastActivity,
 *   inFlight, halted, stale, orgHealth: {status, reason}
 */
import { OlamOrgClient } from './olam-client.js';
import { OlamHealthProbe } from './olam-health.js';
import { deriveArchived } from './olam-archive.js';

/**
 * Wrap one normalised olam row into the Session-shaped row the tick pushes
 * (and loadMore() returns) — id/kind/transport/orgHealth + archived derived
 * from the merged fields. Centralised so the live tick and the scroll-paging
 * loadMore() path can never drift on shape.
 */
function wrapRemoteRow(r, health) {
  const row = { id: `olam:${r.org}:${r.sessionId}`, kind: 'remote', transport: 'olam',
    pending: false, stale: false, orgHealth: { status: health.status, reason: health.reason }, ...r };
  return { ...row, archived: deriveArchived(row) };
}

/**
 * Map an org-fetch failure to an operator-facing health {status, reason}. A CF
 * Access session that has lapsed makes the SPA serve login HTML instead of JSON,
 * surfacing either as a typed NoAccessSession or a raw
 * "Unexpected token '<', <!DOCTYPE …is not valid JSON" parse error — neither is
 * actionable in the rail. Collapse both to a clear re-login prompt (login-red);
 * pass everything else through as a transient amber with its raw message.
 */
export function classifyOrgError(err, spaBase) {
  const msg = String(err?.message ?? err);
  const accessWall =
    msg.includes('cloudflared access login') || // typed NoAccessSession
    msg.includes('is not valid JSON') || // JSON.parse choked on the login HTML
    msg.includes('<!DOCTYPE') ||
    msg.includes("Unexpected token '<'");
  return accessWall
    ? { status: 'red', reason: `Access session expired — run: cloudflared access login ${spaBase}` }
    : { status: 'amber', reason: msg };
}

export class RemoteSessionSource {
  /**
   * @param {{ orgs: Array<object> }} olamConfig from loadOlamConfig()
   * @param {import('./sessions.js').SessionRegistry} registry
   * @param {{ intervalMs?: number, clientFactory?: (org) => OlamOrgClient, probeFactory?: (client, org) => OlamHealthProbe }} [deps]
   */
  constructor(olamConfig, registry, deps = {}) {
    this.registry = registry;
    this.intervalMs = deps.intervalMs ?? 10_000;
    this._interval = null;
    this._ticking = false;
    this.orgs = olamConfig.orgs.map((orgCfg) => {
      const client = deps.clientFactory ? deps.clientFactory(orgCfg) : new OlamOrgClient(orgCfg);
      const probe = deps.probeFactory
        ? deps.probeFactory(client, orgCfg)
        : new OlamHealthProbe(client, { brainUrl: orgCfg.brainUrl });
      return { cfg: orgCfg, client, probe, lastRows: [], capped: false, nextCursor: null, hasMore: false };
    });
  }

  /** One org's fetch → Session-shaped rows. Never throws; degrades to stale. */
  async _fetchOrg(entry) {
    const health = await entry.probe.probe();
    if (health.status === 'red') {
      // Keep last-known rows, greyed — an unhealthy org must be visible, not blank.
      entry.lastRows = entry.lastRows.map((r) => ({ ...r, stale: true, orgHealth: health }));
      return entry.lastRows;
    }
    try {
      const { rows, nextCursor } = await entry.client.listSessions();
      entry.capped = !!entry.client.capped;
      entry.nextCursor = nextCursor ?? null;
      entry.hasMore = nextCursor != null;
      const { unenriched = 0 } = (await entry.client.enrich(rows)) ?? {};
      const reason =
        unenriched > 0
          ? `${unenriched} in-flight session(s) not yet enriched (probe budget) — phase shown as unknown`
          : health.reason;
      entry.lastRows = rows.map((r) => wrapRemoteRow(r, { status: health.status, reason }));
      return entry.lastRows;
    } catch (err) {
      const failHealth = classifyOrgError(err, entry.cfg.spaBase);
      // Write back onto the probe's own state too — not just the rows — so
      // health() (row-independent; used for the empty-state/settings surfaces)
      // reflects this failure immediately rather than waiting on next tick's
      // probe() to rediscover the same thing.
      entry.probe.state = { ...entry.probe.state, ...failHealth };
      entry.lastRows = entry.lastRows.map((r) => ({
        ...r,
        stale: true,
        orgHealth: failHealth,
      }));
      return entry.lastRows;
    }
  }

  /** Fetch all orgs (independently) and push the merged remote set. */
  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const perOrg = await Promise.all(this.orgs.map((o) => this._fetchOrg(o)));
      this.registry.setRemoteSessions(perOrg.flat());
    } finally {
      this._ticking = false;
    }
  }

  /** The OlamOrgClient for an org (transcript source needs its apiFetch/runnerStatus). */
  clientForOrg(org) {
    return this.orgs.find((o) => o.cfg.org === org)?.client ?? null;
  }

  /** Fetch ONE more page for an org given an opaque cursor. Returns WRAPPED rows
   *  (same shape the tick pushes) + the next cursor. Does NOT mutate lastRows —
   *  the SPA owns the scrolled tail; the tick keeps owning the live page-1 head. */
  async loadMore(org, cursor) {
    const entry = this.orgs.find((o) => o.cfg.org === org);
    if (!entry) throw new Error(`unknown org ${org}`);
    const { rows, nextCursor } = await entry.client.listSessions({ cursor });
    await entry.client.enrich(rows).catch(() => {});
    const state = entry.probe.state ?? { status: 'unknown', reason: null };
    const sessions = rows.map((r) => wrapRemoteRow(r, { status: state.status, reason: state.reason }));
    return { sessions, nextCursor: nextCursor ?? null };
  }

  /** Last-known normalised row for a remote session id `olam:<org>:<sessionId>`. */
  rowById(id) {
    for (const o of this.orgs) {
      const hit = o.lastRows.find((r) => r.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Per-org health snapshot for /api surfaces + the frontend org header —
   * row-independent (works even when an org has zero known rows, e.g. a
   * lapsed Access session before any session was ever fetched). `capped` is
   * the legacy (pre-cursor-pagination) lower-bound signal — the org may have
   * more sessions than the tab's count reflects. `hasMore`/`nextCursor` are
   * the cursor-pagination signals: they drive the SPA's cursor-following
   * scroll-paging (`GET /api/olam/sessions?org=…&cursor=…`) so it knows
   * whether/how to fetch the next page.
   */
  health() {
    return Object.fromEntries(
      this.orgs.map((o) => [o.cfg.org, { ...o.probe.state, capped: o.capped, hasMore: o.hasMore, nextCursor: o.nextCursor }]),
    );
  }

  start() {
    if (this._interval) return;
    this.tick().catch(() => {});
    this._interval = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this._interval.unref?.();
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}
