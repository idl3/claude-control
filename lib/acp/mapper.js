/**
 * Map ACP session/update notifications onto NormalizedMessage (lib/transcript.js).
 * Chunks for the same in-flight assistant/thought message share a stable uuid
 * so the client can upsert instead of spawning a bubble per token.
 */
import { randomUUID } from 'node:crypto';

function inputSummary(input) {
  if (input == null) return '';
  let s;
  try { s = JSON.stringify(input); } catch { s = String(input); }
  s = s.replace(/[\r\n\t]+/g, ' ');
  if (s.length > 120) s = s.slice(0, 117) + '...';
  return s;
}

function textOf(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  return '';
}

export class AcpMapper {
  constructor() {
    this._assistant = null;
    this._thinking = null;
    this._tools = new Map();
  }

  /**
   * @param {{ sessionId?: string, update?: object }} params
   * @returns {import('../transcript.js').NormalizedMessage[]}
   */
  applyUpdate(params) {
    const update = params?.update || {};
    const kind = update.sessionUpdate;
    const ts = new Date().toISOString();
    const out = [];

    if (kind === 'agent_thought_chunk') {
      const chunk = textOf(update.content);
      if (!this._thinking) {
        this._thinking = {
          uuid: `acp-thought-${randomUUID()}`,
          role: 'assistant',
          ts,
          blocks: [{ kind: 'thinking', text: chunk }],
          rawType: 'acp-thought',
        };
      } else {
        this._thinking.blocks[0].text += chunk;
        this._thinking.ts = ts;
      }
      out.push({ ...this._thinking, blocks: this._thinking.blocks.map((b) => ({ ...b })) });
      return out;
    }

    if (kind === 'agent_message_chunk') {
      const chunk = textOf(update.content);
      if (!this._assistant) {
        this._assistant = {
          uuid: `acp-assistant-${randomUUID()}`,
          role: 'assistant',
          ts,
          blocks: [{ kind: 'text', text: chunk }],
          rawType: 'acp-assistant',
        };
      } else {
        const textBlock = this._assistant.blocks.find((b) => b.kind === 'text');
        if (textBlock) textBlock.text += chunk;
        else this._assistant.blocks.push({ kind: 'text', text: chunk });
        this._assistant.ts = ts;
      }
      out.push({
        ...this._assistant,
        blocks: this._assistant.blocks.map((b) => (b.kind === 'text' ? { ...b } : b)),
      });
      return out;
    }

    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this._thinking = null;
      this._assistant = null;
      const id = update.toolCallId || update.tool_call_id;
      if (!id) return out;
      const prev = this._tools.get(id) || {
        uuid: `acp-tool-${id}`,
        role: 'assistant',
        ts,
        blocks: [{
          kind: 'tool_use',
          id,
          name: update.title || update.kind || 'tool',
          input: update.rawInput || update.raw_input || {},
          inputSummary: inputSummary(update.rawInput || update.raw_input),
        }],
        rawType: 'acp-tool',
      };
      const use = prev.blocks[0];
      if (update.title) use.name = update.title;
      if (update.rawInput || update.raw_input) {
        use.input = update.rawInput || update.raw_input;
        use.inputSummary = inputSummary(use.input);
      }
      const content = Array.isArray(update.content) ? update.content : [];
      const output = content
        .map((c) => (c?.type === 'content' ? textOf(c.content) : textOf(c)))
        .filter(Boolean)
        .join('');
      const status = update.status || update._meta?.updateParams?.status;
      const resultBlock = prev.blocks.find((b) => b.kind === 'tool_result');
      if (output || status === 'completed' || status === 'failed') {
        const text = output || resultBlock?.text || '';
        const isError = status === 'failed';
        if (resultBlock) {
          resultBlock.text = text;
          resultBlock.isError = isError;
        } else {
          prev.blocks.push({ kind: 'tool_result', forId: id, text, isError });
        }
      }
      prev.ts = ts;
      this._tools.set(id, prev);
      if (status === 'completed' || status === 'failed') this._tools.delete(id);
      out.push({
        ...prev,
        blocks: prev.blocks.map((b) => ({ ...b })),
      });
      return out;
    }

    return out;
  }

  /** Close in-flight assistant/thought segments (end of prompt turn). */
  flush() {
    this._assistant = null;
    this._thinking = null;
  }
}

/**
 * Build a user NormalizedMessage from a prompt turn.
 * @param {string} text
 * @param {string} [uuid]
 */
const MAX_BUFFER = 4000;

/**
 * Union-by-uuid with in-place replace (ACP streams grow a stable uuid).
 * @param {object[]} existing
 * @param {object[]} incoming
 */
export function mergeNormalized(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return existing || [];
  if (!existing || existing.length === 0) return incoming.slice(-MAX_BUFFER);
  const index = new Map(existing.map((m, i) => [m.uuid, i]));
  const next = existing.slice();
  for (const msg of incoming) {
    if (!msg?.uuid) continue;
    const i = index.get(msg.uuid);
    if (i == null) {
      index.set(msg.uuid, next.length);
      next.push(msg);
    } else {
      next[i] = msg;
    }
  }
  return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
}

export function userMessage(text, uuid = `acp-user-${randomUUID()}`) {
  return {
    uuid,
    role: 'user',
    ts: new Date().toISOString(),
    blocks: [{ kind: 'text', text: String(text ?? '') }],
    rawType: 'acp-user',
  };
}
