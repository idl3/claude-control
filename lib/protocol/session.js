/**
 * lib/protocol/session.js — the session-list entry schema.
 *
 * Mirrors the REAL shape the backend emits today: `GET /api/sessions` and
 * the `{type:'sessions'}` WS frame (server.js -> registry.getSessions())
 * both return an array of this shape. Two producers feed it, and the field
 * list below was cross-checked against BOTH, not invented:
 *
 *   - LOCAL (tmux-backed) rows: the `sessions.map((win) => ({...}))` object
 *     literal in SessionRegistry.refresh() (lib/sessions.js:1236-1320).
 *   - REMOTE (olam) rows: the row-builder in lib/olam-sessions.js
 *     (`_fetchOrg`, ~line 80) wrapping RemoteSessionSource's
 *     `entry.client.listSessions()` (lib/olam-client.js:227-296).
 *
 * The SPA's client-side `Session` type (web/src/lib/types.ts) documents both
 * producers' fields; every non-required field below has a corresponding
 * `?:`-optional entry there.
 *
 * Adaptation note (this schema vs. the Phase A original it was seeded from):
 * the Phase A version treated `name`, `cwd`, `transcriptPath`, and
 * `pendingQuestion` as universal (required-nullable) fields on every row.
 * Reading lib/olam-client.js's `listSessions()` shows that's wrong for
 * REMOTE rows — that row-builder never assigns those keys at all (they're
 * genuinely absent, not just null). Only `id`, `kind`, `transport`, and
 * `pending` are guaranteed present on every row regardless of producer;
 * everything else — including fields a local row always sets — is
 * `.optional()` here so the schema stays true to what a remote row can
 * legally omit.
 *
 * `host` (Decision 8, carried over from Phase A): session ids become
 * host-scoped once multi-host wiring lands. The field is declared now but
 * `.optional()` — NO producer populates it today (verified: validating this
 * schema against all 114 live sessions on a real instance failed 114/114
 * when `host` was required, since it is never set). Promoting it to required
 * is a deliberate later shape-change (when multi-host wiring both populates
 * AND requires it) — the fingerprint gate forces the PROTOCOL_VERSION bump
 * at that point. Declaring it optional now still gives clients the field
 * name to key on without breaking validation of today's sessions —
 * wiring a real value through is later-phase work; the schema seed happens
 * now.
 */
import { z } from 'zod';

// Harness-extension contract (harness-adapter epic — grok-build / opencode):
// New harnesses are added by EXTENDING these two enums — a new `kind` value
// for the harness identity (alongside 'claude' | 'codex' | 'terminal' |
// 'remote'), and, for RPC-driven harnesses that speak ACP / JSON-RPC over
// stdio (like `grok agent stdio` and `opencode acp`), most likely a new
// `transport` value such as 'acp' alongside the existing 'tmux' | 'rpc' |
// 'print' | 'olam'. Doing so changes the schema fingerprint, so the
// fingerprint gate FORCES a PROTOCOL_VERSION bump — that version-gated enum
// extension IS the intended mechanism, so the seam is deliberately NOT
// pre-populated with harnesses that have no producer yet. RPC-driven
// harnesses may stream their session over the transport itself rather than
// a tailable file, so they may legally carry a null `transcriptPath` (no
// JSONL to tail) — the field is already nullable for exactly this reason.
export const SessionKindSchema = z.enum(['claude', 'codex', 'terminal', 'remote']);

export const SessionTransportSchema = z.enum(['tmux', 'rpc', 'print', 'olam']);

export const SessionEntrySchema = z.object({
  // --- present on every session, regardless of producer ---------------------
  id: z.string(),
  host: z.string().optional(),
  kind: SessionKindSchema,
  transport: SessionTransportSchema.nullable(),
  pending: z.boolean(),

  // --- present on most rows, but a remote row may legally omit these --------
  sessionId: z.string().nullable().optional(),
  name: z.string().optional(),
  title: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  transcriptPath: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  pendingQuestion: z.string().nullable().optional(),
  lastActivity: z.string().nullable().optional(),
  lastActivityMs: z.number().nullable().optional(),
  ctxPct: z.number().nullable().optional(),
  endpoint: z.string().nullable().optional(),

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
  cmd: z.string().optional(),
  isClaude: z.boolean().optional(),
  ccShell: z.boolean().optional(),
  effort: z.string().nullable().optional(),
  thinking: z.boolean().optional(),
  compacting: z.boolean().optional(),
  errored: z.boolean().optional(),
  permIssue: z.boolean().optional(),
  subAgentActive: z.boolean().optional(),
  runningSubagentCount: z.number().int().optional(),
  usagePct: z.number().nullable().optional(),
  usageWindowMin: z.number().nullable().optional(),
});

export const SessionListSchema = z.array(SessionEntrySchema);

/** @typedef {import('zod').z.infer<typeof SessionEntrySchema>} SessionEntry */
/** @typedef {import('zod').z.infer<typeof SessionListSchema>} SessionList */
