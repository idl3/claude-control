/**
 * lib/olam-transcript.js — chunks-substrate TranscriptSource for a remote
 * olam session (Phase B). Two responsibilities:
 *
 *   ShapeSubscriber (B1) — long-polls the org's Electric chunks shape for one
 *     (world_id, session_id) with offset/handle resumption + clean teardown.
 *   chunksToMessages (B2) — maps chunk rows → the SAME NormalizedMessage shape
 *     lib/transcript.js emits, so cockpit's existing renderer + WS `append`
 *     fan-out are reused unmodified.
 *
 * Electric long-poll protocol (self-hosted, proxied by plan-chat-spa):
 *   - initial:   GET .../v1/shape?table=chunks&world_id&session_id&offset=-1
 *   - response:  JSON array of Electric messages; response carries
 *                electric-offset, electric-handle, electric-up-to-date headers
 *   - live:      GET ...&offset=<off>&handle=<h>&live=true  (long-poll)
 *   - 409:       handle rotated/expired → drop handle, re-init from offset=-1
 *
 * Auth is the two-layer SPA recipe (CF Access JWT + app bearer), owned by
 * OlamOrgClient.apiFetch — this module never touches secrets.
 */
import { EventEmitter } from 'node:events';

/** Thrown when the shape can't be authed — caller falls to degraded mode. */
export class DegradedRequired extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'DegradedRequired';
    this.code = 'DEGRADED_REQUIRED';
  }
}

// ---------------------------------------------------------------------------
// B2 — chunk row → NormalizedMessage mapping
// ---------------------------------------------------------------------------

// Chunk row (olam chunks table): { world_id, session_id, message_id, seq,
//   actor_id, actor_type: 'agent'|'operator'|'codex'|'system',
//   role: 'user'|'assistant'|'tool'|'system', chunk: TEXT,
//   chunk_type: 'text'|'tool_use'|'goal_mode_assumption'|..., created_at }
//
// NormalizedMessage (lib/transcript.js): { uuid, role: 'user'|'assistant',
//   ts, blocks: [{kind:'text'|'thinking'|'tool_use'|'tool_result', ...}] }
//
// A message_id groups its seq-ordered chunks into one bubble. Roles collapse to
// the renderer's binary user/assistant (tool/system → assistant-side blocks).

function chunkRole(row) {
  return row.role === 'user' ? 'user' : 'assistant';
}

/** One chunk row → one Block (or null to skip). */
function chunkToBlock(row) {
  const text = typeof row.chunk === 'string' ? row.chunk : '';
  switch (row.chunk_type) {
    case 'tool_use': {
      // Persisted as text (often JSON); surface as a tool_use block so the
      // renderer shows the tool affordance. Best-effort name/input parse.
      let name = 'tool';
      let input = {};
      try {
        const parsed = JSON.parse(text);
        name = parsed.name ?? parsed.tool ?? name;
        input = parsed.input ?? parsed.arguments ?? parsed;
      } catch {
        input = { raw: text };
      }
      return { kind: 'tool_use', id: `${row.message_id}:${row.seq}`, name, input, inputSummary: name };
    }
    case 'agent_exit':
    case 'sandbox_resource_exhausted':
      return { kind: 'text', text: `⚠️ ${row.chunk_type}: ${text}` };
    case 'goal_mode_assumption':
      return { kind: 'thinking', text };
    case 'run_usage':
    case 'dispatch_overflow':
      return text ? { kind: 'text', text } : null;
    case 'text':
    default:
      return text ? { kind: 'text', text } : null;
  }
}

/**
 * Group seq-ordered chunk rows into NormalizedMessages by message_id.
 * Rows must be pre-sorted by (message_id insertion order, seq) — Electric
 * delivers them in insert order, which is seq order per message.
 *
 * @param {Array<object>} rows chunk rows
 * @returns {Array<{uuid, role, ts, blocks}>}
 */
export function chunksToMessages(rows) {
  const byMessage = new Map();
  const order = [];
  for (const row of rows) {
    if (!row || typeof row.message_id !== 'string') continue;
    if (!byMessage.has(row.message_id)) {
      byMessage.set(row.message_id, {
        uuid: row.message_id,
        role: chunkRole(row),
        ts: row.created_at ?? null,
        blocks: [],
      });
      order.push(row.message_id);
    }
    const msg = byMessage.get(row.message_id);
    const block = chunkToBlock(row);
    if (block) msg.blocks.push(block);
  }
  // Drop messages that ended up with no renderable blocks.
  return order.map((id) => byMessage.get(id)).filter((m) => m.blocks.length > 0);
}

