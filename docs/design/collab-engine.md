# Collab Engine — cross-harness agent collaboration

A lightweight, harness-agnostic engine that lets AI coding agents — running under
**Claude Code, Codex, or OpenCode** — talk to each other, share a task board,
declare work boundaries, coordinate worktrees, and hand off work. No daemon, no
port, no external service.

> **Status:** MVP. Standalone package `collab-engine/` inside the `claude-cockpit`
> repo. It does **not** touch the cockpit SPA/server — it is its own npm package
> and runs fully parallel.

---

## 1. Why this shape

Three locked decisions drive the whole design:

1. **Substrate = MCP.** MCP is the one protocol Claude Code, Codex, **and**
   OpenCode all speak, so a single MCP server is automatically usable by all
   three (config snippets in §9). The core knows nothing Claude-specific — the
   MCP tools and the CLI are the *only* interfaces.
2. **Store = SQLite in WAL mode** (`node:sqlite`, built into Node ≥ 22.5 — zero
   native deps, zero infra). The DB file *is* the shared state.
3. **Shell fallback = a thin `collab` CLI** hitting the same store, so an agent
   that can't/won't use MCP still participates from a shell. Same operations.

### The key architectural insight: no server to secure

There is **no central daemon and no network port.** Each harness spawns its *own*
`collab serve` process over **stdio** (MCP's local transport). Every one of those
processes opens the *same* SQLite file (`$COLLAB_DB`, default `~/.collab/collab.db`).
WAL mode makes concurrent multi-process access safe (many readers + one
serialized writer). Coordination happens **through the DB file**, not through a
shared process.

```
Claude Code ──spawns──► collab serve (stdio) ─┐
Codex       ──spawns──► collab serve (stdio) ─┼─► ~/.collab/collab.db  (SQLite WAL)
OpenCode    ──spawns──► collab serve (stdio) ─┘        ▲
shell/CLI   ────────────► collab <cmd> ─────────────────┘
```

Consequences:

- **Security = filesystem permissions.** Single-user host; the DB dir is created
  `0700`. No listener ⇒ nothing to bind, no token to manage, no secret in code.
- **Harness-agnostic by construction.** Nothing in `core/` imports a harness SDK
  or assumes tmux/panes/Claude internals. `harness` is just a string column.
- **Crash-tolerant.** No long-lived shared state in memory; a dead harness leaves
  no lock — leases and agents age out by TTL (lazy, evaluated at query time).

---

## 2. Package layout

```
collab-engine/
  package.json          # @idl3/collab-engine, type:module, bin { collab }
  tsconfig.json         # nodenext, strict, outDir dist/
  src/
    store/
      db.ts             # open node:sqlite, apply WAL pragmas, run migrations
      schema.ts         # DDL (single source of truth) + PRAGMA user_version
      ids.ts            # random slug ids + validation (no path traversal)
      clock.ts          # injectable now() for deterministic tests
    core/               # pure logic — the ONE source of truth for every op
      agents.ts         # register, heartbeat, directory, deregister
      messages.ts       # send, poll (+ ack via cursor)
      tasks.ts          # create, list, claim, update, complete
      boundaries.ts     # declare, check, release  (TTL leases)
      handoffs.ts       # reassign task/boundary + notify
      streams.ts        # create, list
      types.ts          # shared TS types
    mcp/
      server.ts         # McpServer + StdioServerTransport; registers all tools
      tools.ts          # tool defs (zod schema) → core calls
    cli/
      index.ts          # `collab <cmd>` → same core calls; JSON out
  test/
    claim.test.ts       # atomic claim: no double-claim under real concurrency
    boundary.test.ts    # lease conflict + TTL expiry + release + self-exclusion
    message.test.ts     # direct + broadcast delivery, cursor ack, at-least-once
    parity.test.ts      # CLI ↔ MCP-core parity on the core ops
  README.md             # points at this doc
```

**Adapters are thin; `core/` is the truth.** Both the MCP tool handler and the
CLI command call the *identical* `core/` function. Parity is therefore structural,
not maintained by hand — and `parity.test.ts` guards it.

---

## 3. SQLite schema

Applied once at open (idempotent `CREATE TABLE IF NOT EXISTS`). `schema.ts` holds
the DDL string; `db.ts` runs it and sets pragmas.

### Pragmas (concurrency story)

```sql
PRAGMA journal_mode = WAL;      -- many readers + 1 writer, no reader/writer block
PRAGMA busy_timeout = 5000;     -- a blocked writer waits up to 5s instead of throwing
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;    -- WAL-safe + fast (fsync at checkpoint, not every commit)
```

WAL is the linchpin: multiple `collab serve` processes (one per harness) plus CLI
invocations all open the same file. Reads never block; writes serialize behind a
short busy-timeout. Every mutating op is a single statement or a `db`-level
transaction, so it is atomic at the SQLite layer.

### Tables

```sql
CREATE TABLE IF NOT EXISTS streams (
  id          TEXT PRIMARY KEY,           -- slug id
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | closed
  created_by  TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,          -- slug id (server- or client-supplied)
  harness       TEXT NOT NULL,             -- claude | codex | opencode | <other>
  role          TEXT,                      -- human-readable role
  worktree      TEXT,
  branch        TEXT,
  cwd           TEXT,
  capabilities  TEXT,                      -- JSON array of strings
  stream_id     TEXT REFERENCES streams(id),
  status        TEXT NOT NULL DEFAULT 'active',  -- active | gone
  inbox_cursor  INTEGER NOT NULL DEFAULT 0,      -- last acked message id
  registered_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_stream    ON agents(stream_id);
CREATE INDEX IF NOT EXISTS idx_agents_heartbeat ON agents(last_heartbeat);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic → cursor ordering
  stream_id  TEXT REFERENCES streams(id),
  from_agent TEXT,                               -- agent id, or NULL (system)
  to_agent   TEXT,                               -- agent id, or NULL = broadcast
  kind       TEXT NOT NULL DEFAULT 'msg',        -- msg | handoff | system
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
  status        TEXT NOT NULL DEFAULT 'open',   -- open|claimed|in_progress|blocked|done|cancelled
  owner_agent_id TEXT REFERENCES agents(id),
  priority      INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 0,     -- optimistic-concurrency token
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
  patterns      TEXT NOT NULL,                  -- JSON array of path/glob patterns
  note          TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,               -- epoch ms; lease dead once now > this
  released_at   INTEGER                         -- NULL = active
);
CREATE INDEX IF NOT EXISTS idx_boundaries_active ON boundaries(released_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_boundaries_owner  ON boundaries(owner_agent_id);
```

`PRAGMA user_version = 1;` tags the schema for future migrations.

---

## 4. Concurrency: the two correctness properties

### 4.1 Atomic task claim (no double-claim)

The claim is a **single conditional UPDATE** — no read-then-write window:

```sql
UPDATE tasks
   SET status='claimed', owner_agent_id=@agent, claimed_at=@now, version=version+1
 WHERE id=@task AND status='open';
```

Then inspect `changes` (rows affected):

- `changes === 1` → **claim won**. Return the task.
- `changes === 0` → task was not `open` (already claimed / done). Return `{ok:false, reason:'conflict'}`.

Because writes serialize under WAL and the predicate `status='open'` is evaluated
inside the write lock, two agents racing on the same task can never both see
`changes === 1`. `claim.test.ts` proves this with N *real* concurrent connections.

### 4.2 Optimistic concurrency on update

`task_update` takes an optional `expected_version`. When present:

```sql
UPDATE tasks SET status=@status, body=@body, version=version+1, updated_at=@now
 WHERE id=@task AND version=@expected;
```

`changes===0` ⇒ someone else moved the task first ⇒ `{ok:false, reason:'stale'}`;
the caller re-reads and retries. `complete` and `handoff` additionally guard on
`owner_agent_id=@agent` so only the owner can finish or hand off.

### 4.3 Lease expiry is lazy

A boundary is **active** iff `released_at IS NULL AND expires_at > now`. Expiry is
enforced in the `WHERE` clause of every check/list — no background reaper needed.
`heartbeat` optionally renews the caller's still-active leases (extends
`expires_at`), so a live agent keeps its claims and a dead one's simply lapse.

