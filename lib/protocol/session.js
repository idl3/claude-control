/**
 * lib/protocol/session.js — the session-list entry schema.
 *
 * Mirrors the REAL shape the backend emits today: `GET /api/sessions` and
 * the `{type:'sessions'}` WS frame (server.js -> registry.getSessions())
 * both return an array of this shape, built by SessionRegistry.refresh()'s
 * `sessions.map(...)` block (lib/sessions.js) and consumed by the SPA as
 * `Session` (web/src/lib/types.ts). Field list below was cross-checked
 * against that literal object build, not invented.
 *
 * Phase A scope: models the LOCAL (tmux-backed) session row —
 * kind: 'claude' | 'codex' | 'terminal' — precisely; those fields are
 * required/typed to match what lib/sessions.js always sets. Remote (olam)
 * rows are a documented "additive superset" (lib/olam-sessions.js
 * RemoteSessionSource doc comment: org, pool, phase, linearRef, summary,
 * orgHealth, stale, archived, ...) with a materially different field set —
 * modeling that full surface is explicit Phase C scope. `kind` still accepts
 * 'remote' so the discriminant matches real wire values today, and the
 * local-only fields below are `.optional()` so a remote row (which omits
 * them) doesn't fail this schema — but remote-only enrichment fields are not
 * yet represented here.
 *
 * `host` (Decision 8): session ids become host-scoped once multi-host wiring
 * lands. The field is added now, as required, so that later wiring is an
 * additive population change rather than a schema shape change requiring a
 * second PROTOCOL_VERSION bump. lib/sessions.js does NOT populate it yet
 * (every local session is implicitly "local" today) — wiring a real value
 * through is later-phase work; the schema seed happens now.
 */
import { z } from 'zod';

// Harness-extension contract (harness-adapter epic — see docs/plans task #9 + recon):
// New harnesses (grok-build, opencode, …) are added by EXTENDING these two enums
// — a new `kind` value for the harness identity, and (for RPC-driven harnesses
// that speak ACP / JSON-RPC over stdio, like `grok agent stdio` and `opencode acp`)
// most likely a new `transport` value such as 'acp' alongside the existing 'rpc'.
// Doing so changes the schema fingerprint, so the fingerprint gate FORCES a
// PROTOCOL_VERSION bump — that version-gated enum extension IS the intended
// mechanism, so the seam is deliberately NOT pre-populated with harnesses that
// have no producer yet. RPC-driven harnesses may stream their session over the
// transport itself, so they may carry a null transcriptPath (no JSONL to tail).
export const SessionKindSchema = z.enum(['claude', 'codex', 'terminal', 'remote']);

export const SessionTransportSchema = z.enum(['tmux', 'rpc', 'print', 'olam']);

export const SessionEntrySchema = z.object({
  // --- present on every session, regardless of kind ------------------------
  id: z.string(),
  host: z.string(),
  sessionId: z.string().nullable(),
  name: z.string(),
  title: z.string().nullable(),
  kind: SessionKindSchema,
  transport: SessionTransportSchema.nullable(),
  cwd: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  model: z.string().nullable(),
  pending: z.boolean(),
  pendingQuestion: z.string().nullable(),

  // --- local (tmux-backed) rows only — absent on remote (olam) rows --------
  target: z.string().optional(),
  paneId: z.string().nullable().optional(),
  tmuxName: z.string().optional(),
  sessionName: z.string().optional(),
  windowIndex: z.number().int().optional(),
  paneIndex: z.number().int().optional(),
  windowId: z.string().optional(),
  active: z.boolean().optional(),
  pinned: z.boolean().optional(),
  lastActivity: z.string().nullable().optional(),
  lastActivityMs: z.number().nullable().optional(),
  cmd: z.string().optional(),
  isClaude: z.boolean().optional(),
  endpoint: z.string().nullable().optional(),
  ccShell: z.boolean().optional(),
  ctxPct: z.number().nullable().optional(),
  thinking: z.boolean().optional(),
  compacting: z.boolean().optional(),
  errored: z.boolean().optional(),
  permIssue: z.boolean().optional(),
  subAgentActive: z.boolean().optional(),
  usagePct: z.number().nullable().optional(),
  usageWindowMin: z.number().nullable().optional(),
});

export const SessionListSchema = z.array(SessionEntrySchema);

/** @typedef {import('zod').z.infer<typeof SessionEntrySchema>} SessionEntry */
/** @typedef {import('zod').z.infer<typeof SessionListSchema>} SessionList */
