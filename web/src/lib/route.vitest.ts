import { describe, it, expect } from 'vitest';
import { parsePath, buildPath } from './route';

describe('parsePath', () => {
  it('parses /session/window/pane → id', () => {
    expect(parsePath('/0/1/1')).toBe('0:1.1');
    expect(parsePath('/0/12/3')).toBe('0:12.3');
  });

  it('accepts a non-numeric session name', () => {
    expect(parsePath('/_mobile/1/2')).toBe('_mobile:1.2');
  });

  it('rejects non-session paths', () => {
    expect(parsePath('/')).toBeNull();
    expect(parsePath('/0/1')).toBeNull();
    expect(parsePath('/0/1/1/2')).toBeNull();
    expect(parsePath('/0/x/1')).toBeNull();
    expect(parsePath('/assets/index.js')).toBeNull();
  });
});

describe('buildPath', () => {
  it('builds a clean path from an id', () => {
    expect(buildPath('0:1.1')).toBe('/0/1/1');
  });

  it('preserves the token query', () => {
    expect(buildPath('0:2.1', '?token=abc')).toBe('/0/2/1?token=abc');
  });

  it('round-trips with parsePath', () => {
    for (const id of ['0:1.1', '3:10.2', '_mobile:1.0']) {
      expect(parsePath(buildPath(id))).toBe(id);
    }
  });

  it('falls back to / for malformed ids', () => {
    expect(buildPath('garbage')).toBe('/');
  });
});
