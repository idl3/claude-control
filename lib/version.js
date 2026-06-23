/**
 * lib/version.js — release-update detection (git-based).
 *
 * claude-control is distributed as a git checkout and updates via `git pull`
 * (the in-UI "Update now" button), so "is there a new release?" is answered by
 * comparing the local checkout against its `origin` upstream — accurate, and
 * immune to npm name-squatting (the public `claude-control`/`claude-cockpit`
 * names are namesakes, not this project). Version NUMBERS still follow npm
 * semver via package.json.
 *
 * Best-effort + cached: a non-git checkout, missing origin, or offline state
 * simply reports "no update" and never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(_execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const REFRESH_MS = 6 * 60 * 60 * 1000; // re-check upstream at most every 6h

/** Running version from package.json. */
export function currentVersion() {
  try {
    return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function git(args) {
  const { stdout } = await execFile('git', args, { cwd: ROOT, timeout: 8000 });
  return stdout.trim();
}

let cache = { info: null, checkedAt: 0 };

async function checkoutIdentity() {
  const identity = {
    root: ROOT,
    branch: null,
    commit: null,
    dirty: null,
  };
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    identity.branch = branch && branch !== 'HEAD' ? branch : null;
  } catch {
    // not a git checkout
  }
  try {
    identity.commit = await git(['rev-parse', '--short', 'HEAD']);
  } catch {
    // not a git checkout
  }
  try {
    identity.dirty = (await git(['status', '--porcelain'])).length > 0;
  } catch {
    // not a git checkout
  }
  return identity;
}

/**
 * { current, root, branch, commit, dirty, latest, behind, updateAvailable }.
 * - behind: commits on origin/<branch> not in HEAD.
 * - latest: version field of origin's package.json (may equal current if the
 *   upstream bumped commits without bumping the version).
 */
export async function getVersionInfo({ force = false, now = Date.now() } = {}) {
  const current = currentVersion();
  const identity = await checkoutIdentity();
  if (!force && cache.info && now - cache.checkedAt < REFRESH_MS) {
    return { current, ...identity, ...cache.info };
  }

  let behind = 0;
  let latest = null;
  try {
    if (!identity.branch) throw new Error('detached HEAD');
    await git(['fetch', '--quiet', 'origin', identity.branch]);
    behind = parseInt(await git(['rev-list', '--count', `HEAD..origin/${identity.branch}`]), 10) || 0;
    if (behind > 0) {
      try {
        latest = JSON.parse(await git(['show', `origin/${identity.branch}:package.json`])).version || null;
      } catch {
        latest = null;
      }
    }
  } catch {
    // not a git checkout / no origin / offline — treat as up to date.
  }

  const info = { latest, behind, updateAvailable: behind > 0 };
  cache = { info, checkedAt: now };
  return { current, ...identity, ...info };
}
