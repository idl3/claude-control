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

// ---------------------------------------------------------------------------
// B3 — OlamTranscriptSource: shape stream with runner-feed degraded fallback
// ---------------------------------------------------------------------------

/**
 * Map a runner-status `feed` entry to a NormalizedMessage. Feed shape is the
 * runner's incremental event log (degraded mode only) — kept defensive: string
 * entries render as text, objects are summarised. Each entry is its own
 * single-block assistant message so ordering is preserved by feedCursor.
 */
function feedEntryToMessage(entry, idx) {
  const text = typeof entry === 'string' ? entry : JSON.stringify(entry);
  return {
    uuid: `feed:${idx}`,
    role: 'assistant',
    ts: null,
    blocks: [{ kind: 'text', text }],
  };
}

/**
 * The remote-session TranscriptSource cockpit's server subscribes to. Emits the
 * SAME `append` (messages) events as TranscriptTailer, plus a `banner` event
 * carrying `{ degraded: boolean, reason: string|null }` so the UI can show the
 * "log tail only" state. Full mode = Electric chunks shape; on shape auth/
 * network failure it transparently falls back to polling the runner feed.
 */
export class OlamTranscriptSource extends EventEmitter {
  /**
   * @param {import('./olam-client.js').OlamOrgClient} client
   * @param {{ worldId: string, sessionId: string, pool?: string|null, feedPollMs?: number, shapeOpts?: object, sleepImpl?: (ms:number)=>Promise<void> }} opts
   */
  constructor(client, { worldId, sessionId, pool = 'agentrun', feedPollMs = 3000, maxBuffer = 4000, shapeOpts = {}, sleepImpl }) {
    super();
    this.client = client;
    this.worldId = worldId;
    this.sessionId = sessionId;
    this.pool = pool || 'agentrun';
    this.feedPollMs = feedPollMs;
    this.shapeOpts = shapeOpts;
    this._sleep = sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._sub = null;
    this._feedCursor = 0;
    this._running = false;
    this.degraded = false;
    // In-memory buffer so a newly-connecting cockpit client (or a reconnect)
    // gets a snapshot — mirrors TranscriptTailer.getMessages(). Bounded to the
    // same maxBuffer the local tailer uses (default 4000).
    this._buffer = [];
    this._maxBuffer = maxBuffer;
    // Present the tailer surface: on('append') consumers + getMessages/trim.
    this.on('append', (messages) => {
      this._buffer.push(...messages);
      if (this._buffer.length > this._maxBuffer) {
        this._buffer.splice(0, this._buffer.length - this._maxBuffer);
      }
    });
  }

  // --- TranscriptTailer-compatible surface (server.js subscription paths) ---
  /** @returns {Array} buffered messages for a subscribe-time snapshot. */
  getMessages() {
    return this._buffer;
  }

  /** Remote sessions have no AskUserQuestion pending state in Phase B. */
  getPending() {
    return null;
  }

  /** Trim the buffer to the newest `keep` messages (memory-pressure path). */
  trim(keep) {
    if (this._buffer.length > keep) this._buffer.splice(0, this._buffer.length - keep);
  }

  start() {
    if (this._running) return Promise.resolve();
    this._running = true;
    this._startShape();
    return Promise.resolve();
  }

  _startShape() {
    const sub = new ShapeSubscriber(this.client, {
      worldId: this.worldId,
      sessionId: this.sessionId,
      sleepImpl: this._sleep,
      ...this.shapeOpts,
    });
    this._sub = sub;
    sub.on('append', (messages) => this.emit('append', messages));
    sub.on('error', (err) => this.emit('error', err));
    sub.on('degraded', (reason) => {
      if (!this._running) return;
      this._enterDegraded(reason);
    });
    sub.start();
  }

  _enterDegraded(reason) {
    this.degraded = true;
    this.emit('banner', { degraded: true, reason: reason ?? 'shape unavailable — log tail only' });
    void this._feedLoop();
  }

  /** Degraded tail: poll runner status, emit NEW feed entries as messages. */
  async _feedLoop() {
    while (this._running && this.degraded) {
      let status;
      try {
        status = await this.client.runnerStatus(this.sessionId, this.pool);
      } catch {
        status = null; // transient — keep polling
      }
      if (status && Array.isArray(status.feed)) {
        // Runner-reset detection (CP3 audit): the runner may restart or truncate
        // its feed, so feedCursor can move BACKWARD. A monotonic Math.max cursor
        // would then slice past the fresh entries and silently skip them. When
        // the server's cursor (or the feed length) is below ours, the feed was
        // reset — rewind to it and re-emit from the new baseline.
        const serverCursor = typeof status.feedCursor === 'number' ? status.feedCursor : status.feed.length;
        if (serverCursor < this._feedCursor || status.feed.length < this._feedCursor) {
          // Reset: the new feed window has no positional relationship to what we
          // already emitted — replay the entire current window from 0. Prefers a
          // possible duplicate over the silent skip a monotonic cursor caused.
          this._feedCursor = 0;
        }
        if (status.feed.length > this._feedCursor) {
          const fresh = status.feed.slice(this._feedCursor);
          const messages = fresh.map((e, i) => feedEntryToMessage(e, this._feedCursor + i));
          if (messages.length) this.emit('append', messages);
          this._feedCursor = status.feed.length;
        }
      }
      if (this._running && this.degraded) await this._sleep(this.feedPollMs);
    }
  }

  stop() {
    this._running = false;
    if (this._sub) this._sub.stop();
  }
}
