/**
 * lib/collab.js — session-to-session collaboration core for claude-control.
 *
 * A "room" holds N members (each an agent session, Claude or Codex). A session
 * `open`s a room to advertise itself; others `list` + `join`. Members `post`
 * messages; each message is appended to a per-room JSONL log (the append-only
 * transcript) and returned to the OTHER members so the server can nudge them.
 * `read` pulls messages after a cursor; `history` replays the whole log so an
 * agent whose context was cleared can catch up (the `collab_remember` tool).
 *
 * This module is pure state + disk I/O — no tmux, no HTTP. The server wires it
 * to pane delivery + the session registry (see server.js /api/collab/*). Kept
 * hermetic: point `dir` at a temp path (or set CLAUDE_CONTROL_DIR) in tests.
 *
 * Persistence: room metadata + membership in `<dir>/registry.json` (rewritten
 * atomically); messages in `<dir>/<roomId>.jsonl` (append-only, never rewritten).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically-random lowercase base36 id of length n. */
function randId(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i += 1) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return s;
}

// roomId is generated internally (safe), but it also arrives from clients on
// join/read/etc. and is interpolated into a log FILENAME — so validate it as a
// tight slug before it ever touches the filesystem (no path traversal).
const ROOM_ID_RE = /^[a-z0-9-]{1,32}$/;
/** @returns {string|null} the id if it's a safe slug, else null. */
export function safeRoomId(id) {
  const s = String(id ?? '');
  return ROOM_ID_RE.test(s) ? s : null;
}

/** Default on-disk location: ~/.claude-control/collab (overridable via env). */
export function defaultCollabDir() {
  const base = process.env.CLAUDE_CONTROL_DIR || path.join(os.homedir(), '.claude-control');
  return path.join(base, 'collab');
}

/** Public (loggable) subset of a member — never persist transient handles. */
function pub(member) {
  return {
    paneId: member.paneId,
    sessionId: member.sessionId ?? null,
    kind: member.kind ?? null,
    title: member.title ?? null,
  };
}

/**
 * Filter a recipient list down to those whose session is currently idle. Pure so
 * it's unit-testable; the server passes the set of idle paneIds (derived from the
 * session registry's thinking/pending/compacting/errored flags + picker state).
 *
 * @param {Array<{paneId:string}>} recipients
 * @param {Iterable<string>} idlePaneIds
 */
export function idleRecipients(recipients, idlePaneIds) {
  const idle = new Set(idlePaneIds);
  return (recipients || []).filter((m) => idle.has(m.paneId));
}

