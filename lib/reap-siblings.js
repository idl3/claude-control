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

import { execSync } from 'node:child_process';

/**
 * Pure: find pids of OTHER processes running the same server.js script.
 *
 * @param {Array<{pid: number, command: string}>} psList - snapshot of processes
 * @param {number} selfPid - the current process's pid, always excluded
 * @param {string} scriptPath - absolute path to this server.js; a candidate's
 *   command must contain this exact string to match
 * @returns {number[]} pids of sibling server.js processes (excluding selfPid)
 */
export function findSiblingServerPids(psList, selfPid, scriptPath) {
  if (!Array.isArray(psList) || !scriptPath) return [];
  const siblings = [];
  for (const proc of psList) {
    if (!proc || typeof proc.command !== 'string') continue;
    if (proc.pid === selfPid) continue;
    if (!proc.command.includes(scriptPath)) continue;
    siblings.push(proc.pid);
  }
  return siblings;
}

/**
 * Best-effort: snapshot processes via `ps`, find sibling server.js instances,
 * and SIGTERM each one. Never throws — a failure here must not block boot.
 *
 * @param {object} [opts]
 * @param {() => Array<{pid: number, command: string}>} [opts.run] - process
 *   snapshot provider; injectable for tests
 * @param {(pid: number, signal: string) => void} [opts.kill] - signal sender;
 *   injectable for tests
 * @param {number} [opts.selfPid]
 * @param {string} [opts.scriptPath]
 * @returns {number[]} pids that were signalled (best-effort; may include pids
 *   that were already gone by the time kill() ran)
 */
export function reapSiblingServers({
  run = defaultRun,
  kill = defaultKill,
  selfPid = process.pid,
  scriptPath,
} = {}) {
  try {
    const psList = run();
    const siblings = findSiblingServerPids(psList, selfPid, scriptPath);
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
