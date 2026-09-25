/**
 * Grok ACP spawn + auth. Native `grok agent stdio`.
 */

export const GROK_AUTH_API_KEY = 'xai.api_key';
export const GROK_AUTH_CACHED_TOKEN = 'cached_token';

export function grokAuthMethodId(env = process.env) {
  return env.XAI_API_KEY?.trim() ? GROK_AUTH_API_KEY : GROK_AUTH_CACHED_TOKEN;
}

/**
 * @param {{
 *   binaryPath?: string,
 *   model?: string | null,
 *   reasoningEffort?: string | null,
 *   skipPermissions?: boolean,
 * }} [opts]
 * @returns {{ command: string, args: string[] }}
 */
export function buildGrokSpawn(opts = {}) {
  const command = opts.binaryPath || process.env.GROK_BIN || 'grok';
  const args = [];
  const model = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (model) args.push('-m', model);
  const effort = typeof opts.reasoningEffort === 'string' ? opts.reasoningEffort.trim() : '';
  if (effort) args.push('--reasoning-effort', effort);
  args.push('agent', '--no-leader');
  if (opts.skipPermissions) args.push('--always-approve');
  args.push('stdio');
  return { command, args };
}
