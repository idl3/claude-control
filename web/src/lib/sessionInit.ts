// sessionInit — detect + format the CF-Sandbox runner's session-init manifest.
//
// The olam in-container chunk-poster emits ONE chunk at run start digesting the
// `{type:'system',subtype:'init'}` stream-json event — the only event carrying
// which MCP servers connected (status 'connected'|'failed') and how many skills
// loaded. It rides as an ordinary text chunk whose body is the JSON envelope
// `{"type":"session_init","mcp_servers":[{name,status}],"slash_commands":N}`
// (packages/worker-runner-cloudflare-sandbox/src/chunk-poster-script.ts in the
// olam repo). assistant-ui's part model is fixed (text/reasoning/tool-call), so
// rather than a bespoke part type we render a READABLE one-line summary in place
// of the raw JSON — "render differently" without faking a tool-call.
//
// Detection is defensive: any non-JSON / non-session_init payload returns null so
// normal text falls through unchanged.

export interface SessionInitServer {
  readonly name: string;
  readonly status: string;
}

export interface SessionInitPayload {
  readonly servers: readonly SessionInitServer[];
  readonly slashCommands: number;
}

export function parseSessionInit(raw: string): SessionInitPayload | null {
  const trimmed = raw.trimStart();
  // Cheap pre-check before JSON.parse.
  if (trimmed[0] !== '{' || !trimmed.includes('session_init')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as { type?: unknown; mcp_servers?: unknown; slash_commands?: unknown };
  if (candidate.type !== 'session_init') return null;

  const servers: SessionInitServer[] = Array.isArray(candidate.mcp_servers)
    ? candidate.mcp_servers
        .map((s) => {
          if (s === null || typeof s !== 'object') return null;
          const e = s as { name?: unknown; status?: unknown };
          const name = typeof e.name === 'string' ? e.name : '';
          const status = typeof e.status === 'string' ? e.status : 'unknown';
          return name ? { name, status } : null;
        })
        .filter((s): s is SessionInitServer => s !== null)
    : [];
  const slashCommands =
    typeof candidate.slash_commands === 'number' && Number.isFinite(candidate.slash_commands)
      ? candidate.slash_commands
      : 0;
  return { servers, slashCommands };
}

/**
 * One-line readable summary of a session-init manifest, e.g.
 *   "Context loaded · MCP olam: connected · 15 skills"
 *   "Context loaded · MCP olam: FAILED, kg: connected · 15 skills"
 * A FAILED server is upper-cased so a silent connection failure reads loudly.
 */
export function formatSessionInit(payload: SessionInitPayload): string {
  const parts: string[] = ['Context loaded'];
  if (payload.servers.length > 0) {
    const servers = payload.servers
      .map((s) => `${s.name}: ${s.status === 'failed' ? 'FAILED' : s.status}`)
      .join(', ');
    parts.push(`MCP ${servers}`);
  }
  parts.push(`${payload.slashCommands} ${payload.slashCommands === 1 ? 'skill' : 'skills'}`);
  return parts.join(' · ');
}
