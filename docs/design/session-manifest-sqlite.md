# SQLite Session Manifest Design

## Goal

Add a durable, queryable manifest for sessions, tmux panes/windows, transcript files, and bindings. It should make session lookup and recovery easier without turning SQLite into the transcript message store.

## Non-Goals

- Do not store raw transcript messages in SQLite.
- Do not let stale database rows override a successful live tmux observation.
- Do not require SQLite for first boot; the manifest must be disposable and rebuildable from tmux plus transcript state.

## Storage Choice

Keep a storage adapter boundary so the implementation can use either Node's built-in SQLite support on newer Node versions or a small native dependency if the package keeps `node >=20`. The first implementation should hide that behind `SessionManifestStore` and keep the rest of `SessionRegistry` independent of the driver.

Recommended pragmas for a single-process local app:

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout=1000`

Store under `~/.claude-control/state/session-manifest.sqlite` with directory mode `0700` and database mode `0600`.

## Core Tables

- `observations`: one row per live scan, with source (`tmux`, `transcript`, `codex-rpc`, `claude-print`, `olam`), start/end timestamps, success flag, and error text. Only successful observations may close live records.
- `sessions`: Cockpit session identity and public row metadata: id, kind, transport, state, cwd, project root, first/last seen, ended at, external session id, title fields, and compact metadata JSON.
- `tmux_sessions`: stable tmux session identity, display name, group id, first/last seen.
- `tmux_windows`: stable tmux window id, last name, first/last seen.
- `tmux_session_windows`: current/historical membership of grouped tmux sessions to windows with window index and validity range.
- `tmux_panes`: stable pane id, window id, pane index, pid, tty, cwd, command, first/last seen, ended at.
- `transcripts`: transcript path, format (`claude-jsonl`, `codex-rollout`), external session id, cwd, size, mtime, first/last seen, parent/descendant lineage.
- `session_bindings`: versioned relation from Cockpit session to pane and transcript, with source (`hook`, `runtime-hint`, `lsof`, `matcher`, `manual-pin`), confidence, valid-from, valid-to.
- `session_events`: bounded lifecycle journal only: bind, rebind, missing, restored, stale, ended, remote-health-change. No raw transcript content.
- `schema_migrations`: monotonically ordered schema version records.

## Reconciliation Rules

1. Start a transaction for each observation.
2. Upsert every live tmux session/window/pane from a successful tmux scan.
3. Mark records missing only after a successful observation that did not include them. Never prune on a failed scan.
4. Bind using the current authority order: manual pin, runtime hint, pane registry hook, exact Codex rollout, matcher fallback.
5. Write a new `session_bindings` row when the binding target changes; close the prior row with `valid_to`.
6. Keep stale rows visible through a grace window so UI state and cached transcripts do not disappear during transient tmux failures.
7. Treat grouped tmux sessions as multiple memberships for the same stable window/pane, not duplicated sessions.

## Query Surface

- `listSessions(filters)`: fast sidebar query by active/stale/kind/project.
- `getSession(id)`: one session plus current pane/transcript binding.
- `findByPane(paneId)`: deterministic recovery for hooks and tmux target reuse.
- `findByTranscript(path | sessionId)`: manual pin and fork-follow lookups.
- `listWindows(sessionName | groupId)`: new-session target picker without reparsing all tmux rows.
- `diagnostics()`: counts, last observation, stale rows, DB size, checkpoint age.

## Rollout Plan

1. Add schema, adapter, migrations, and unit tests.
2. Shadow-write from `SessionRegistry` while keeping in-memory state authoritative.
3. Add diagnostics that compare live registry rows with SQLite rows and report mismatches.
4. Move read-only API surfaces that do not drive control actions to SQLite-backed queries.
5. Use SQLite as a startup hint source, then immediately reconcile against live tmux/transcripts.
6. Only after shadow metrics are clean, simplify the in-memory maps around manifest-backed identities.

## Test Plan

- Successful scan closes missing panes; failed scan preserves them.
- Tmux target reuse clears old target-keyed state but preserves pane-id history.
- Grouped tmux windows do not duplicate panes.
- Manual pin and runtime hint authority order is stable.
- Forked transcript lineage writes a new binding version.
- WAL database survives process crash mid-observation.
- Corrupt/missing database is renamed aside and rebuilt.
- Query p95 stays under 20 ms for hundreds of panes/transcripts.
