# Snapshot-based sleep/resume for Olam on Cloudflare Containers

> Research and recommended seam for making Olam remote sessions autoscalable
> like Devin sessions: sleep after inactivity, restore from a snapshot on wake.

## What Cloudflare Containers/Sandboxes give us today

- Each `Sandbox` is a `DurableObject` + a Linux container instance. The DO
  (`this.ctx.storage`) persists, but the container disk is **ephemeral**.
- `sleepAfter` / `keepAlive` control when the container stops. When it stops,
  the disk disappears.
- `@cloudflare/sandbox` exposes `createBackup({ dir, name, ttl, localBucket })`
  and `restoreBackup(backup)`. Backups are compressed squashfs archives
  stored in R2 with copy-on-write restore. This is available now.
- Native VM-level snapshots (`persistAcrossSessions = { type: "disk" }`) are
  rolling out but not yet live (docs say "coming soon"). Backups are the
  production-viable primitive until then.

## Gap in the current Olam Cloudflare worker

`packages/cloudflare-worker/src/index.ts` already snapshots `/workspace` on
`handleSessionEnd` and stores the `DirectoryBackup` handle in `ARTIFACT_ARCHIVE`
(`snapshots/${sessionId}.tar.gz`).

However, neither `/session/start` nor `/session/:id/resume` attempts to restore
that backup. After the container sleeps, the next call finds a fresh disk and
recreates state from scratch (clone repos, re-inject creds). The workspace is
lost and the engineer must re-run setup.

## Recommended patch

Two small, additive changes close the loop:

1. Restore the latest backup on `/session/:id/resume` before re-injecting
   credentials.
2. Snapshot `/workspace` before the container is allowed to sleep, either in
   `handleSessionEnd` (already done) or by overriding `onActivityExpired` in
   `OlamSandbox` so an idle/autoscaled container leaves a recent checkpoint.

### Resume handler (`/session/:id/resume`)

Insert immediately after `const state = await sandbox.getWorldState()` succeeds:

```ts
// ---------------------------------------------------------------------------
// 0. Restore workspace snapshot if one exists. CF Sandbox disk is ephemeral;
//    the DO state (sessionMeta, phase) survives, but files do not.
// ---------------------------------------------------------------------------
let restoredBackupId: string | null = null;
try {
  const snapshotObj = await env.ARTIFACT_ARCHIVE.get(r2SnapshotKey(sid));
  if (snapshotObj) {
    const backup = (await snapshotObj.json()) as { id: string; dir: string };
    const restoreResult = await sandbox.restoreBackup(backup);
    if (restoreResult.success) {
      restoredBackupId = restoreResult.id;
      capture(
        { timestamp: Date.now(), type: 'snapshot_restored', data: { backupId: restoredBackupId, dir: restoreResult.dir } },
        sid,
      );
    }
  }
} catch (err) {
  capture(
    { timestamp: Date.now(), type: 'snapshot_restore_error', data: { error: err instanceof Error ? err.message : String(err) } },
    sid,
  );
  // Non-fatal: we still re-inject creds and try to warm up. A failed restore
  // is a degraded resume, not a hard failure.
}
```

### Per-pool `sleepAfter` for autoscalability

`sleepAfterForPool('default')` should return a bounded idle timeout per Olam
pool instead of the old `keepAlive: true` default. The existing
`/uat` route already does this; spread it to the standard agent-run pool:

```ts
const sandbox = getSandbox(env.Sandbox, sessionId, {
  transport: 'rpc',
  sleepAfter: sleepAfterForPool('agent-run'),
});
```

### Optional: snapshot before auto-sleep

Override `onActivityExpired` in `OlamSandbox` (`packages/cloudflare-worker/src/sandbox.ts`)
to checkpoint the workspace before the SDK destroys the container:

