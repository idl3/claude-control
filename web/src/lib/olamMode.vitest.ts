import { describe, it, expect } from 'vitest';
import {
  remoteComposerMode,
  isExecuteShaped,
  shouldSteerDoor,
  blocksResumeResend,
  remoteModeLabel,
  remoteModeTitle,
  REMOTE_REFUSAL_MESSAGES,
  type RemoteComposerMode,
  type SessionLiveness,
} from './olamMode';
import type { Session } from './types';

const remote = (over: Partial<Session>): Session => ({ id: 'olam:atlas:s1', kind: 'remote', ...over } as Session);

describe('remoteComposerMode (client mirror of server composerMode)', () => {
  it('non-remote sessions default to steer', () => {
    expect(remoteComposerMode({ id: 't', kind: 'claude' } as Session)).toBe('steer');
    expect(remoteComposerMode(null)).toBe('steer');
  });
  it('planned / awaiting_approval → approve', () => {
    expect(remoteComposerMode(remote({ planStatus: 'planned' }))).toBe('approve');
    expect(remoteComposerMode(remote({ planStatus: 'awaiting_approval' }))).toBe('approve');
  });
  it('read-only flag wins over everything', () => {
    expect(remoteComposerMode(remote({ readOnly: true, planStatus: 'planned' } as Partial<Session>))).toBe('read-only');
  });
  it('running/approved remote session → steer', () => {
    expect(remoteComposerMode(remote({ planStatus: 'approved', inFlight: true }))).toBe('steer');
    expect(remoteComposerMode(remote({}))).toBe('steer');
  });
});

// --- remoteComposerMode + liveness precedence (Phase A, task A4) --------------

describe('remoteComposerMode: liveness precedence mirrors the server composerMode', () => {
  it('no liveness arg is a no-op — pre-Phase-A callers unaffected', () => {
    expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>))).toBe('steer');
    expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>), undefined)).toBe('steer');
    expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>), null)).toBe('steer');
  });

  it('read-only outranks dormant/unknown liveness', () => {
    const s = remote({ readOnly: true, pool: 'linear' } as Partial<Session>);
    expect(remoteComposerMode(s, { state: 'dormant' })).toBe('read-only');
    expect(remoteComposerMode(s, { state: 'unknown' })).toBe('read-only');
  });

  it('approve (awaiting plan) outranks dormant/unknown liveness', () => {
    const s = remote({ planStatus: 'planned', pool: 'linear' } as Partial<Session>);
    expect(remoteComposerMode(s, { state: 'dormant' })).toBe('approve');
    expect(remoteComposerMode(s, { state: 'unknown' })).toBe('approve');
  });

  it('dormant/unknown liveness demotes an execute-shaped session from steer', () => {
    const s = remote({ pool: 'linear' } as Partial<Session>);
    expect(remoteComposerMode(s, { state: 'dormant' })).toBe('dormant');
    expect(remoteComposerMode(s, { state: 'unknown' })).toBe('unknown');
    expect(remoteComposerMode(s, { state: 'live' })).toBe('steer');
  });

  it('dormant/unknown liveness does NOT demote a non-execute-shaped (chat) session', () => {
    expect(remoteComposerMode(remote({}), { state: 'unknown' })).toBe('steer');
  });

  it('liveness.state dormant is itself sufficient proof of execute-shape (no pool needed)', () => {
    expect(remoteComposerMode(remote({}), { state: 'dormant' })).toBe('dormant');
  });

  it('a containerSessionId on liveness is itself sufficient proof of execute-shape', () => {
    expect(remoteComposerMode(remote({}), { state: 'unknown', containerSessionId: 'c1' })).toBe('unknown');
  });
});

// --- CP3 audit Finding 2: 'n/a' liveness sentinel (never demotes) -------------

describe("remoteComposerMode: 'n/a' liveness (no check applicable/made) never demotes", () => {
  it('n/a is treated like no liveness at all — distinct from unknown', () => {
    expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>), { state: 'n/a' })).toBe('steer');
    expect(remoteComposerMode(remote({}), { state: 'n/a' })).toBe('steer');
  });
  it('read-only / approve still outrank n/a liveness', () => {
    expect(remoteComposerMode(remote({ readOnly: true } as Partial<Session>), { state: 'n/a' })).toBe('read-only');
    expect(remoteComposerMode(remote({ planStatus: 'planned' }), { state: 'n/a' })).toBe('approve');
  });
  it('isExecuteShaped: n/a liveness carries no positive evidence', () => {
    expect(isExecuteShaped(remote({}), { state: 'n/a' })).toBe(false);
    expect(isExecuteShaped(remote({ pool: null } as Partial<Session>), { state: 'n/a' })).toBe(false);
  });
});

