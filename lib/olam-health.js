/**
 * lib/olam-health.js — per-org health probe for remote olam sources.
 *
 * Classifies failures so the UI can tell "your bearer rotated" from "the
 * network blipped" (design doc T2 — the secret-desync incident class):
 *
 *   red    auth        401/403 after the client's single re-read/re-mint —
 *                      a rotated bearer or revoked Access session
 *   red    login       no cloudflared Access session (actionable: run login)
 *   red    install     linear-agent brain reports install_present: false
 *   amber  transient   timeout / 5xx / network — auto-retries
 *   green  ok          all probed surfaces answered
 *
 * Auth 3-strikes: ≥3 consecutive auth failures inside 60s halts further
 * probing for that org (halted: true) until reset() — a tight 401 loop must
 * not hammer the org NOR flap the badge while the operator rotates secrets.
 */
import { NoAccessSession } from './olam-client.js';

const STRIKE_WINDOW_MS = 60_000;
const STRIKE_LIMIT = 3;

/** Classify a thrown error / HTTP status into a health class. */
export function classifyFailure(err) {
  if (err instanceof NoAccessSession || err?.code === 'NO_ACCESS_SESSION') {
    return { class: 'login', status: 'red' };
  }
  const m = /HTTP (\d{3})/.exec(String(err?.message ?? ''));
  const code = m ? Number(m[1]) : null;
  if (code === 401 || code === 403) return { class: 'auth', status: 'red' };
  return { class: 'transient', status: 'amber' };
}

export class OlamHealthProbe {
  /**
   * @param {import('./olam-client.js').OlamOrgClient} client
   * @param {{ brainUrl?: string|null, fetchImpl?: typeof fetch, now?: () => number }} [deps]
   */
  constructor(client, deps = {}) {
    this.client = client;
    this.brainUrl = deps.brainUrl ?? null;
    this.fetch = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.authStrikes = []; // timestamps of consecutive auth failures
    this.halted = false;
    this.state = { status: 'unknown', reason: null, checks: {} };
  }

  /** Clear the 3-strikes halt (operator pressed "retry" after rotating). */
  reset() {
    this.authStrikes = [];
    this.halted = false;
  }

  _strike() {
    const now = this.now();
    this.authStrikes = this.authStrikes.filter((t) => now - t < STRIKE_WINDOW_MS);
    this.authStrikes.push(now);
    if (this.authStrikes.length >= STRIKE_LIMIT) this.halted = true;
  }

  async _runnerCheck() {
    try {
      await this.client.runnerStatus('health-probe', 'agentrun');
      return { status: 'green' };
    } catch (err) {
      const c = classifyFailure(err);
      if (c.class === 'auth') this._strike();
      return { status: c.status, class: c.class };
    }
  }

  async _spaCheck() {
    try {
      await this.client.listSessions();
      return { status: 'green' };
    } catch (err) {
      const c = classifyFailure(err);
      if (c.class === 'auth') this._strike();
      return { status: c.status, class: c.class };
    }
  }

  async _brainCheck() {
    if (!this.brainUrl) return { status: 'skipped' };
    try {
      const res = await this.fetch(`${this.brainUrl}/health`);
      if (!res.ok) return { status: 'amber', class: 'transient' };
      const body = await res.json().catch(() => ({}));
      if (body.install_present === false) {
        return { status: 'red', class: 'install', reason: 'Linear app install missing' };
      }
      return { status: 'green' };
    } catch {
      return { status: 'amber', class: 'transient' };
    }
  }

  /**
   * Run all checks and update `this.state`. When halted (3 auth strikes in
   * 60s) returns the frozen red state without touching the org.
   */
  async probe() {
    if (this.halted) {
      this.state = {
        status: 'red',
        reason: 'auth failing repeatedly — probing halted until manual retry (rotate the bearer, then reset)',
        checks: this.state.checks,
        halted: true,
      };
      return this.state;
    }
    const [runner, spa, brain] = [
      await this._runnerCheck(),
      await this._spaCheck(),
      await this._brainCheck(),
    ];
    const checks = { runner, spa, brain };
    const all = Object.values(checks);
    let status = 'green';
    let reason = null;
    const red = all.find((c) => c.status === 'red');
    const amber = all.find((c) => c.status === 'amber');
    if (red) {
      status = 'red';
      reason =
        red.reason ??
        (red.class === 'login'
          ? `no Access session — run: cloudflared access login ${this.client.cfg.spaBase}`
          : 'auth failed after re-read — bearer likely rotated');
    } else if (amber) {
      status = 'amber';
      reason = 'transient errors — retrying';
    }
    this.state = { status, reason, checks, halted: this.halted };
    return this.state;
  }
}
