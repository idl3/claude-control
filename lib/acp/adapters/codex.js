/**
 * Codex ACP spawn. Official `@agentclientprotocol/codex-acp` stdio adapter.
 * Existing Codex RPC/tmux paths in lib/codex-rpc.js are untouched.
 */

/**
 * @param {{
 *   binaryPath?: string,
 *   skipPermissions?: boolean,
 *   codexPath?: string | null,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {{ command: string, args: string[], env: NodeJS.ProcessEnv }}
 */
export function buildCodexAcpSpawn(opts = {}) {
  const command = opts.binaryPath || process.env.CODEX_ACP_BIN || 'codex-acp';
  const env = { ...(opts.env || process.env) };
  if (opts.codexPath) env.CODEX_PATH = opts.codexPath;
  env.NO_BROWSER = '1';
  if (opts.skipPermissions) env.INITIAL_AGENT_MODE = 'agent-full-access';
  return { command, args: [], env };
}
