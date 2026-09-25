/**
 * ACP fs/* host. Absolute paths only. Writes/reads must stay inside the
 * session cwd or an explicit extra root.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

function rpcError(code, message) {
  const err = new Error(message);
  err.rpc = { code, message };
  return err;
}

/** @param {string} root @param {string} target */
export function isInsideRoot(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {{ getCwd: () => string, extraRoots?: string[] }} opts
 */
export function createFsHost({ getCwd, extraRoots = [] }) {
  async function assertAllowed(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw rpcError(-32602, 'fs path must be absolute');
    }
    const resolved = path.resolve(filePath);
    const rawRoots = [path.resolve(getCwd() || process.cwd()), ...extraRoots.map((r) => path.resolve(r))];
    const roots = [];
    for (const r of rawRoots) {
      try { roots.push(await fs.realpath(r)); } catch { roots.push(r); }
    }
    let real = resolved;
    try {
      real = await fs.realpath(resolved);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      try {
        real = path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
      } catch (err2) {
        if (err2?.code !== 'ENOENT') throw err2;
      }
    }
    if (!roots.some((r) => isInsideRoot(r, real))) {
      throw rpcError(-32603, `path outside allowed roots: ${filePath}`);
    }
    return real;
  }

  return {
    async readTextFile(params) {
      const filePath = await assertAllowed(params?.path);
      const content = await fs.readFile(filePath, 'utf8');
      return { content };
    },
    async writeTextFile(params) {
      const filePath = await assertAllowed(params?.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(params?.content ?? ''), 'utf8');
      return {};
    },
  };
}
