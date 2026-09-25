/**
 * NDJSON JSON-RPC 2.0 over a child process stdin/stdout.
 * One JSON object per line. Non-JSON stdout is ignored (logged as stderr).
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const DEFAULT_TIMEOUT_MS = 30_000;

export class AcpJsonRpc extends EventEmitter {
  /**
   * @param {import('node:child_process').ChildProcess} proc
   * @param {{ timeoutMs?: number }} [opts]
   */
  constructor(proc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this._proc = proc;
    this._timeoutMs = timeoutMs;
    this._pending = new Map();
    this._nextId = 1;
    this._handler = null;
    this._closed = false;

    if (!proc.stdout) throw new Error('ACP process has no stdout');
    this._rl = createInterface({ input: proc.stdout });
    this._rl.on('line', (line) => { void this._onLine(line); });

    proc.stderr?.on('data', (buf) => {
      this.emit('stderr', String(buf));
    });
    proc.on('error', (err) => {
      this.emit('error', err);
    });
    proc.on('exit', (code, signal) => {
      this._closed = true;
      for (const [, p] of this._pending) {
        p.reject(Object.assign(new Error('agent exited'), { code, signal }));
      }
      this._pending.clear();
      this.emit('exit', { code, signal });
    });
  }

  /** @param {(method: string, params: unknown) => Promise<unknown>|unknown} handler */
  setRequestHandler(handler) {
    this._handler = handler;
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<unknown>}
   */
  request(method, params) {
    if (this._closed || !this._proc.stdin?.writable) {
      return Promise.reject(new Error('agent stdin not writable'));
    }
    const id = `c-${this._nextId++}`;
    return new Promise((resolve, reject) => {
      const timeoutMs = method === 'session/prompt'
        ? 0
        : this._timeoutMs;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (!this._pending.has(id)) return;
            this._pending.delete(id);
            reject(Object.assign(new Error(`rpc timeout: ${method}`), { method }));
          }, timeoutMs)
        : null;
      if (timer?.unref) timer.unref();
      this._pending.set(id, { resolve, reject, method, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        if (timer) clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** @param {string} method @param {unknown} [params] */
  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async close(signal = 'SIGTERM') {
    if (this._closed) return;
    this._closed = true;
    try { this._rl?.close(); } catch { /* ignore */ }
    if (this._proc && !this._proc.killed) {
      try { this._proc.kill(signal); } catch { /* ignore */ }
      const proc = this._proc;
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 2000);
        if (t.unref) t.unref();
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }

  _send(msg) {
    if (!this._proc.stdin?.writable) throw new Error('agent stdin not writable');
    this.emit('rpc_send', msg);
    this._proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  async _onLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('stderr', `non-json frame: ${line.slice(0, 120)}\n`);
      return;
    }
    this.emit('rpc_recv', msg);

    const id = msg.id;
    const method = msg.method;
    const isResponse = id != null && method == null && (msg.result !== undefined || msg.error !== undefined);

    if (isResponse) {
      const p = this._pending.get(id);
      if (!p) return;
      this._pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) {
        const err = Object.assign(new Error(msg.error.message || 'rpc error'), { rpc: msg.error });
        p.reject(err);
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (id != null && method) {
      try {
        if (!this._handler) throw methodNotFound(method);
        const result = await this._handler(method, msg.params);
        this._send({ jsonrpc: '2.0', id, result: result === undefined ? {} : result });
      } catch (err) {
        const rpc = err?.rpc && typeof err.rpc === 'object'
          ? err.rpc
          : { code: err?.rpc?.code ?? -32603, message: err?.message || 'internal error' };
        try { this._send({ jsonrpc: '2.0', id, error: rpc }); } catch { /* ignore */ }
      }
      return;
    }

    if (method) {
      this.emit('notification', { method, params: msg.params });
    }
  }
}

function methodNotFound(method) {
  const err = new Error(`Method not found: ${method}`);
  err.rpc = { code: -32601, message: err.message };
  return err;
}

/**
 * @param {{ command: string, args?: string[], cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} opts
 */
export function spawnAcpProcess({ command, args = [], cwd, env, timeoutMs }) {
  const proc = spawn(command, args, {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new AcpJsonRpc(proc, { timeoutMs });
}
