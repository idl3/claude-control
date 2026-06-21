import { describe, it, expect } from 'vitest';
import {
  buildSpawnMessage,
  validateSpawnForm,
  agentDisabledReason,
} from './spawn';
import type { SpawnFormState, AgentInfo } from './spawn';

// ---------------------------------------------------------------------------
// buildSpawnMessage
// ---------------------------------------------------------------------------

describe('buildSpawnMessage — new-window', () => {
  const base: SpawnFormState = {
    agentType: 'claude',
    mode: 'new-window',
    session: 'main',
    name: '',
    cwd: '/home/user/project',
  };

  it('returns correct message for valid new-window state', () => {
    expect(buildSpawnMessage(base)).toEqual({
      type: 'spawn',
      agentType: 'claude',
      target: { mode: 'new-window', session: 'main' },
      cwd: '/home/user/project',
    });
  });

  it('returns correct message with codex agentType', () => {
    const msg = buildSpawnMessage({ ...base, agentType: 'codex' });
    expect(msg).not.toBeNull();
    expect(msg!.agentType).toBe('codex');
    expect(msg!.target).toEqual({ mode: 'new-window', session: 'main' });
  });

  it('returns null when session is empty', () => {
    expect(buildSpawnMessage({ ...base, session: '' })).toBeNull();
  });

  it('returns null when session is whitespace only', () => {
    expect(buildSpawnMessage({ ...base, session: '   ' })).toBeNull();
  });

  it('returns null when cwd is empty', () => {
    expect(buildSpawnMessage({ ...base, cwd: '' })).toBeNull();
  });

  it('returns null when cwd is whitespace only', () => {
    expect(buildSpawnMessage({ ...base, cwd: '   ' })).toBeNull();
  });

  it('trims cwd and session in the output', () => {
    const msg = buildSpawnMessage({ ...base, session: '  main  ', cwd: '  /home/user  ' });
    expect(msg).not.toBeNull();
    expect(msg!.cwd).toBe('/home/user');
    expect((msg!.target as { mode: string; session: string }).session).toBe('main');
  });
});

describe('buildSpawnMessage — new-session', () => {
  const base: SpawnFormState = {
    agentType: 'claude',
    mode: 'new-session',
    session: '',
    name: 'my-project',
    cwd: '/home/user/project',
  };

  it('returns correct message for valid new-session state', () => {
    expect(buildSpawnMessage(base)).toEqual({
      type: 'spawn',
      agentType: 'claude',
      target: { mode: 'new-session' },
      cwd: '/home/user/project',
      name: 'my-project',
    });
  });

  it('includes name at top level for new-session', () => {
    const msg = buildSpawnMessage(base);
    expect(msg).not.toBeNull();
    expect(msg!.name).toBe('my-project');
  });

  it('returns null when name is empty', () => {
    expect(buildSpawnMessage({ ...base, name: '' })).toBeNull();
  });

  it('returns null when name is whitespace only', () => {
    expect(buildSpawnMessage({ ...base, name: '   ' })).toBeNull();
  });

  it('returns null for name with dot (a.b)', () => {
    expect(buildSpawnMessage({ ...base, name: 'a.b' })).toBeNull();
  });

  it('returns null for name with colon (a:b)', () => {
    expect(buildSpawnMessage({ ...base, name: 'a:b' })).toBeNull();
  });

  it('returns null for name with space (a b)', () => {
    expect(buildSpawnMessage({ ...base, name: 'a b' })).toBeNull();
  });

  it('allows underscores and hyphens in name', () => {
    const msg = buildSpawnMessage({ ...base, name: 'my_proj-42' });
    expect(msg).not.toBeNull();
    expect(msg!.name).toBe('my_proj-42');
  });

  it('returns null when cwd is empty', () => {
    expect(buildSpawnMessage({ ...base, cwd: '' })).toBeNull();
  });
});

describe('buildSpawnMessage — invalid agentType', () => {
  it('returns null for unknown agentType', () => {
    const state = {
      agentType: 'gpt' as 'claude' | 'codex',
      mode: 'new-window' as const,
      session: 'main',
      name: '',
      cwd: '/home/user',
    };
    expect(buildSpawnMessage(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateSpawnForm
// ---------------------------------------------------------------------------

describe('validateSpawnForm', () => {
  const validBase: SpawnFormState = {
    agentType: 'claude',
    mode: 'new-window',
    session: 'main',
    name: '',
    cwd: '/home/user/project',
  };

  it('returns empty map for a fully valid form', () => {
    expect(validateSpawnForm(validBase)).toEqual({});
  });

  it('flags relative cwd', () => {
    const errors = validateSpawnForm({ ...validBase, cwd: 'relative/path' });
    expect(errors.cwd).toBeTruthy();
  });

  it('does not flag empty cwd (buildSpawnMessage handles that)', () => {
    const errors = validateSpawnForm({ ...validBase, cwd: '' });
    expect(errors.cwd).toBeUndefined();
  });

  it('flags bad new-session name with dot', () => {
    const errors = validateSpawnForm({
      ...validBase,
      mode: 'new-session',
      name: 'foo.bar',
    });
    expect(errors.name).toBeTruthy();
  });

  it('flags bad new-session name with colon', () => {
    const errors = validateSpawnForm({
      ...validBase,
      mode: 'new-session',
      name: 'foo:bar',
    });
    expect(errors.name).toBeTruthy();
  });

  it('does not flag a valid new-session name', () => {
    const errors = validateSpawnForm({
      ...validBase,
      mode: 'new-session',
      name: 'valid-name_42',
    });
    expect(errors.name).toBeUndefined();
  });

  it('does not flag name validation for new-window mode', () => {
    const errors = validateSpawnForm({
      ...validBase,
      mode: 'new-window',
      name: 'foo.bar',
    });
    expect(errors.name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agentDisabledReason
// ---------------------------------------------------------------------------

describe('agentDisabledReason', () => {
  const agents: AgentInfo[] = [
    { id: 'claude', available: true },
    { id: 'codex', available: false, reason: 'codex binary not found' },
  ];

  it('returns null for an available agent', () => {
    expect(agentDisabledReason(agents, 'claude')).toBeNull();
  });

  it('returns the reason string for an unavailable agent', () => {
    expect(agentDisabledReason(agents, 'codex')).toBe('codex binary not found');
  });

  it('returns a fallback reason when unavailable agent has no reason field', () => {
    const noReason: AgentInfo[] = [{ id: 'codex', available: false }];
    const result = agentDisabledReason(noReason, 'codex');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('returns a reason when the agent id is not in the list at all', () => {
    const result = agentDisabledReason([], 'claude');
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});
