import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

export type Db = DatabaseSync;

const DEFAULT_DB_PATH = resolve(homedir(), '.collab', 'collab.db');

/** Resolve the store path from `$COLLAB_DB`, defaulting to `~/.collab/collab.db`. */
export function resolveDbPath(envValue: string | undefined = process.env.COLLAB_DB): string {
  if (!envValue || envValue.trim() === '') {
    return DEFAULT_DB_PATH;
  }
  return resolve(envValue);
}

/**
 * Open (or create) the SQLite store at `dbPath`, applying WAL pragmas and the
 * schema DDL. Safe to call from many processes concurrently — each gets its
 * own connection to the same file; WAL serializes writers.
 */
export function openDb(dbPath: string = resolveDbPath()): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  }
  // `timeout` (busy-timeout, ms) is passed at open time — not just via the
  // PRAGMA below — because the very first write on a fresh/contended file is
  // often the `journal_mode = WAL` conversion itself, which needs SQLite's
  // busy handler active *before* that statement runs, not after.
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  return db;
}

/** Run `fn` inside a single SQLite transaction; rolls back on throw. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
