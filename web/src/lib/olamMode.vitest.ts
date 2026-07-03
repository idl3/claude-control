import { describe, it, expect } from 'vitest';
import {
  remoteComposerMode,
  isExecuteShaped,
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

  it('dormant/unknown titles carry the same refusal copy as REMOTE_REFUSAL_MESSAGES', () => {
    expect(remoteModeTitle('dormant')).toBe(REMOTE_REFUSAL_MESSAGES.dormant);
    expect(remoteModeTitle('unknown')).toBe(REMOTE_REFUSAL_MESSAGES.unknown);
  });

  it('an unrecognised mode value renders a visible ⚠ fallback, never a silent steer label', () => {
    const bogus = 'bogus-mode' as unknown as RemoteComposerMode;
    expect(remoteModeLabel(bogus)).toBe('⚠ bogus-mode');
    expect(remoteModeLabel(bogus)).not.toBe(remoteModeLabel('steer'));
    expect(remoteModeTitle(bogus)).toContain('bogus-mode');
  });
});

// --- SessionLiveness type wiring smoke test ------------------------------------

it('SessionLiveness accepts the documented /api/olam/liveness response shape', () => {
  const live: SessionLiveness = { state: 'live' };
  const dormant: SessionLiveness = { state: 'dormant', phase: 'disposed', done: true, containerSessionId: 'c1' };
  expect(remoteComposerMode(remote({ pool: 'linear' } as Partial<Session>), live)).toBe('steer');
  expect(remoteComposerMode(remote({}), dormant)).toBe('dormant');
});