export class Collab {
  /**
   * @param {{ dir?: string, now?: () => number }} [opts]
   *   `now` is injectable so tests get deterministic timestamps.
   */
  constructor({ dir = defaultCollabDir(), now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    /** @type {Map<string, any>} roomId -> room */
    this.rooms = new Map();
    /** @type {Map<string, string>} join code -> roomId */
    this.codes = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    this._load();
  }

  _registryPath() {
    return path.join(this.dir, 'registry.json');
  }

  _logPath(roomId) {
    const safe = safeRoomId(roomId);
    if (!safe) throw new Error('collab: invalid roomId');
    return path.join(this.dir, `${safe}.jsonl`);
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._registryPath(), 'utf8'));
    } catch {
      return; // fresh install
    }
    for (const r of raw.rooms || []) {
      r.members = new Map(Object.entries(r.members || {}));
      this.rooms.set(r.roomId, r);
      if (r.code) this.codes.set(r.code, r.roomId);
    }
  }

  _persist() {
    const rooms = [...this.rooms.values()].map((r) => ({
      ...r,
      members: Object.fromEntries(r.members),
    }));
    const tmp = `${this._registryPath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rooms }));
    fs.renameSync(tmp, this._registryPath()); // atomic swap
  }

  _append(roomId, rec) {
    fs.appendFileSync(this._logPath(roomId), `${JSON.stringify(rec)}\n`);
  }

  _readLog(roomId) {
    let txt;
    try {
      txt = fs.readFileSync(this._logPath(roomId), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }

  _room(roomId) {
    const safe = safeRoomId(roomId);
    const room = safe ? this.rooms.get(safe) : null;
    if (!room) throw new Error('collab: room not found');
    return room;
  }

  // --- API ---------------------------------------------------------------

  /** Advertise `member`'s session as open for collab; create + return a room. */
  open(member, { topic = '' } = {}) {
    const roomId = randId(6);
    const code = randId(4);
    const room = {
      roomId,
      code,
      topic: String(topic || ''),
      createdAt: this.now(),
      discoverable: true,
      seq: 0,
      members: new Map([[member.paneId, { ...pub(member), target: member.target, joinedAt: this.now() }]]),
    };
    this.rooms.set(roomId, room);
    this.codes.set(code, roomId);
    this._append(roomId, { ts: this.now(), roomId, seq: 0, type: 'open', from: pub(member), text: room.topic });
    this._persist();
    return { roomId, code, topic: room.topic };
  }

  /** Rooms currently discoverable — for the `collab_list` "find a collaborator". */
  listOpen() {
    return [...this.rooms.values()]
      .filter((r) => r.discoverable)
      .map((r) => ({
        roomId: r.roomId,
        code: r.code,
        topic: r.topic,
        createdAt: r.createdAt,
        members: [...r.members.values()].map((m) => ({ kind: m.kind, title: m.title })),
      }));
  }

  /** Add `member` to a room (by short code or roomId). */
  join(member, { code, roomId } = {}) {
    let rid = null;
    if (roomId && safeRoomId(roomId) && this.rooms.has(safeRoomId(roomId))) rid = safeRoomId(roomId);
    else if (code && this.codes.has(code)) rid = this.codes.get(code);
    if (!rid) throw new Error('collab: room not found');
    const room = this.rooms.get(rid);
    room.members.set(member.paneId, { ...pub(member), target: member.target, joinedAt: this.now() });
    room.seq += 1;
    this._append(rid, { ts: this.now(), roomId: rid, seq: room.seq, type: 'join', from: pub(member) });
    this._persist();
    return { roomId: rid, topic: room.topic, members: this.members(rid) };
  }

  /**
   * Append a message to the room log. Returns the new seq + the OTHER members
   * (recipients) so the caller can nudge them.
   */
  post(roomId, member, text) {
    const room = this._room(roomId);
    if (!room.members.has(member.paneId)) throw new Error('collab: not a member of this room');
    room.seq += 1;
    this._append(room.roomId, {
      ts: this.now(),
      roomId: room.roomId,
      seq: room.seq,
      type: 'message',
      from: pub(member),
      text: String(text ?? ''),
    });
    this._persist();
    const recipients = [...room.members.values()].filter((m) => m.paneId !== member.paneId);
    return { seq: room.seq, recipients };
  }

  /** Messages (+ join/leave) with seq strictly greater than `since`. */
  read(roomId, since = 0) {
    const room = this._room(roomId);
    const cursor = Number(since) || 0;
    const messages = this._readLog(room.roomId).filter(
      (r) => r.seq > cursor && (r.type === 'message' || r.type === 'join' || r.type === 'leave'),
    );
    return { roomId: room.roomId, seq: room.seq, messages };
  }

  /** The full append-only log — the `collab_remember` context-restore path. */
  history(roomId) {
    const room = this._room(roomId);
    return { roomId: room.roomId, topic: room.topic, seq: room.seq, log: this._readLog(room.roomId) };
  }

  members(roomId) {
    const room = this._room(roomId);
    return [...room.members.values()].map((m) => ({
      paneId: m.paneId,
      kind: m.kind,
      title: m.title,
      sessionId: m.sessionId,
      target: m.target,
      joinedAt: m.joinedAt,
    }));
  }

  /** Remove a member; close (undiscoverable) the room once empty. */
  leave(roomId, paneId) {
    const room = this._room(roomId);
    const m = room.members.get(paneId);
    if (!m) return { roomId: room.roomId, members: this.members(room.roomId) };
    room.members.delete(paneId);
    room.seq += 1;
    this._append(room.roomId, { ts: this.now(), roomId: room.roomId, seq: room.seq, type: 'leave', from: pub(m) });
    if (room.members.size === 0) room.discoverable = false;
    this._persist();
    return { roomId: room.roomId, members: this.members(room.roomId) };
  }
}