describe('isExecuteShaped (client mirror of server isExecuteShaped)', () => {
  it('true on dormant liveness, containerSessionId, or a confirmed pool', () => {
    expect(isExecuteShaped(remote({}), { state: 'dormant' })).toBe(true);
    expect(isExecuteShaped(remote({}), { state: 'unknown', containerSessionId: 'c1' })).toBe(true);
    expect(isExecuteShaped(remote({ pool: 'sandbox' } as Partial<Session>))).toBe(true);
  });
  it('false with no positive signal — "if in doubt, stay steer"', () => {
    expect(isExecuteShaped(remote({}))).toBe(false);
    expect(isExecuteShaped(remote({}), { state: 'unknown' })).toBe(false);
    expect(isExecuteShaped(remote({ pool: null } as Partial<Session>), { state: 'live' })).toBe(false);
  });
});

// --- shouldSteerDoor (Phase B, B3 routing predicate — server mirror) -----------

describe('shouldSteerDoor: client mirror of server shouldSteerDoor — drives hard-steer gating + next-turn-boundary copy', () => {
  it('execute-shaped + live → true', () => {
    expect(shouldSteerDoor(remote({ pool: 'linear' } as Partial<Session>), { state: 'live' })).toBe(true);
    expect(shouldSteerDoor(remote({}), { state: 'live', containerSessionId: 'c1' })).toBe(true);
  });

  it('execute-shaped + dormant/unknown/n-a/no-liveness → false — hard steer stays disabled', () => {
    const s = remote({ pool: 'linear' } as Partial<Session>);
    expect(shouldSteerDoor(s, { state: 'dormant' })).toBe(false);
    expect(shouldSteerDoor(s, { state: 'unknown' })).toBe(false);
    expect(shouldSteerDoor(s, { state: 'n/a' })).toBe(false);
    expect(shouldSteerDoor(s, undefined)).toBe(false);
    expect(shouldSteerDoor(s, null)).toBe(false);
  });

  it('a plan/chat (non execute-shaped) session is false even if liveness somehow reads live', () => {
    expect(shouldSteerDoor(remote({}), { state: 'live' })).toBe(false);
  });

  it('null/undefined session is false', () => {
    expect(shouldSteerDoor(null, { state: 'live' })).toBe(false);
    expect(shouldSteerDoor(undefined, { state: 'live' })).toBe(false);
  });
});

// --- pill exhaustiveness (App.tsx mode-pill must never silently fall back) ----

describe('remoteModeLabel / remoteModeTitle: exhaustive over every RemoteComposerMode', () => {
  const modes: RemoteComposerMode[] = ['steer', 'approve', 'read-only', 'dormant', 'unknown'];

  it('every known mode renders its own distinct label', () => {
    const labels = modes.map(remoteModeLabel);
    expect(new Set(labels).size).toBe(modes.length); // no two modes share a label
    for (const label of labels) expect(label.length).toBeGreaterThan(0);
  });

  it('every known mode renders its own distinct title', () => {
    const titles = modes.map(remoteModeTitle);
    expect(new Set(titles).size).toBe(modes.length);
  });

  it('unknown title carries the same refusal copy as REMOTE_REFUSAL_MESSAGES', () => {
    expect(remoteModeTitle('unknown')).toBe(REMOTE_REFUSAL_MESSAGES.unknown);
  });

  it('dormant title describes the resume-and-send affordance, not a pure refusal', () => {
    expect(remoteModeTitle('dormant')).toMatch(/resum/i);
  });

  it('an unrecognised mode value renders a visible ⚠ fallback, never a silent steer label', () => {
    const bogus = 'bogus-mode' as unknown as RemoteComposerMode;
    expect(remoteModeLabel(bogus)).toBe('⚠ bogus-mode');
    expect(remoteModeLabel(bogus)).not.toBe(remoteModeLabel('steer'));
    expect(remoteModeTitle(bogus)).toContain('bogus-mode');
  });
});

// --- blocksResumeResend (Phase C, C5 re-click guard) ---------------------------

describe('blocksResumeResend: dormant-session resume re-click guard', () => {
  it('blocks a second submit for the SAME session while a resume is in flight', () => {
    expect(blocksResumeResend({ sessionId: 's1' }, 's1')).toBe(true);
  });

  it('does not block a submit for a DIFFERENT session while a resume is in flight elsewhere', () => {
    expect(blocksResumeResend({ sessionId: 's1' }, 's2')).toBe(false);
  });

  it('does not block when no resume is in flight (null/undefined)', () => {
    expect(blocksResumeResend(null, 's1')).toBe(false);
    expect(blocksResumeResend(undefined, 's1')).toBe(false);
  });

  it('does not block when the target session id is missing', () => {
    expect(blocksResumeResend({ sessionId: 's1' }, null)).toBe(false);
    expect(blocksResumeResend({ sessionId: 's1' }, undefined)).toBe(false);
  });
});

// --- SessionLiveness type wiring smoke test ------------------------------------

it('SessionLiveness accepts the documented /api/olam/liveness response shape', () => {
  const live: SessionLiveness = { state: 'live' };
  const dormant: SessionLiveness = { state: 'dormant', phase: 'disposed', done: true, containerSessionId: 'c1' };
  expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>), live)).toBe('steer');
  expect(remoteComposerMode(remote({}), dormant)).toBe('dormant');
});
