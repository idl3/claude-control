/**
 * lib/olam-config.js — per-org remote-session (olam) configuration.
 *
 * Feature-flag by file presence: no `olam.json` in the data dir → remote
 * sources disabled, cockpit behaves exactly as before. When present, the file
 * declares the orgs whose remote olam sessions the cockpit lists/steers:
 *
 *   {
 *     "orgs": [
 *       {
 *         "org": "atlas",
 *         "runnerUrl": "https://olam-worker-runner-sandbox.atlas-kitchen.workers.dev",
 *         "spaBase": "https://olam.dev-atlas.kitchen",
 *         "gsmProject": "pleri-500205",            // optional (default shown)
 *         "gsmAccount": "ernest.codes@gmail.com",  // optional (default shown)
 *         "runnerTokenGsmSecret": "olam-atlas-sandbox-runner-token", // optional (default: olam-<org>-sandbox-runner-token)
 *         "runnerTokenFiles": ["~/.olam/secrets/sandbox-runner-token"] // optional fallbacks, tried after GSM
 *       }
 *     ]
 *   }
 *
 * Security invariants (design doc T1/T2/T5):
 *   - Secret VALUES are read on demand and live only in process memory; this
 *     module never logs them and error messages never embed them.
 *   - Candidate order is GSM-first, then rotation files. Both copies have been
 *     observed stale in the wild — the caller's live probe is the arbiter, so
 *     this module exposes the ordered candidate list rather than one value.
 *   - Token file paths must be absolute and free of `..` segments (a writable
 *     olam.json must not become a read-anything primitive via clever paths).
 *   - With ≥1 org configured, the cockpit's own auth token becomes MANDATORY
 *     (assertAuthWithRemoteOrgs) — org bearers in a tokenless-open server
 *     would be exfiltrable by anything that can reach the port.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

// Env lookup mirrors server.js / lib/config.js.
const env = (name) =>
  process.env[`CLAUDE_CONTROL_${name}`] ?? process.env[`COCKPIT_${name}`];

/** Resolve the data directory (CLAUDE_CONTROL_DATA or ~/.claude-control). */
function dataDir() {
  return env('DATA') || path.join(os.homedir(), '.claude-control');
}

const DEFAULT_GSM_PROJECT = 'pleri-500205';
const DEFAULT_GSM_ACCOUNT = 'ernest.codes@gmail.com';

/** Expand a leading `~/` to the home directory. */
function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Validate a token-file path: absolute after ~-expansion, no `..` segments.
 * Returns the expanded path; throws (without embedding secrets) otherwise.
 */
export function validateTokenFilePath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('olam.json: runnerTokenFiles entries must be non-empty strings');
  }
  const expanded = expandHome(p);
  if (!path.isAbsolute(expanded)) {
    throw new Error(`olam.json: token file path must be absolute: ${p}`);
  }
  if (expanded.split(path.sep).includes('..')) {
    throw new Error(`olam.json: token file path must not contain "..": ${p}`);
  }
  return expanded;
}

const URL_FIELDS = ['runnerUrl', 'spaBase'];

/** Validate + normalise one org entry. Throws with the offending field named. */
function normaliseOrg(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`olam.json: orgs[${index}] must be an object`);
  }
  const org = raw.org;
  if (typeof org !== 'string' || !/^[a-z][a-z0-9-]*$/.test(org)) {
    throw new Error(`olam.json: orgs[${index}].org must be a lowercase slug`);
  }
  for (const f of URL_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'string' || !/^https:\/\//.test(v)) {
      throw new Error(`olam.json: orgs[${index}].${f} must be an https:// URL (org "${org}")`);
    }
  }
  const files = raw.runnerTokenFiles ?? [];
  if (!Array.isArray(files)) {
    throw new Error(`olam.json: orgs[${index}].runnerTokenFiles must be an array (org "${org}")`);
  }
  if (raw.brainUrl !== undefined && (typeof raw.brainUrl !== 'string' || !/^https:\/\//.test(raw.brainUrl))) {
    throw new Error(`olam.json: orgs[${index}].brainUrl must be an https:// URL when present (org "${org}")`);
  }
  return {
    org,
    runnerUrl: raw.runnerUrl.replace(/\/$/, ''),
    spaBase: raw.spaBase.replace(/\/$/, ''),
    brainUrl: raw.brainUrl ? raw.brainUrl.replace(/\/$/, '') : null,
    gsmProject: raw.gsmProject ?? DEFAULT_GSM_PROJECT,
    gsmAccount: raw.gsmAccount ?? DEFAULT_GSM_ACCOUNT,
    runnerTokenGsmSecret: raw.runnerTokenGsmSecret ?? `olam-${org}-sandbox-runner-token`,
    runnerTokenFiles: files.map(validateTokenFilePath),
  };
}

