// lib/transcript.js — bounded transcript tailing for claude-cockpit.
// Resource doctrine: NEVER read a whole file. Initial load reads only the last
// min(size, 1 MB) bytes (tail), then watches and reads ONLY new bytes via offset.
// Files can be 200 MB+; whole-file reads will blow RAM.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const TAIL_MAX_BYTES = 1 * 1024 * 1024; // 1 MB initial tail cap

// ---------------------------------------------------------------------------
// Internal helper: read the last `maxBytes` of a file without loading it all.
// Returns a Buffer of at most maxBytes bytes from the end of the file.
// ---------------------------------------------------------------------------
async function readTail(filePath, maxBytes) {
  const stat = await fs.promises.stat(filePath);
  const size = stat.size;
  if (size === 0) return { buf: Buffer.alloc(0), readFrom: 0, fileSize: 0 };
  const readFrom = Math.max(0, size - maxBytes);
  const toRead = size - readFrom;
  const buf = Buffer.allocUnsafe(toRead);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let totalRead = 0;
    while (totalRead < toRead) {
      const { bytesRead } = await fh.read(buf, totalRead, toRead - totalRead, readFrom + totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return { buf: buf.slice(0, totalRead), readFrom, fileSize: size };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Read bytes [start, end) from an open path. Returns a Buffer.
// ---------------------------------------------------------------------------
async function readRange(filePath, start, end) {
  if (end <= start) return Buffer.alloc(0);
  const toRead = end - start;
  const buf = Buffer.allocUnsafe(toRead);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let totalRead = 0;
    while (totalRead < toRead) {
      const { bytesRead } = await fh.read(buf, totalRead, toRead - totalRead, start + totalRead);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return buf.slice(0, totalRead);
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Flatten tool_result content: string | {type:'text',text}[] -> string
// ---------------------------------------------------------------------------
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Build a one-line <=120-char summary of a tool_use input object.
// ---------------------------------------------------------------------------
function inputSummary(input) {
  if (input == null) return '';
  let s;
  try {
    s = JSON.stringify(input);
  } catch {
    s = String(input);
  }
  // Collapse newlines/tabs to spaces, then truncate.
  s = s.replace(/[\r\n\t]+/g, ' ');
  if (s.length > 120) s = s.slice(0, 117) + '...';
  return s;
}

// ---------------------------------------------------------------------------
// parseRecord(line) -> NormalizedMessage | null
//
// Parses one JSONL line. Only type:"user" and type:"assistant" produce messages.
// All other types (summary, last-prompt, tool, etc.) return null.
// ---------------------------------------------------------------------------
export function parseRecord(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let record;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const rawType = record.type;
  if (rawType !== 'user' && rawType !== 'assistant') return null;

  const msg = record.message;
  if (!msg) return null;

  const role = rawType; // 'user' | 'assistant'
  const uuid = record.uuid ?? null;
  const ts = record.timestamp ?? null;

  // Normalize content -> Block[]
  const rawContent = msg.content;
  let blocks = [];

  if (typeof rawContent === 'string') {
    // User prompt as plain string.
    blocks = [{ kind: 'text', text: rawContent }];
  } else if (Array.isArray(rawContent)) {
    for (const block of rawContent) {
      if (!block || typeof block !== 'object') continue;
      const btype = block.type;

      if (btype === 'text') {
        blocks.push({ kind: 'text', text: block.text ?? '' });

      } else if (btype === 'thinking') {
        blocks.push({ kind: 'thinking', text: block.thinking ?? block.text ?? '' });

      } else if (btype === 'tool_use') {
        blocks.push({
          kind: 'tool_use',
          id: block.id ?? null,
          name: block.name ?? '',
          input: block.input ?? {},
          inputSummary: inputSummary(block.input),
        });

      } else if (btype === 'tool_result') {
        blocks.push({
          kind: 'tool_result',
          forId: block.tool_use_id ?? null,
          text: flattenContent(block.content),
          isError: !!block.is_error,
        });
      }
      // Unknown block types are silently skipped.
    }
  }

  return { uuid, role, ts, blocks, rawType };
}

// ---------------------------------------------------------------------------
// TranscriptTailer — EventEmitter that tails a single JSONL transcript file.
//
// Events:
//   'append'  (msgs: NormalizedMessage[])   new messages parsed since last read
//   'pending' (p: Pending | null)           AskUserQuestion open/close state changed
//   'error'   (err)
// ---------------------------------------------------------------------------
// Default trackPending implementation — operates on an explicit pendingMap so
// it can be used both as the TranscriptTailer's built-in default and as the
// body ClaudeAdapter.trackPending delegates to. Must stay in sync with
// ClaudeAdapter.trackPending (lib/agents/claude.js).
function defaultTrackPending(msg, pendingMap) {
  for (const block of msg.blocks) {
    if (block.kind === 'tool_use' && block.name === 'AskUserQuestion') {
      // input.questions is the questions array per CONTRACT spec.
      const questions = Array.isArray(block.input?.questions)
        ? block.input.questions
        : [];
      pendingMap.set(block.id, {
        toolUseId: block.id,
        ts: msg.ts,
        questions,
      });
    } else if (block.kind === 'tool_result' && block.forId) {
      pendingMap.delete(block.forId);
    }
  }
}

export class TranscriptTailer extends EventEmitter {
  /**
   * @param {string} filePath
   * @param {{ maxBuffer?: number, debounceMs?: number, parseRecord?: Function, trackPending?: Function }} options
   */
  constructor(filePath, { maxBuffer = 500, debounceMs = 150, parseRecord: parseRecordOpt, trackPending: trackPendingOpt } = {}) {
    super();
    this._filePath = filePath;
    this._maxBuffer = maxBuffer;
    this._debounceMs = debounceMs;

    // Injected per-adapter functions (default to built-in Claude/local versions).
    // transcript.js must NOT import agents/* to avoid circular imports — use
    // module-local defaults instead.
    this._parseRecord = parseRecordOpt ?? parseRecord;
    this._trackPending = trackPendingOpt ?? defaultTrackPending;

    /** @type {import('./transcript.js').NormalizedMessage[]} */
    this._messages = [];

    /** Byte offset: next read starts here. */
    this._offset = 0;

    /** Partial line leftover from the last incremental read. */
    this._leftover = '';

    /** Map of open AskUserQuestion tool_use_id -> Pending */
    this._pendingMap = new Map();

    /** The currently-reported Pending (what we last emitted). null = none. */
    this._currentPending = null;

    /** fs.FSWatcher | null */
    this._watcher = null;

    /** Debounce timer handle */
    this._debounceTimer = null;

    /** Serializes _readIncremental so two reads can't double-consume bytes. */
    this._reading = false;

    /** Set by stop(); guards against attaching a watcher after teardown. */
    this._stopped = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Full buffered message list (up to maxBuffer most recent). */
  getMessages() {
    return this._messages.slice();
  }

  /** Most-recently-opened still-open Pending, or null. */
  getPending() {
    return this._currentPending;
  }

  /** Drop all but the most recent `keepN` buffered messages (memory pressure relief). */
  trim(keepN) {
    if (keepN >= 0 && this._messages.length > keepN) {
      this._messages = this._messages.slice(this._messages.length - keepN);
    }
  }

  /**
   * Perform the bounded initial tail load, set the byte offset, then start
   * watching for new data. Safe to call only once; calling again is a no-op
   * if already watching.
   */
  async start() {
    if (this._watcher) return;

    try {
      await this._initialLoad();
    } catch (err) {
      this.emit('error', err);
      return;
    }

    // stop() may have been called while the bounded tail read was awaiting
    // (e.g. the subscribing client disconnected mid-load). Don't attach a
    // watcher to a tailer nobody is listening to — that would leak an fd.
    if (this._stopped) return;

    // Start watching. Use 'rename' events too (handles log rotation).
    try {
      this._watcher = fs.watch(this._filePath, { persistent: false }, () => {
        this._scheduleRead();
      });
      this._watcher.on('error', (err) => this.emit('error', err));
    } catch (err) {
      this.emit('error', err);
      return;
    }

    // Bridge the race window: bytes may have arrived between the initial stat
    // (which set this._offset) and the watcher being registered by the OS.
    // Kick off an immediate incremental read to catch any bytes missed in that gap.
    // Use setImmediate to let the watcher finish OS-level registration first.
    setImmediate(() => {
      if (!this._watcher) return; // stop() was called before this fired
      this._readIncremental().catch((err) => {
        // ENOENT means the file was deleted/rotated; not a hard error here.
        if (err.code !== 'ENOENT') this.emit('error', err);
      });
    });
  }

  /** Stop watching, cancel any pending debounce. */
  stop() {
    this._stopped = true;
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ignore */ }
      this._watcher = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Load the last TAIL_MAX_BYTES, parse, populate buffer, set offset. */
  async _initialLoad() {
    const { buf, readFrom, fileSize } = await readTail(this._filePath, TAIL_MAX_BYTES);
    this._offset = fileSize;

    if (buf.length === 0) return;

    const text = buf.toString('utf8');
    let lines = text.split('\n');

    // If we started reading mid-file, the first segment is a partial line.
    // Drop it unless we read from byte 0.
    if (readFrom > 0) {
      lines = lines.slice(1);
    }

    // Trailing partial: if text doesn't end with \n, the last element is an
    // in-progress record. Carry it as leftover (offset already points past it),
    // so the next incremental read reassembles the full record instead of
    // dropping it.
    this._leftover = '';
    if (text.length > 0 && text[text.length - 1] !== '\n') {
      this._leftover = lines[lines.length - 1];
      lines = lines.slice(0, -1);
    }

    const parsed = [];
    for (const line of lines) {
      const msg = this._parseRecord(line);
      if (msg) {
        parsed.push(msg);
        this._trackPending(msg, this._pendingMap);
      }
    }

    // Cap buffer.
    const all = parsed;
    if (all.length > this._maxBuffer) {
      this._messages = all.slice(all.length - this._maxBuffer);
    } else {
      this._messages = all;
    }

    // Emit initial pending state (so a question already on-screen is detected).
    this._syncPending();
  }

  _scheduleRead() {
    if (this._debounceTimer !== null) return;
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._readIncremental().catch((err) => this.emit('error', err));
    }, this._debounceMs);
  }

  async _readIncremental() {
    if (this._stopped) return;
    // Serialize: if a read is already in flight, ask for another pass after it
    // finishes rather than double-consuming the same byte range.
    if (this._reading) {
      this._scheduleRead();
      return;
    }
    this._reading = true;
    try {
      let stat;
      try {
        stat = await fs.promises.stat(this._filePath);
      } catch (err) {
        this.emit('error', err);
        return;
      }

      const newSize = stat.size;

      // Truncation / log rotation: the file is effectively new. Re-initialize
      // from the bounded tail so we never read a multi-MB replacement in full.
      if (newSize < this._offset) {
        this._leftover = '';
        this._pendingMap.clear();
        await this._initialLoad();
        return;
      }

      if (newSize <= this._offset) return; // Nothing new.

      const rawBuf = await readRange(this._filePath, this._offset, newSize);
      this._offset = newSize;

      const chunk = this._leftover + rawBuf.toString('utf8');
      const lines = chunk.split('\n');

      // Last element: may be an incomplete line if no trailing newline.
      this._leftover = lines[lines.length - 1];
      // Guard against a pathological never-newline-terminated line growing
      // without bound (honors the same 1 MB ceiling as the initial tail).
      if (this._leftover.length > TAIL_MAX_BYTES) this._leftover = '';
      const complete = lines.slice(0, -1);

      const newMsgs = [];
      for (const line of complete) {
        const msg = this._parseRecord(line);
        if (msg) {
          newMsgs.push(msg);
          this._trackPending(msg, this._pendingMap);
        }
      }

      if (newMsgs.length > 0) {
        // Append to buffer, cap at maxBuffer.
        this._messages.push(...newMsgs);
        if (this._messages.length > this._maxBuffer) {
          this._messages = this._messages.slice(this._messages.length - this._maxBuffer);
        }
        this.emit('append', newMsgs);
      }

      this._syncPending();
    } finally {
      this._reading = false;
    }
  }

  // _trackPending has been replaced by the injected this._trackPending function
  // (defaulting to defaultTrackPending, defined above the class). The call
  // signature is now (msg, pendingMap) — the pendingMap is passed explicitly so
  // the same function body works as both the built-in default and as
  // ClaudeAdapter.trackPending.

  /**
   * Derive the effective pending (most-recently-opened still-open entry).
   * Emit 'pending' only when it actually changes.
   */
  _syncPending() {
    // Most-recently-opened = last entry in insertion order of the Map.
    let latest = null;
    for (const v of this._pendingMap.values()) {
      latest = v; // last wins (Map preserves insertion order)
    }

    // Compare by toolUseId; null == null.
    const prevId = this._currentPending?.toolUseId ?? null;
    const nextId = latest?.toolUseId ?? null;

    if (prevId !== nextId) {
      this._currentPending = latest;
      this.emit('pending', this._currentPending);
    }
  }
}