---

## 5. MCP tool surface

17 tools. Each maps 1:1 to a `core/` function and to a CLI subcommand. `agent_id`
is passed explicitly on every call (MCP calls are stateless; the agent LLM
remembers the id returned by `register`). All tools return JSON.

### Agent lifecycle

| Tool | Params | Semantics |
|---|---|---|
| `collab_register` | `harness`, `role?`, `worktree?`, `branch?`, `cwd?`, `capabilities?[]`, `stream?`, `agent_id?` | Create/refresh an agent row. Returns `{agentId}`. `agent_id` optional (else generated). `inbox_cursor` starts at 0. |
| `collab_heartbeat` | `agent_id`, `renew_leases?` | Set `last_heartbeat=now`. If `renew_leases`, extend the agent's active leases. Returns `{ok, now, staleAfterMs}`. |
| `collab_directory` | `stream?`, `include_stale?` | List agents with computed `live`/`stale` (stale = `now-last_heartbeat > STALE_MS`, default 90s). Excludes `gone` unless `include_stale`. |
| `collab_deregister` | `agent_id` | Mark `gone`, release the agent's leases. Clean exit. |

### Messaging

| Tool | Params | Semantics |
|---|---|---|
| `collab_send` | `agent_id`(from), `body`, `to?`, `stream?`, `kind?` | `to` omitted/null ⇒ broadcast. Durable insert. Returns `{messageId}`. |
| `collab_poll` | `agent_id`, `ack_through?`, `limit?` | If `ack_through` given, advance `inbox_cursor` to it *first*. Then return messages where `id > inbox_cursor` AND (`to_agent=me` OR `to_agent IS NULL`), ordered by `id`. Returns `{messages[], cursor}`. **At-least-once:** messages redeliver until acked. |

