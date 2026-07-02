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
      return { cfg: orgCfg, client, probe, lastRows: [] };
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
      const rows = await entry.client.listSessions();
      const { unenriched = 0 } = (await entry.client.enrich(rows)) ?? {};
      const reason =
        unenriched > 0
          ? `${unenriched} in-flight session(s) not yet enriched (probe budget) — phase shown as unknown`
          : health.reason;
      entry.lastRows = rows.map((r) => ({
        id: `olam:${r.org}:${r.sessionId}`,
        kind: 'remote',
        transport: 'olam',
        pending: false,
        stale: false,
        orgHealth: { status: health.status, reason },
        ...r,
      }));
      return entry.lastRows;
    } catch (err) {
      entry.lastRows = entry.lastRows.map((r) => ({
        ...r,
        stale: true,
        orgHealth: { status: 'amber', reason: String(err?.message ?? err) },
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

  /** Per-org health snapshot for /api surfaces + the frontend org header. */
  health() {
    return Object.fromEntries(this.orgs.map((o) => [o.cfg.org, o.probe.state]));
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
