import { describe, expect, it } from 'vitest';
import { parseSessionInit, formatSessionInit } from './sessionInit';

describe('parseSessionInit', () => {
  it('parses a well-formed manifest envelope', () => {
    const raw = JSON.stringify({
      type: 'session_init',
      mcp_servers: [
        { name: 'olam', status: 'connected' },
        { name: 'kg', status: 'connected' },
      ],
      slash_commands: 15,
    });
    expect(parseSessionInit(raw)).toEqual({
      servers: [
        { name: 'olam', status: 'connected' },
        { name: 'kg', status: 'connected' },
      ],
      slashCommands: 15,
    });
  });

  it('tolerates missing fields and drops nameless servers', () => {
    expect(parseSessionInit(JSON.stringify({ type: 'session_init' }))).toEqual({
      servers: [],
      slashCommands: 0,
    });
    const raw = JSON.stringify({ type: 'session_init', mcp_servers: [{ status: 'connected' }], slash_commands: 'x' });
    expect(parseSessionInit(raw)).toEqual({ servers: [], slashCommands: 0 });
  });

  it('returns null for non-session_init JSON, prose, arrays, and malformed JSON', () => {
    expect(parseSessionInit(JSON.stringify({ type: 'thinking', thinking: 'x' }))).toBeNull();
    expect(parseSessionInit('the session_init event')).toBeNull();
    expect(parseSessionInit('[{"type":"session_init"}]')).toBeNull();
    expect(parseSessionInit('{"type":"session_init"')).toBeNull();
  });
});

describe('formatSessionInit', () => {
  it('renders a readable one-line summary', () => {
    expect(
      formatSessionInit({ servers: [{ name: 'olam', status: 'connected' }], slashCommands: 15 }),
    ).toBe('Context loaded · MCP olam: connected · 15 skills');
  });

  it('upper-cases a FAILED server so a silent connection failure reads loudly', () => {
    expect(
      formatSessionInit({
        servers: [
          { name: 'olam', status: 'failed' },
          { name: 'kg', status: 'connected' },
        ],
        slashCommands: 3,
      }),
    ).toBe('Context loaded · MCP olam: FAILED, kg: connected · 3 skills');
  });

  it('omits the MCP clause when no servers, and singularises one skill', () => {
    expect(formatSessionInit({ servers: [], slashCommands: 1 })).toBe('Context loaded · 1 skill');
  });
});