```ts
export interface OlamSandboxEnv {
  readonly Sandbox: DurableObjectNamespace<OlamSandbox>;
  readonly ARTIFACT_ARCHIVE: R2Bucket;
}

export class OlamSandbox extends Sandbox<OlamSandboxEnv> {
  // ... existing worldState helpers ...

  async onActivityExpired(): Promise<void> {
    const state = this.worldState;
    if (state?.sessionMeta) {
      const sid = state.sessionMeta.sessionId;
      try {
        const backup = await this.createBackup({ dir: '/workspace', name: `pre-sleep-${sid}` });
        await this.env.ARTIFACT_ARCHIVE.put(r2SnapshotKey(sid), JSON.stringify(backup));
      } catch (err) {
        console.warn(`[olam-sandbox] ${sid}: pre-sleep snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await super.onActivityExpired();
  }
}
```

This requires `ARTIFACT_ARCHIVE` to be added to `OlamSandboxEnv` and the
`r2SnapshotKey` helper to be importable from `sandbox.ts` (or duplicated as a
local constant). If this proves too coupled, the simpler first step is to rely
on `handleSessionEnd` snapshots plus an explicit `sleepAfter` short enough that
sessions end before long idle periods, and the dashboard calls `/session/end`
before the container sleeps.

## Why this is safe

- The backup handle stored in R2 contains only a UUID + directory; the actual
  archive is in the account's R2 bucket. TTL is enforced at restore time.
- `restoreBackup` with copy-on-write overlays means new writes do not mutate the
  archive, so a restore is idempotent and forkable.
- `useGitignore: true` can be used for `/workspace` repos to skip `node_modules`
  and `dist/`, keeping snapshots small and fast.

## Performance expectations

- Cold container start from a fresh image: 1–3 s + git clone + npm install.
- Restore from a backup: Cloudflare docs report ~2 s for a workspace like
  `axios` + npm install vs. 30 s cold. Olam's `/workspace` snapshots should be
  in the same ballpark, bounded by repo size.
- The DO phase state and session metadata are already sub-second because they
  live in SQLite-backed DO storage.

## Local experiment

A minimal standalone Worker is in `experiments/cf-sandbox-snapshot/`:

- `wrangler.jsonc` binds a `Sandbox` DO + `BACKUP_BUCKET` R2 bucket.
- `src/index.ts` exposes `/write`, `/read`, `/snapshot`, `/restore`, `/sleep`, `/run`.
- `npx wrangler deploy --dry-run` passes (validates bindings + types).

Live `wrangler dev` is blocked on this environment by a known `proxy-everything`
sidecar issue (`Fatal error: setsockoptint: operation not supported`) that occurs
on older Ubuntu 20.04 / kernel 5.15 Docker hosts. It is tracked in the sandbox
SDK issue tracker and works on newer kernels. To test the full sleep/resume
loop, run `npx wrangler dev` on a host with the supported Docker/kernel combo,
then:

```bash
curl -X POST -d "hello-$(date +%s)" 'http://localhost:8787/write?id=test-1'
curl -X POST 'http://localhost:8787/snapshot?id=test-1'
curl -X POST 'http://localhost:8787/sleep?id=test-1'
curl -X POST 'http://localhost:8787/restore?id=test-1'
curl 'http://localhost:8787/read?id=test-1'
```

## Integration points for `claude-control`

`claude-control` already polls `/api/session-health` and calls
`/session/:id/resume` when `tmuxAlive=false` or `claudeRunning=false`. Once the
Olam worker restores the workspace snapshot on resume, the existing
`claude-control` flow will reconnect to the same DO, get the same sessionId,
have the restored files, and have fresh creds re-injected — matching the
"Devin sleeps but resumes" behavior from the engineer's perspective.

No `claude-control` UI changes are required; the only change is on the Olam
Cloudflare Worker side.

## Next steps

1. Apply the resume-handler restore to `packages/cloudflare-worker/src/index.ts`
   in the Olam repo and add regression tests with a mocked `restoreBackup`.
2. Set `sleepAfter` per pool and remove `keepAlive` defaults for agent-run pools.
3. Run the live smoke test on a real CF Containers account (not local dev) using
   the `experiments/cf-sandbox-snapshot` Worker to measure backup/restore
   latency on a realistic workspace.
4. When `persistAcrossSessions` snapshots reach GA, migrate from manual
   `createBackup`/`restoreBackup` to `class OlamSandbox extends Sandbox {
     persistAcrossSessions = { type: 'disk' };
     sleepAfter = '10m';
   }`.
