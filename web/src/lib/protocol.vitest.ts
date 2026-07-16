// Smoke test proving the `@protocol` alias (vite.config.ts + tsconfig.json)
// actually resolves the repo-root lib/protocol/ schemas from the web app —
// not just that the alias config exists unused.
import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_VERSION,
  SessionEntrySchema,
  PtyClientMessageSchema,
  PtyServerMessageSchema,
  type SessionEntry,
  type PtyClientMessage,
} from './protocol';

describe('@protocol alias resolves the shared wire-protocol schemas', () => {
  it('exposes a positive PROTOCOL_VERSION', () => {
    expect(typeof PROTOCOL_VERSION).toBe('number');
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it('parses a real local session-list entry shape', () => {
    const raw = {
      id: 'main:0',
      host: 'local',
      sessionId: 'abc-123',
      name: 'main:0',
      title: null,
      kind: 'claude',
      transport: 'tmux',
      cwd: '/Users/ernie/Projects/claude-cockpit',
      transcriptPath: '/Users/ernie/.claude/projects/x/y.jsonl',
      model: 'claude-sonnet-5',
      pending: false,
      pendingQuestion: null,
      target: 'main:0',
      paneId: '%3',
    };
    const entry: SessionEntry = SessionEntrySchema.parse(raw);
    expect(entry.id).toBe('main:0');
    expect(entry.kind).toBe('claude');
  });

  it('accepts a well-formed attach control frame', () => {
    const msg: PtyClientMessage = PtyClientMessageSchema.parse({
      type: 'attach',
      sessionId: 'main:0',
    });
    expect(msg.type).toBe('attach');
  });

  it('rejects a control frame missing a required field', () => {
    expect(() => PtyClientMessageSchema.parse({ type: 'attach' })).toThrow();
  });

  it('rejects an error frame with an unknown code', () => {
    expect(() =>
      PtyServerMessageSchema.parse({ type: 'error', code: 'not-a-real-code', message: 'x' }),
    ).toThrow();
  });
});
