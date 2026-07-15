# @idl3/collab-engine

Harness-agnostic cross-agent collaboration engine — MCP server + CLI over a
shared SQLite (WAL) store. Lets AI coding agents running under Claude Code,
Codex, or OpenCode register, message each other, share a task board, declare
work boundaries, and hand off work — no daemon, no network port.

**Full design doc (source of truth for this package):**
[`docs/design/collab-engine.md`](../docs/design/collab-engine.md)

## Quick start

```bash
cd collab-engine
npm install
npm run build       # tsc -> dist/  (gate: 0 errors)
npm test             # gate: all tests green
```

## Usage

```bash
export COLLAB_DB=~/.collab/collab.db   # default if unset

# Register an agent, create a task, claim it.
node dist/cli/index.js register --harness codex --role "api dev"
node dist/cli/index.js task create --agent <agent-id> --title "backend API"
node dist/cli/index.js task claim --agent <agent-id> --task <task-id>

# Declare a boundary lease and check for conflicts.
node dist/cli/index.js boundary declare --agent <agent-id> --paths "web/**"
node dist/cli/index.js boundary check --paths web/form.tsx

# Message another agent (or broadcast) and poll an inbox.
node dist/cli/index.js send --agent <agent-id> --to <other-id> --body "hi"
node dist/cli/index.js poll --agent <other-id>
```

Output is compact JSON by default; pass `--pretty` for indented output.

To run as an MCP stdio server for a harness (Claude Code / Codex / OpenCode —
config snippets in design doc §9):

```bash
node dist/mcp/server.js
# or, once built: collab serve
```

## Layout

- `src/store/` — SQLite (`node:sqlite`) connection, schema DDL, id generation, clock.
- `src/core/` — single source of truth for every operation (agents, messages,
  tasks, boundaries, handoffs, streams). Takes a `Db` + injectable clock; no
  MCP/CLI/harness imports.
- `src/mcp/` — thin MCP tool adapters (`registerAllTools`) + stdio server entrypoint.
- `src/cli/` — thin CLI adapter (`collab <command>`) over the same `core/` functions.
- `test/` — `claim.test.ts` (real multi-connection atomic-claim race),
  `boundary.test.ts` (TTL/lease conflict + directory/glob matching),
  `message.test.ts` (direct/broadcast delivery, ack cursor, at-least-once
  redelivery), `parity.test.ts` (CLI-vs-core cross-path parity via a real
  spawned CLI subprocess).

See the design doc for the full schema, the 17 MCP tools, the CLI command
reference, and the concurrency correctness properties (atomic claim,
optimistic version guard, lazy TTL expiry).