/**
 * Load + validate the olam config. Absent file → `{ enabled: false, orgs: [] }`
 * (feature off, zero behavior change). Malformed file → throw loudly: a broken
 * remote-orgs config must never be silently ignored (the operator thinks
 * they're monitoring sessions that aren't being listed).
 *
 * @param {{ file?: string }} [opts] test seam — explicit config path
 * @returns {{ enabled: boolean, file: string, orgs: Array<object> }}
 */
export function loadOlamConfig(opts = {}) {
  const file = opts.file ?? path.join(dataDir(), 'olam.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { enabled: false, file, orgs: [] };
    throw new Error(`olam.json unreadable at ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`olam.json invalid JSON at ${file}: ${err.message}`);
  }
  const orgsRaw = parsed?.orgs;
  if (!Array.isArray(orgsRaw)) {
    throw new Error(`olam.json at ${file}: top-level "orgs" array is required`);
  }
  const orgs = orgsRaw.map(normaliseOrg);
  const names = new Set();
  for (const o of orgs) {
    if (names.has(o.org)) throw new Error(`olam.json: duplicate org "${o.org}"`);
    names.add(o.org);
  }
  return { enabled: orgs.length > 0, file, orgs };
}

/**
 * Decision 7 (plan): org bearers in memory + tokenless-open cockpit = local
 * exfiltration path. With ≥1 org configured the cockpit token is mandatory.
 * Call at startup; throws a fail-loud error (caller exits non-zero).
 */
export function assertAuthWithRemoteOrgs(olamConfig, configToken) {
  if (!olamConfig?.enabled) return;
  if (!configToken) {
    throw new Error(
      'olam remote orgs are configured but no cockpit auth token is set. ' +
        'Refusing to start: remote-org bearers must not live behind an open server. ' +
        'Set CLAUDE_CONTROL_TOKEN (or ~/.claude-control/token), or remove olam.json.',
    );
  }
}

/**
 * Ordered runner-token candidates for an org (GSM first, then files). The
 * caller probes each against the live runner and keeps the first that works —
 * the probe, not any single store, is the arbiter of "current".
 *
 * @returns {Array<{ kind: 'gsm'|'file', label: string } & object>}
 */
export function runnerTokenCandidates(orgCfg) {
  return [
    {
      kind: 'gsm',
      secret: orgCfg.runnerTokenGsmSecret,
      project: orgCfg.gsmProject,
      account: orgCfg.gsmAccount,
      label: `gsm:${orgCfg.runnerTokenGsmSecret}`,
    },
    ...orgCfg.runnerTokenFiles.map((p) => ({ kind: 'file', path: p, label: `file:${p}` })),
  ];
}

/**
 * Read one candidate's secret value. Returns the trimmed value, or null when
 * the candidate is unreadable (missing file, no gcloud, denied) — the caller
 * walks on. Never throws with the value embedded; never logs.
 *
 * @param {object} candidate from runnerTokenCandidates()
 * @param {{ execFileImpl?: typeof execFile }} [deps] test seam
 * @returns {Promise<string|null>}
 */
export function readSecretCandidate(candidate, deps = {}) {
  if (candidate.kind === 'file') {
    return fs.promises
      .readFile(candidate.path, 'utf8')
      .then((s) => s.trim() || null)
      .catch(() => null);
  }
  const impl = deps.execFileImpl ?? execFile;
  return new Promise((resolve) => {
    impl(
      'gcloud',
      [
        'secrets', 'versions', 'access', 'latest',
        `--secret=${candidate.secret}`,
        `--project=${candidate.project}`,
        `--account=${candidate.account}`,
      ],
      { timeout: 15_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });
}
