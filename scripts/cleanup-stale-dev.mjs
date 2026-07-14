#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function elapsedSeconds(value) {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return 0;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parsePs(output) {
  const rows = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      elapsed: elapsedSeconds(match[4]),
      command: match[5],
    });
  }
  return rows;
}

export function isProtectedCommand(command) {
  // Protect both native executables and the packaged Node entrypoints used by
  // npm/global installs. False positives are intentional here: declining to
  // clean one process group is safer than terminating an agent that happens to
  // have launched a Vite child in the same group.
  return /(?:^|[\\/\s])(?:claude|codex)(?:\.js)?(?=$|[\\/\s])|(?:^|[\\/\s])(?:claude-code|openai-codex)(?=$|[\\/\s])|(?:claude|codex)\.app[\\/]/i.test(command);
}

export function staleDevGroups(rows, { scopeMarker, minAgeSeconds }) {
  const byGroup = new Map();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const row of rows) {
    const list = byGroup.get(row.pgid) ?? [];
    list.push(row);
    byGroup.set(row.pgid, list);
  }

  const matchesDev = (row) =>
    row.command.includes(scopeMarker) &&
    /(?:node_modules\/(?:\.bin\/vite|vite\/)|@esbuild\/|node_modules\/\.bin\/esbuild)/.test(row.command);

  // Agent tool subprocesses may create a new process group, so inspecting only
  // members of the candidate PGID is not enough. Follow each member's PPID chain
  // through the same ps snapshot and reject the group if any ancestor is Claude
  // or Codex. The visited set also makes malformed/cyclic fixture data harmless.
  const hasProtectedLineage = (row) => {
    const visited = new Set();
    let current = row;
    while (current && !visited.has(current.pid)) {
      visited.add(current.pid);
      if (isProtectedCommand(current.command)) return true;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  const ownPgid = byPid.get(process.pid)?.pgid ?? null;

  return [...byGroup.entries()]
    .filter(([pgid, group]) =>
      pgid > 1 &&
      pgid !== ownPgid &&
      !group.some(hasProtectedLineage) &&
      group.some((row) => matchesDev(row) && row.elapsed >= minAgeSeconds),
    )
    .map(([pgid, group]) => ({ pgid, processes: group }))
    .sort((a, b) => a.pgid - b.pgid);
}

function main() {
  const apply = process.argv.includes('--apply');
  const ageArg = process.argv.find((arg) => arg.startsWith('--min-age-minutes='));
  const minAgeMinutes = ageArg ? Number(ageArg.split('=')[1]) : 30;
  if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 1) {
    throw new Error('--min-age-minutes must be at least 1');
  }

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // Includes normal worktrees such as claude-cockpit-wt-* without matching
  // unrelated Vite projects elsewhere under the same Projects directory.
  const scopeMarker = path.join(path.dirname(repoRoot), path.basename(repoRoot));
  const output = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], { encoding: 'utf8' });
  const groups = staleDevGroups(parsePs(output), {
    scopeMarker,
    minAgeSeconds: minAgeMinutes * 60,
  });

  if (groups.length === 0) {
    console.log('No stale cockpit Vite/esbuild process groups found.');
    return;
  }
  for (const group of groups) {
    console.log(`${apply ? 'Stopping' : 'Would stop'} PGID ${group.pgid}:`);
    for (const row of group.processes) console.log(`  ${row.pid} ${row.command}`);
    if (apply) {
      // Revalidate immediately before signaling. Process groups can disappear
      // or gain a protected Claude/Codex ancestor between the initial ps sample
      // and this loop; in either case, fail closed.
      const freshOutput = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,etime=,command='], { encoding: 'utf8' });
      const stillStale = staleDevGroups(parsePs(freshOutput), {
        scopeMarker,
        minAgeSeconds: minAgeMinutes * 60,
      }).some((candidate) => candidate.pgid === group.pgid);
      if (!stillStale) {
        console.log(`Skipping PGID ${group.pgid}: process tree changed during validation.`);
        continue;
      }
      process.kill(-group.pgid, 'SIGTERM');
    }
  }
  if (!apply) console.log('Dry run only. Re-run with --apply to send SIGTERM.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
