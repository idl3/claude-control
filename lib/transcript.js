// lib/transcript.js — bounded transcript tailing for claude-cockpit.
// Resource doctrine: NEVER read a whole file. Initial load reads only the last
// min(size, TAIL_MAX_BYTES) bytes (tail), then watches and reads ONLY new bytes
// via offset. Files can be 200 MB+; whole-file reads will blow RAM.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';

// Env lookup mirroring server.js: prefer CLAUDE_CONTROL_<X>, fall back to the
// legacy COCKPIT_<X> so existing launchers keep working after the rename.
function envInt(name) {
  const raw =
    process.env[`CLAUDE_CONTROL_${name}`] ?? process.env[`COCKPIT_${name}`];
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Initial-tail byte cap. A fresh subscribe reads only the last min(size,
// TAIL_MAX_BYTES) bytes of the JSONL (NEVER the whole file — transcripts reach
// 200 MB+). In busy sessions a single assistant turn can carry hundreds of KB
// of tool output, so the old 1 MB window held only a handful of messages and
// the user's own recent turns fell outside it — they vanished on reload.
//
// 8 MB is the balance point: at a few KB/record it yields several hundred to a
// few thousand messages (enough that the message-count cap, not bytes, governs
// what a fresh subscribe serves), while staying ~25x below the largest real
// files and bounded per open session. A phone renders a capped subset anyway.
// Override with CLAUDE_CONTROL_TAIL_BYTES (legacy: COCKPIT_TAIL_BYTES).
const TAIL_MAX_BYTES = envInt('TAIL_BYTES') ?? 8 * 1024 * 1024; // 8 MB

// Default message-count cap for the in-memory buffer. Raised 1500 → 4000 so a
// fresh subscribe serves deeper scrollback (within the 8 MB tail window the
// count cap, not the byte window, governs how much history is served). At a few
// hundred bytes/normalized message this is a few MB resident per open session,
// well within the server's RSS budget.
// Override with CLAUDE_CONTROL_MAX_BUFFER (legacy: COCKPIT_MAX_BUFFER).
const DEFAULT_MAX_BUFFER = envInt('MAX_BUFFER') ?? 4000;
const DEFAULT_POLL_MS = envInt('TAIL_POLL_MS') ?? 1000;

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

function isCompleteJsonLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
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

  // A message typed while the agent is busy is stored by Claude Code as a
  // `queued_command` attachment — NOT a type=user record. Surface human prompt
  // queues as user messages so they render as a real bubble AND let the cockpit's
  // optimistic send bubble reconcile (it matches on user-message text). Marked
  // queued:true so convert drops it if the same text later lands as a type=user.
  if (rawType === 'attachment' && record.attachment?.type === 'queued_command') {
    const a = record.attachment;
    if (a.origin?.kind !== 'human' || a.commandMode !== 'prompt') return null;
    const prompt = typeof a.prompt === 'string' ? a.prompt : '';
    if (!prompt.trim()) return null;
    return {
      uuid: record.uuid ?? null,
      role: 'user',
      ts: record.timestamp ?? null,
      blocks: [{ kind: 'text', text: prompt }],
      rawType: 'queued_command',
      queued: true,
    };
  }

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

      } else if (btype === 'image') {
        // A pasted/typed image attachment (Claude Code strips the path token
        // out of the visible text and represents it as its own base64 content
        // block). We deliberately do NOT surface the base64 payload — the
        // client only needs to know an image landed, to reconcile an
        // image-only optimistic send (no accompanying text block at all) in
        // pendingSend.ts's echoMatches.
        blocks.push({ kind: 'image' });

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
export class TranscriptTailer extends EventEmitter {
  /**
   * @param {string} filePath
   * @param {{ maxBuffer?: number, debounceMs?: number, pollMs?: number, watch?: boolean, parser?: Function, tailBytes?: number, snapshotOnly?: boolean }} options
   */
  constructor(
    filePath,
    {
      maxBuffer = DEFAULT_MAX_BUFFER,
      debounceMs = 150,
      pollMs = DEFAULT_POLL_MS,
      watch = true,
      parser = parseRecord,
      tailBytes = TAIL_MAX_BYTES,
      snapshotOnly = false,
    } = {},
  ) {
    super();
    this._filePath = filePath;
    this._maxBuffer = maxBuffer;
    this._debounceMs = debounceMs;
    this._pollMs = Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 0;
    this._watchEnabled = watch !== false;
    this._parse = parser;
    this._tailBytes = Number.isFinite(tailBytes) && tailBytes > 0
      ? Math.floor(tailBytes)
      : TAIL_MAX_BYTES;
    this._snapshotOnly = snapshotOnly === true;

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

    /** Poll fallback timer handle */
    this._pollTimer = null;

    /** Debounce timer handle */
    this._debounceTimer = null;

    /** Serializes _readIncremental so two reads can't double-consume bytes. */
    this._reading = false;

    /** Set by stop(); guards against attaching a watcher after teardown. */
    this._stopped = false;

    /** start() is one-shot even when watch=false and polling owns the tail. */
    this._started = false;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Absolute path of the JSONL file this tailer is pinned to. */
  get filePath() {
    return this._filePath;
  }

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
    if (this._started) return;
    this._started = true;

    try {
      await this._initialLoad();
    } catch (err) {
      this._started = false;
      this.emit('error', err);
      return;
    }

    // stop() may have been called while the bounded tail read was awaiting
    // (e.g. the subscribing client disconnected mid-load). Don't attach a
    // watcher to a tailer nobody is listening to — that would leak an fd.
    if (this._stopped) return;

    // Historical sub-agent transcripts are loaded on demand. They need a
    // bounded snapshot, not a permanent fs watcher and interval. Keeping this
    // mode in the shared tailer preserves parsing semantics without consuming
    // an fd/timer for every old agent file.
    if (this._snapshotOnly) return;

    // Start watching. Use 'rename' events too (handles log rotation). fs.watch
    // is best-effort on macOS and network filesystems, so a poll fallback below
    // is intentionally kept active even when the watcher starts successfully.
    if (this._watchEnabled) {
      try {
        this._watcher = fs.watch(this._filePath, { persistent: false }, () => {
          this._scheduleRead();
        });
        this._watcher.on('error', (err) => this.emit('error', err));
      } catch (err) {
        if (!this._pollMs) {
          this._started = false;
          this.emit('error', err);
          return;
        }
      }
    }

    if (this._pollMs) {
      this._pollTimer = setInterval(() => {
        this._readIncremental().catch((err) => {
          if (err.code !== 'ENOENT') this.emit('error', err);
        });
      }, this._pollMs);
      if (this._pollTimer.unref) this._pollTimer.unref();
    }

    if (!this._watcher && !this._pollTimer) {
      this._started = false;
      this.emit('error', new Error('TranscriptTailer has neither watch nor poll enabled'));
      return;
    }

    // Bridge the race window: bytes may have arrived between the initial stat
    // (which set this._offset) and the watcher being registered by the OS.
    // Kick off an immediate incremental read to catch any bytes missed in that gap.
    // Use setImmediate to let the watcher finish OS-level registration first.
    setImmediate(() => {
      if (this._stopped) return; // stop() was called before this fired
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
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ignore */ }
      this._watcher = null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Load a bounded tail, parse it, populate the buffer, and set the offset. */
  async _initialLoad() {
    const { buf, readFrom, fileSize } = await readTail(this._filePath, this._tailBytes);
    this._offset = fileSize;

    if (buf.length === 0) return;

    const text = buf.toString('utf8');
    let lines = text.split('\n');

    // If we started reading mid-file, the first segment is a partial line.
    // Drop it unless we read from byte 0.
    if (readFrom > 0) {
      lines = lines.slice(1);
    }

    // Trailing partial: if text doesn't end with \n, the last element may be an
    // in-progress record. Codex can flush a complete final JSON object before
    // the newline; parse that immediately so live subscribers do not wait for a
    // later write or page reload.
    this._leftover = '';
    if (text.length > 0 && text[text.length - 1] !== '\n') {
      const tail = lines[lines.length - 1];
      if (!isCompleteJsonLine(tail)) {
        this._leftover = tail;
        lines = lines.slice(0, -1);
      }
    }

    const parsed = [];
    for (const line of lines) {
      const msg = this._parse(line);
      if (msg) {
        parsed.push(msg);
        this._trackPending(msg);
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

      // Last element: may be an incomplete line if no trailing newline. If it
      // is already a complete JSON record, process it now; a later bare newline
      // will be harmless.
      const trailing = lines[lines.length - 1];
      const trailingComplete = isCompleteJsonLine(trailing);
      this._leftover = trailingComplete ? '' : trailing;
      // Guard against a pathological never-newline-terminated line growing
      // without bound (honors the same 1 MB ceiling as the initial tail).
      if (this._leftover.length > this._tailBytes) this._leftover = '';
      const complete = trailingComplete ? lines : lines.slice(0, -1);

      const newMsgs = [];
      for (const line of complete) {
        const msg = this._parse(line);
        if (msg) {
          newMsgs.push(msg);
          this._trackPending(msg);
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

  /**
   * Inspect a newly-parsed message for AskUserQuestion tool_use blocks
   * (adds to pendingMap) and tool_result blocks (closes them).
   */
  _trackPending(msg) {
    for (const block of msg.blocks) {
      if (block.kind === 'tool_use' && block.name === 'AskUserQuestion') {
        // input.questions is the questions array per CONTRACT spec.
        const questions = Array.isArray(block.input?.questions)
          ? block.input.questions
          : [];
        this._pendingMap.set(block.id, {
          toolUseId: block.id,
          ts: msg.ts,
          questions,
        });
      } else if (block.kind === 'tool_result' && block.forId) {
        this._pendingMap.delete(block.forId);
      }
    }
  }

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
