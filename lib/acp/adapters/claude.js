/**
 * Claude ACP spawn. Official `@agentclientprotocol/claude-agent-acp` stdio
 * adapter (wraps the Claude Agent SDK — Claude Code itself has no native ACP
 * mode). Existing claude tmux/print paths are untouched.
 *
 * Model is passed via ANTHROPIC_MODEL (the adapter reads it in
 * session-model.js). Permission skipping is an ACP session MODE
 * (`bypassPermissions`), not a flag — see `initialModeId` on AcpRuntime.
 */

export const CLAUDE_ACP_BYPASS_MODE = 'bypassPermissions';

/**
 * @param {{
 *   binaryPath?: string,
 *   model?: string | null,
 *   skipPermissions?: boolean,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {{ command: string, args: string[], env: NodeJS.ProcessEnv, initialModeId: string | null }}
 */
export function buildClaudeAcpSpawn(opts = {}) {
  const command = opts.binaryPath || process.env.CLAUDE_ACP_BIN || 'claude-agent-acp';
  const env = { ...(opts.env || process.env) };
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (model) env.ANTHROPIC_MODEL = model;
  env.NO_BROWSER = '1';
  return {
    command,
    args: [],
    env,
    initialModeId: opts.skipPermissions ? CLAUDE_ACP_BYPASS_MODE : null,
  };
}
