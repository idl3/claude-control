// Bounded WebSocket sends for server fan-out.
//
// ws exposes `bufferedAmount` for bytes queued in userland / the kernel. If a
// browser tab is backgrounded or a phone network stalls, continuing to enqueue
// full transcript/resource frames can grow server memory without bound. Close
// the slow socket; the browser reconnects and resubscribes from the current
// bounded transcript buffer.

export const DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES = 32 * 1024 * 1024;

export function websocketBackpressureLimitBytes(env = process.env) {
  const raw = env.CLAUDE_CONTROL_WS_BUFFER_LIMIT_MB ?? env.COCKPIT_WS_BUFFER_LIMIT_MB;
  if (raw == null || raw === '') return DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES;
  return Math.floor(mb * 1024 * 1024);
}

export function encodeWsMessage(obj) {
  return typeof obj === 'string' ? obj : JSON.stringify(obj);
}

export function sendWsMessage(ws, encoded, { limitBytes = DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES } = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  const buffered = ws.bufferedAmount ?? 0;
  const encodedBytes = typeof encoded === 'string'
    ? Buffer.byteLength(encoded)
    : encoded?.byteLength ?? 0;
  if (buffered > limitBytes || buffered + encodedBytes > limitBytes) {
    try {
      ws.terminate?.();
    } catch {
      try { ws.close?.(1013, 'client too slow'); } catch { /* ignore */ }
    }
    return false;
  }
  try {
    ws.send(encoded);
  } catch {
    return false;
  }
  return true;
}