Ack is folded into `poll` (`ack_through`) to keep the tool count small; a typical
loop is `poll()` → process → next `poll({ack_through: lastId})`.

### Task board

| Tool | Params | Semantics |
|---|---|---|
| `collab_task_create` | `agent_id`, `title`, `body?`, `stream?`, `priority?` | Insert `open` task. Returns `{taskId}`. |
| `collab_task_list` | `stream?`, `status?`, `owner?`, `mine?`(bool + `agent_id`) | Filtered list, ordered `priority DESC, created_at ASC`. |
| `collab_task_claim` | `agent_id`, `task_id` | Atomic conditional claim (§4.1). Returns `{ok, task}` or `{ok:false, reason:'conflict'}`. |
| `collab_task_update` | `agent_id`, `task_id`, `status?`, `body?`, `expected_version?` | Owner-guarded status/body change; optimistic on `expected_version` (§4.2). |
| `collab_task_complete` | `agent_id`, `task_id` | Owner-only. Sets `status='done'`, `completed_at`. |

### Boundaries / worktree leases

| Tool | Params | Semantics |
|---|---|---|
| `collab_boundary_declare` | `agent_id`, `paths[]`, `ttl_sec?`(def 1800), `stream?`, `note?` | Advertise ownership of path/glob patterns. Returns `{boundaryId, expiresAt}`. |
| `collab_boundary_check` | `paths[]` (concrete files you're about to touch), `agent_id?`, `stream?` | For each path, list conflicting **active** leases held by **other** agents. Returns `{conflicts:[{path, boundaryId, owner, expiresAt, patterns}]}`. Empty ⇒ safe to edit. |
| `collab_boundary_release` | `agent_id`, `boundary_id` | Owner-only. Sets `released_at`. |

### Handoff

| Tool | Params | Semantics |
|---|---|---|
| `collab_handoff` | `agent_id`(from), `to_agent`, `task_id?`, `boundary_id?`, `note?` | In one transaction: reassign task (`owner=to`, guarded on current owner) and/or boundary, then insert a `kind='handoff'` message to `to_agent`. At least one of `task_id`/`boundary_id` required. |

### Streams (application-level boundaries)

| Tool | Params | Semantics |
|---|---|---|
| `collab_stream_create` | `agent_id`, `name`, `description?` | Create a workstream grouping. Returns `{streamId}`. |
| `collab_stream_list` | `status?` | List streams. |

**Boundary matching model.** `declare` takes *patterns* (files, dir prefixes, or
globs); `check` takes *concrete paths you're about to edit*. A lease matches a
queried path P if any of its patterns: equals P, is a directory prefix of P (e.g.
`src/api/` or `src/api/**`), or `minimatch(P, pattern)` is true. Directional
(concrete-path-vs-pattern) matching keeps it bounded and covers the real use case
("before I edit `src/api/users.ts`, who owns it?"). Glob-vs-glob intersection is
deliberately out of scope (see §11).

---

## 6. CLI surface (parity)

`collab <cmd>` calls the same `core/` functions and prints JSON (agent-parseable;
`--pretty` for a human table). Every MCP tool has a CLI twin:

```
collab serve                                   # start the stdio MCP server
collab register --harness codex --role "api dev" --branch feat/x [--agent-id a1]
collab heartbeat --agent a1 [--renew-leases]
collab dir [--stream s1] [--include-stale]
collab deregister --agent a1

collab send --agent a1 --to a2 --body "..."     # omit --to ⇒ broadcast
collab poll --agent a1 [--ack-through 42]

collab task create --agent a1 --title "..." [--stream s1] [--priority 5]
collab task list [--stream s1] [--status open] [--mine --agent a1]
collab task claim  --agent a1 --task t1
collab task update --agent a1 --task t1 --status in_progress [--expected-version 2]
collab task complete --agent a1 --task t1

collab boundary declare --agent a1 --paths "src/api/**" "docs/api.md" [--ttl 1800]
collab boundary check --paths src/api/users.ts [--agent a1]
collab boundary release --agent a1 --boundary b1

collab handoff --agent a1 --to a2 --task t1 [--note "yours now"]

collab stream create --agent a1 --name "auth-epic"
collab stream list
```

`$COLLAB_DB` (env) selects the store for both `serve` and every CLI call, so MCP
agents and CLI agents share one DB.

---

## 7. Agent lifecycle

```
register ──► (loop) ── heartbeat ─┐
   │                              │  poll inbox, claim/create tasks,
   │                              │  declare boundaries, check before edit,
   │                              │  send/handoff
   │                              │
   └──► deregister (releases leases, marks gone)  ── or ── silent exit ⇒ ages out
```

1. **register** → get `agentId`; record harness/role/worktree/branch.
2. **work loop:** `heartbeat` (renew leases) → `poll` inbox → `task_list`/`claim`
   → `boundary_check` before editing a file → `boundary_declare` for the region
   you own → do work → `task_update`/`complete` → `send`/`handoff` as needed.
3. **exit:** `deregister` for a clean release; or just stop — leases lapse by TTL
   and the agent goes `stale` after `STALE_MS`, so a crashed agent never wedges
   anyone.

---

## 8. Sequence: two agents, disjoint tasks, one handoff

```mermaid
sequenceDiagram
    participant A as Agent A (Claude Code, MCP)
    participant DB as collab.db (SQLite WAL)
    participant B as Agent B (Codex, CLI)

    A->>DB: collab_register(harness=claude, role="api")
    B->>DB: collab register --harness codex --role "web"
    A->>DB: collab_stream_create("checkout-epic") -> s1
    A->>DB: task_create(t1 "backend API", s1)
    A->>DB: task_create(t2 "web form", s1)

    A->>DB: task_claim(t1)   Note right of DB: UPDATE ... WHERE status='open' -> changes=1 ✅
    B->>DB: task_claim(t2)   Note right of DB: disjoint task -> changes=1 ✅
    B->>DB: task_claim(t1)   Note right of DB: status!='open' -> changes=0 ❌ conflict

    A->>DB: boundary_declare(["src/api/**"], ttl=1800)
    B->>DB: boundary_declare(["web/checkout/**"])
    B->>DB: boundary_check(["src/api/users.ts"])
    DB-->>B: conflict: owned by A (expires T+30m)  Note right of B: B backs off ✋

    A->>DB: task_update(t1, in_progress) ; ... work ...
    A->>DB: handoff(to=B, task=t1, note="tests left")
    DB-->>DB: t1.owner=B ; insert handoff msg->B
    B->>DB: poll() -> [handoff: t1 from A "tests left"]
    B->>DB: task_complete(t1)
    A->>DB: deregister()  Note right of DB: A's leases released
```

---

## 9. Connecting each harness

All three spawn the same stdio server. Assumes the package is built
(`npm run build`) and either `collab` is on `PATH` (`npm link`) or you point at
`dist/mcp/server.js` directly. Pick one shared `COLLAB_DB` so harnesses coordinate.

**Claude Code** — `.mcp.json` (project) or `claude mcp add`:

```json
{
  "mcpServers": {
    "collab": {
      "command": "node",
      "args": ["/abs/path/collab-engine/dist/mcp/server.js"],
      "env": { "COLLAB_DB": "/Users/you/.collab/collab.db" }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.collab]
command = "node"
args = ["/abs/path/collab-engine/dist/mcp/server.js"]

[mcp_servers.collab.env]
COLLAB_DB = "/Users/you/.collab/collab.db"
```

**OpenCode** — `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "collab": {
      "type": "local",
      "command": ["node", "/abs/path/collab-engine/dist/mcp/server.js"],
      "environment": { "COLLAB_DB": "/Users/you/.collab/collab.db" },
      "enabled": true
    }
  }
}
```

(If `collab` is linked onto `PATH`, replace `command`/`args` with the `collab serve`
form — e.g. Claude `"command":"collab","args":["serve"]`.)

---

## 10. Try it (dogfood in 2 minutes)

```bash
cd collab-engine
npm install
npm run build                      # tsc → dist/  (gate: 0 errors)
npm test                           # gate: all green
export COLLAB_DB=/tmp/collab-demo.db

# Agent 1 via CLI (acts as a shell agent):
A1=$(node dist/cli/index.js register --harness codex --role "api dev" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).agentId')
S1=$(node dist/cli/index.js stream create --agent $A1 --name "demo-epic" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).streamId')
node dist/cli/index.js task create --agent $A1 --title "backend API" --stream $S1
node dist/cli/index.js task create --agent $A1 --title "web form"    --stream $S1
node dist/cli/index.js task list --stream $S1

# Agent 2 (register, claim the other task, declare a boundary):
A2=$(node dist/cli/index.js register --harness opencode --role "web dev" --json | node -pe 'JSON.parse(require("fs").readFileSync(0)).agentId')
node dist/cli/index.js task claim --agent $A2 --task <t2-id>
node dist/cli/index.js boundary declare --agent $A2 --paths "web/**"
node dist/cli/index.js boundary check  --agent $A1 --paths web/form.tsx   # ⇒ conflict owned by A2

# Handoff + inbox:
node dist/cli/index.js handoff --agent $A1 --to $A2 --task <t1-id> --note "tests left"
node dist/cli/index.js poll --agent $A2                                   # ⇒ handoff message
```

To drive it from a **real MCP harness**, add the config in §9, then in-session:
"register me as a collab agent (harness=claude, role=…)", "list the collab task
board", "claim task X", etc. One harness on MCP + one on the CLI, same `COLLAB_DB`,
proves cross-harness coordination.

---

## 11. What the MVP does vs. defers

**Does:** all six capabilities (registry+heartbeat, messaging, task board with
atomic claim, TTL boundary leases, handoff, streams); stdio MCP server; full CLI
parity; SQLite WAL with proven no-double-claim; lazy lease expiry; 3-harness
config; unit tests for claim/boundary/message/parity; `tsc` clean.

**Defers (YAGNI, and why safe to defer):**

- **HTTP / multi-host transport** — MVP is single-host stdio+file. See §12.
- **Per-recipient read receipts / exactly-once** — cursor gives durable
  at-least-once, which is what coordination needs.
- **Glob-vs-glob intersection** — `check` takes concrete paths (the real
  question is "who owns this file I'm about to edit"). Advisory anyway.
- **Background reaper / hard GC** — expiry & staleness are lazy at query time;
  nothing wedges. Optional compaction later.
- **Auth / tokens / encryption at rest** — no network listener; single-user host;
  filesystem perms are the boundary. Introduced only if/when a listener is added.
- **Task deps/subtasks, capability negotiation, cockpit UI** — not needed to make
  two agents coordinate today.

---

## 12. Extensibility

- **4th+ harness.** `harness` is a free-text column; nothing in `core/` branches
  on it. Onboarding a new harness = add one MCP config snippet (§9). No code change.
- **Multi-host.** Two clean paths, neither requiring a schema rewrite:
  1. Promote `collab serve` to an HTTP/SSE MCP server on one host, bound to
     `127.0.0.1`/Tailscale **with a bearer token**; other hosts connect via MCP
     *remote* transport. The store and `core/` are transport-agnostic.
  2. Point `$COLLAB_DB` at a shared filesystem (works, but SQLite-over-network-FS
     locking is fragile — prefer path 1).
  The **one** schema concession to revisit for multi-host: `messages.id` is a
  host-local `AUTOINCREMENT` used as the inbox cursor. Across hosts, replace it
  with a ULID + a hybrid-logical-clock (or per-host message streams) so ordering
  stays monotonic. Every other id is already a random global slug, so nothing
  else collides.

---

## 13. Relationship to the prior `feat/claude-collab-mcp` attempt

The earlier branch was a JS, file-based (`registry.json` + per-room JSONL),
claude-control/tmux-coupled "rooms" prototype covering **messaging only**. It is
superseded here because it conflicts with all three locked decisions
(SQLite-not-files, TS-not-JS, standalone-not-cockpit-coupled) and covers ~1 of 6
capabilities. Primitives worth carrying forward were kept: **safe slug-id
validation** (no path traversal), an **injectable clock** for deterministic tests,
and **durable append-only messaging** — now expressed in SQLite instead of JSONL.
