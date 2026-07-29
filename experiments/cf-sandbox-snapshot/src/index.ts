import { getSandbox, type DirectoryBackup } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

const SNAPSHOT_KEY = (id: string) => `snapshot:${id}`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get('id') ?? 'default';
    const sandbox = getSandbox(env.Sandbox, id);

    if (url.pathname === '/') {
      return Response.json({
        id,
        routes: [
          'POST /write?id=... body=text',
          'GET  /read?id=...',
          'POST /snapshot?id=...',
          'POST /restore?id=...',
          'POST /sleep?id=...',
          'POST /run?id=...&cmd=...',
        ],
      });
    }

    if (url.pathname === '/write') {
      const text = await request.text() || String(Date.now());
      await sandbox.writeFile('/workspace/state.txt', text);
      return Response.json({ id, wrote: text });
    }

    if (url.pathname === '/read') {
      try {
        const file = await sandbox.readFile('/workspace/state.txt');
        return Response.json({ id, content: file.content });
      } catch (err) {
        return Response.json({ id, error: 'no state file' }, { status: 404 });
      }
    }

    if (url.pathname === '/snapshot') {
      const backup = await sandbox.createBackup({
        dir: '/workspace',
        name: `snap-${id}`,
        localBucket: true,
      });
      await env.BACKUP_BUCKET.put(SNAPSHOT_KEY(id), JSON.stringify(backup));
      return Response.json({ id, backupId: backup.id, dir: backup.dir });
    }

    if (url.pathname === '/restore') {
      const stored = await env.BACKUP_BUCKET.get(SNAPSHOT_KEY(id));
      if (!stored) {
        return Response.json({ id, error: 'no snapshot stored' }, { status: 404 });
      }
      const backup = (await stored.json()) as DirectoryBackup;
      const result = await sandbox.restoreBackup(backup);
      return Response.json({ id, restored: result.success, backupId: result.id, dir: result.dir });
    }

    if (url.pathname === '/sleep') {
      await sandbox.destroy();
      return Response.json({ id, slept: true });
    }

    if (url.pathname === '/run') {
      const cmd = url.searchParams.get('cmd') ?? 'cat /workspace/state.txt';
      const result = await sandbox.exec(cmd);
      return Response.json({ id, ...result });
    }

    return new Response('Not found', { status: 404 });
  },
};
