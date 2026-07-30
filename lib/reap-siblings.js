// reap-siblings — boot-time guard against duplicate server.js instances.
//
// Root cause this fixes: a past restart / a manual `npm start` can leave a
// second (or third…) `node server.js` process running for days, each polling
// tmux independently. #137 frees the listening port on restart but only acts
// on whichever process is *holding the port* — an orphan that isn't bound to
// 127.0.0.1:4317 (e.g. it crashed mid-bind, or the port was freed out from
// under it) survives silently. This module finds and reaps those siblings
// at boot, before we ever try to bind.
//
// Matching is intentionally strict: only processes whose command contains
// the exact absolute path to *this* server.js qualify. We never match on a
// loose "server" substring — that would sweep up unrelated services.
//
// PORT SCOPING (post-incident fix): a same-script match alone is NOT enough
// to justify a kill. A hermetic/test instance booted on a different port
// (e.g. CLAUDE_CONTROL_PORT=4420) matches the same scriptPath as the
// operator's live :4317 instance — and, before this fix, reaped it, killing
// a live, healthy service over an unrelated port. The invariant this module
// now enforces: an instance on port X must NEVER reap an instance on port
// Y≠X. We confirm each same-script candidate is actually bound to THIS
// instance's port — via `lsof`, i.e. what the OS reports the pid is
// listening on — before signalling it. We deliberately do NOT trust the
// command line or an env var for this: a sibling's CLAUDE_CONTROL_PORT is
// set via its environment, which isn't reliably visible in another
// process's `ps` output (env is only visible cross-user with root, and even
// same-user `ps e` output is a poor, shell-dependent contract to parse). A
// live `lsof` read of the actual bound socket is the ground truth for "is
// this process holding my port." Same-port dedup (two instances fighting
// over :4317 → the newer reaps the older) is unchanged. If a candidate's
// port can't be determined (lsof failure, pid already gone, no listening
// socket yet), it is treated as NOT a match and left alone — when unsure,
// don't kill.
//
// Escape hatch: set CLAUDE_CONTROL_NO_REAP=1 to disable reaping entirely.
// Belt-and-suspenders for hermetic/test boots that would rather risk a
// leaked test process than ever touch another instance.

import { execSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

/**
 * Pure: find pids of OTHER processes running the same server.js script.
 *
 * Two ways to match, both anchored to THIS server.js:
 *  1. the command contains the absolute script path (`node /abs/…/server.js`,
 *     how launchd and the packaged CLI invoke it), or
 *  2. the command invokes the same BASENAME and the pid's cwd is the script's
 *     own directory — which is how `npm start` / a manual `node server.js`
 *     from the repo appear in `ps`. Those carry only the relative argv, so
 *     rule 1 never matched them: a dev boot could hold :4317 forever, unseen
 *     by every later boot, leaving launchd's KeepAlive to relaunch-and-exit
 *     every few seconds. The cwd check keeps this from matching an unrelated
 *     `server.js` belonging to some other project.
 *
 * @param {Array<{pid: number, command: string}>} psList - snapshot of processes
 * @param {number} selfPid - the current process's pid, always excluded
 * @param {string} scriptPath - absolute path to this server.js
 * @param {(pid: number) => (string|null)} [getCwd] - resolves a pid's cwd;
 *   injectable for tests. Only called for rule-2 candidates.
 * @returns {number[]} pids of sibling server.js processes (excluding selfPid)
 */
export function findSiblingServerPids(psList, selfPid, scriptPath, getCwd = defaultGetCwd) {
  if (!Array.isArray(psList) || !scriptPath) return [];
  const scriptDir = dirname(scriptPath);
  const base = basename(scriptPath);
  // `node server.js`, `node ./server.js` — the basename as its own argv token.
  const relRe = new RegExp(`(^|[\\s/])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  const siblings = [];
  for (const proc of psList) {
    if (!proc || typeof proc.command !== 'string') continue;
    if (proc.pid === selfPid) continue;
    if (proc.command.includes(scriptPath)) {
      siblings.push(proc.pid);
      continue;
    }
    if (!relRe.test(proc.command)) continue;
    if (getCwd(proc.pid) !== scriptDir) continue; // different project's server.js
    siblings.push(proc.pid);
  }
  return siblings;
}

/**
 * Best-effort: snapshot processes via `ps`, find sibling server.js instances
 * that are ALSO bound to THIS instance's port, and SIGTERM each one. Never
 * throws — a failure here must not block boot.
 *
 * A same-script candidate is only reaped when `getListeningPort(pid)`
 * reports it is listening on the same `port` as this instance — an instance
 * on port X must never reap an instance on port Y≠X. If a candidate's port
 * can't be determined (lsof failure, pid already gone, no listening socket
 * yet), it is treated as NOT a match and left alone.
 *
 * @param {object} [opts]
 * @param {() => Array<{pid: number, command: string}>} [opts.run] - process
 *   snapshot provider; injectable for tests
 * @param {(pid: number, signal: string) => void} [opts.kill] - signal sender;
 *   injectable for tests
 * @param {(pid: number) => (number|null)} [opts.getListeningPort] - resolves
 *   the TCP port a candidate pid is listening on (or null if unknown);
 *   injectable for tests
 * @param {(pid: number) => (string|null)} [opts.getCwd] - resolves a candidate
 *   pid's cwd, used only to qualify relative-argv (`node server.js`) matches;
 *   injectable for tests
 * @param {number} [opts.selfPid]
 * @param {string} [opts.scriptPath]
 * @param {number} [opts.port] - THIS instance's listening port (the value
 *   about to be passed to `server.listen()`). A same-script candidate is
 *   only reaped when its own listening port strictly equals this.
 * @param {boolean} [opts.noReap] - when true, skip reaping entirely and
 *   return []. Defaults to `process.env.CLAUDE_CONTROL_NO_REAP === '1'` —
 *   the documented escape hatch for hermetic/test boots.
 * @returns {number[]} pids that were signalled (best-effort; may include pids
 *   that were already gone by the time kill() ran)
 */
export function reapSiblingServers({
  run = defaultRun,
  kill = defaultKill,
  getListeningPort = defaultGetListeningPort,
  getCwd = defaultGetCwd,
  selfPid = process.pid,
  scriptPath,
  port,
  noReap = process.env.CLAUDE_CONTROL_NO_REAP === '1',
} = {}) {
  if (noReap) return [];
  try {
    const psList = run();
    const candidates = findSiblingServerPids(psList, selfPid, scriptPath, getCwd);
    const siblings = candidates.filter((pid) => getListeningPort(pid) === port);
    for (const pid of siblings) {
      try {
        kill(pid, 'SIGTERM');
      } catch {
        /* best-effort: pid may already be gone */
      }
    }
    return siblings;
  } catch {
    return [];
  }
}

function defaultRun() {
  const out = execSync('ps -axo pid=,command=', {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), command: m[2] };
    })
    .filter(Boolean);
}

function defaultKill(pid, signal) {
  process.kill(pid, signal);
}

// Ground truth for "is this pid holding my port": ask the OS what TCP port
// the pid is actually LISTENing on, rather than trusting `ps` command-line
// text or another process's environment (neither is a reliable contract —
// see the port-scoping note at the top of this file). Never throws: a
// missing pid, a pid with no listening socket, or `lsof` being unavailable
// all resolve to null (treated as "not a match" by the caller).
// A pid's cwd, used only to qualify a relative-argv match (`node server.js`).
// Same never-throw contract as defaultGetListeningPort: unknown → null, which
// the matcher treats as "not ours" and leaves alone.
function defaultGetCwd(pid) {
  try {
    const out = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const match = out.match(/^n(.+)$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function defaultGetListeningPort(pid) {
  try {
    const out = execSync(`lsof -a -p ${pid} -iTCP -sTCP:LISTEN -Pn`, {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    const match = out.match(/:(\d+)\s*\(LISTEN\)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
