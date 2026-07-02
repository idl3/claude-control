import { describe, it, expect } from 'vitest';
import { remoteComposerMode } from './olamMode';
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
