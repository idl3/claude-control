/**
 * DDL — single source of truth for the collab-engine store. Applied once at
 * open with idempotent `CREATE TABLE IF NOT EXISTS`. See docs/design/collab-engine.md §3.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS streams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  harness       TEXT NOT NULL,
  role          TEXT,
  worktree      TEXT,
  branch        TEXT,
  cwd           TEXT,
  capabilities  TEXT,
  stream_id     TEXT REFERENCES streams(id),
  status        TEXT NOT NULL DEFAULT 'active',
  inbox_cursor  INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_stream    ON agents(stream_id);
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id  TEXT REFERENCES streams(id),
  from_agent TEXT,
  to_agent   TEXT,
  kind       TEXT NOT NULL DEFAULT 'msg',
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_to     ON messages(to_agent, id);
CREATE INDEX IF NOT EXISTS idx_messages_stream ON messages(stream_id, id);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT REFERENCES streams(id),
  title         TEXT NOT NULL,
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  owner_agent_id TEXT REFERENCES agents(id),
  priority      INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_stream_status ON tasks(stream_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner         ON tasks(owner_agent_id);

CREATE TABLE IF NOT EXISTS boundaries (
  id            TEXT PRIMARY KEY,
  stream_id     TEXT REFERENCES streams(id),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  patterns      TEXT NOT NULL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  released_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_boundaries_active ON boundaries(released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_boundaries_owner  ON boundaries(owner_agent_id);
`;