// ---------------------------------------------------------------------------
// B1 — Electric shape long-poll subscriber
// ---------------------------------------------------------------------------

const CONTROL_UP_TO_DATE = 'up-to-date';

/**
 * Parse an Electric shape response body (array of messages) into chunk rows.
 * Electric messages: { headers:{operation:'insert'|'update'|'delete'|control},
 * key, value }. We take insert/update `value`s (the chunk row); control
 * messages carry no row.
 */
function electricRows(body) {
  if (!Array.isArray(body)) return [];
  const rows = [];
  for (const m of body) {
    const op = m?.headers?.operation;
    if ((op === 'insert' || op === 'update') && m.value) rows.push(m.value);
  }
  return rows;
}

export class ShapeSubscriber extends EventEmitter {
  /**
   * @param {import('./olam-client.js').OlamOrgClient} client
   * @param {{ worldId: string, sessionId: string, backfillCap?: number, liveTimeoutMs?: number }} opts
   */
  constructor(client, { worldId, sessionId, backfillCap = 2000, livePollDelayMs = 500, sleepImpl } = {}) {
    super();
    this.client = client;
    this.worldId = worldId;
    this.sessionId = sessionId;
    this.backfillCap = backfillCap;
    // Delay between live long-polls. Electric holds `live=true` requests open
    // (~20s), but a misconfigured/instant-returning endpoint must not be
    // hot-looped — the delay bounds request rate AND yields the event loop.
    this.livePollDelayMs = livePollDelayMs;
    this._sleep = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._offset = '-1';
    this._handle = null;
    this._running = false;
    this._backfilled = 0;
  }

  _shapePath({ live }) {
    const p = new URLSearchParams({
      table: 'chunks',
      world_id: this.worldId,
      session_id: this.sessionId,
      offset: this._offset,
    });
    if (this._handle) p.set('handle', this._handle);
    if (live) p.set('live', 'true');
    return `/api/plan-chat/v1/shape?${p.toString()}`;
  }

  /** One shape request; updates offset/handle, emits mapped append events. */
  async _poll({ live }) {
    let res;
    try {
      res = await this.client.apiFetch(this._shapePath({ live }));
    } catch (err) {
      throw new DegradedRequired(String(err?.message ?? err));
    }
    if (res.status === 401 || res.status === 403) {
      throw new DegradedRequired(`shape auth ${res.status}`);
    }
    if (res.status === 409) {
      // Handle rotated/expired — re-init from the beginning next poll.
      this._handle = null;
      this._offset = '-1';
      this._backfilled = 0;
      return { upToDate: false };
    }
    if (!res.ok) {
      throw new Error(`[${this.client.org}] shape HTTP ${res.status}`);
    }
    const nextOffset = res.headers.get('electric-offset');
    const nextHandle = res.headers.get('electric-handle');
    if (nextOffset) this._offset = nextOffset;
    if (nextHandle) this._handle = nextHandle;

    const body = await res.json().catch(() => []);
    let rows = electricRows(body);
    // Bounded initial backfill (row-count analogue of the transcript tailer's
    // byte bounds) — cap what a fresh subscribe replays, live tail is unbounded.
    if (this._backfilled < this.backfillCap) {
      const room = this.backfillCap - this._backfilled;
      if (rows.length > room) rows = rows.slice(-room);
      this._backfilled += rows.length;
    }
    if (rows.length > 0) {
      const messages = chunksToMessages(rows);
      if (messages.length > 0) this.emit('append', messages);
    }
    const upToDate = Array.isArray(body)
      ? body.some((m) => m?.headers?.control === CONTROL_UP_TO_DATE)
      : false;
    return { upToDate };
  }

  /** Long-poll loop until stop(). Emits 'append' (messages) and 'degraded' (reason). */
  async start() {
    if (this._running) return;
    this._running = true;
    try {
      // Drain the snapshot to up-to-date first (offset advances each page).
      let done = false;
      while (this._running && !done) {
        const { upToDate } = await this._poll({ live: false });
        done = upToDate;
      }
      // Live long-poll tail.
      while (this._running) {
        await this._poll({ live: true });
        if (this._running && this.livePollDelayMs > 0) await this._sleep(this.livePollDelayMs);
      }
    } catch (err) {
      if (err instanceof DegradedRequired) {
        this.emit('degraded', err.message);
      } else if (this._running) {
        this.emit('error', err);
      }
    } finally {
      this._running = false;
    }
  }

  stop() {
    this._running = false;
  }
}
