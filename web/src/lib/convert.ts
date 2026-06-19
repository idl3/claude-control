import type { ThreadMessageLike } from '@assistant-ui/react';
import type { Block, Msg } from './types';

// assistant-ui content part shapes we emit (subset of ThreadMessageLike content).
type TextPart = { type: 'text'; text: string };
type ReasoningPart = { type: 'reasoning'; text: string };
type ToolCallPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsText: string;
  result?: unknown;
  isError?: boolean;
};

// Reserved key on a tool-call's args carrying the one-line input summary the
// converter precomputed. Kept separate from the real tool input so the native
// tool renderer can show a tight header without re-deriving it.
const SUMMARY_KEY = '__cockpitSummary';

// Reserved shape of the result we hand to the native tool renderer. The raw
// tool_result is plain text in our transcript, so we wrap it as an object the
// renderer knows how to read (and which serializes cleanly if inspected).
export interface CockpitToolResult {
  text: string;
  isError: boolean;
}

export function toolSummary(args: unknown): string {
  if (args && typeof args === 'object' && SUMMARY_KEY in args) {
    const v = (args as Record<string, unknown>)[SUMMARY_KEY];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

// The real tool input, with the reserved summary key stripped, for pretty-print.
export function toolInput(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k !== SUMMARY_KEY) rest[k] = v;
  }
  return rest;
}

export function toolResult(result: unknown): CockpitToolResult | null {
  if (
    result &&
    typeof result === 'object' &&
    'text' in (result as Record<string, unknown>)
  ) {
    const r = result as { text?: unknown; isError?: unknown };
    return { text: String(r.text ?? ''), isError: !!r.isError };
  }
  return null;
}

/**
 * Convert our transcript Msg[] into assistant-ui ThreadMessageLike[].
 *
 * Tool results arrive as their own `tool_result` blocks (often in a later
 * message) keyed by `forId`. assistant-ui models a tool call as a single part
 * carrying both args and result, so we first index all results, then attach
 * them to the matching tool-call part.
 *
 * Tool input + result text are passed through as native `tool-call` part
 * fields (`args` holds the structured input, `result` the wrapped output) so
 * assistant-ui's native tool component renders them. The only reserved key is
 * the precomputed one-line summary, stashed under SUMMARY_KEY. Nothing is ever
 * passed through dangerouslySetInnerHTML — React escapes all of it.
 */
export function convertMessages(messages: Msg[]): ThreadMessageLike[] {
  // Pass 1: index tool_result blocks by the tool_use id they answer.
  const resultsById = new Map<string, CockpitToolResult>();
  for (const msg of messages) {
    for (const block of msg.blocks ?? []) {
      if (block.kind === 'tool_result') {
        resultsById.set(block.forId, {
          text: block.text ?? '',
          isError: !!block.isError,
        });
      }
    }
  }

  // Pass 2: build messages. Drop messages that contain only tool_result
  // blocks (their content is folded into the originating tool-call part).
  const out: ThreadMessageLike[] = [];
  // assistant-ui's MessageRepository THROWS (crashing the whole thread) if two
  // messages share an id. Compacted/resumed transcripts can repeat a uuid, so
  // dedupe defensively: suffix any repeat with its index (always unique).
  const seenIds = new Set<string>();
  messages.forEach((msg, i) => {
    const parts = buildParts(msg.blocks ?? [], resultsById, msg.role === 'user');
    if (parts.length === 0) return;

    // assistant-ui only allows tool-call parts on assistant messages. Map
    // user/assistant straight through; render system as assistant tagged via
    // metadata so its styling differs without violating the system-message
    // single-text-part rule.
    const role: ThreadMessageLike['role'] =
      msg.role === 'user' ? 'user' : 'assistant';

    let id = msg.uuid || `m-${i}`;
    if (seenIds.has(id)) id = `${id}#${i}`;
    seenIds.add(id);

    out.push({
      role,
      id,
      createdAt: msg.ts ? new Date(msg.ts) : undefined,
      content: parts,
      metadata: { custom: { cockpitRole: msg.role } },
    } as ThreadMessageLike);
  });

  return mergeAssistantTurns(out);
}

/**
 * Claude Code emits ONE assistant turn as MANY JSONL messages — a thinking
 * message, then a tool-use message (its tool_result lands as a `user` message
 * that buildParts drops), then more thinking/tools, then a final text message.
 * Rendered 1:1 that's a repetitive stack of "ASSISTANT · chain of thought · 1
 * step" blocks. Merge a run of consecutive assistant messages into ONE turn so
 * the whole turn's work groups into a single chain-of-thought that closes when
 * the turn ends.
 *
 * Turn boundary = a real human `user` message (tool_result user-messages were
 * already dropped, so they never split a turn). A tagged system message
 * (cockpitRole==='system') also ends the run so its distinct styling survives.
 */
function mergeAssistantTurns(messages: ThreadMessageLike[]): ThreadMessageLike[] {
  const isPlainAssistant = (m: ThreadMessageLike) =>
    m.role === 'assistant' &&
    (m.metadata?.custom?.cockpitRole ?? 'assistant') === 'assistant';

  const merged: ThreadMessageLike[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && isPlainAssistant(prev) && isPlainAssistant(m)) {
      merged[merged.length - 1] = {
        ...prev,
        content: [
          ...(prev.content as unknown[]),
          ...(m.content as unknown[]),
        ],
      } as ThreadMessageLike;
    } else {
      merged.push(m);
    }
  }
  return merged;
}

/**
 * Claude Code injects plumbing into user turns — background <task-notification>
 * completions, <system-reminder>s, slash-command echoes, hook output. Rendered
 * verbatim they dump huge raw-XML user bubbles ("unhandled tool calls"). Collapse
 * each to a compact one-line label so the transcript stays a conversation.
 * Returns null when the text is normal user prose (rendered unchanged).
 */
export function compactSystemText(text: string): string | null {
  const t = text.trimStart();
  if (!t.startsWith('<')) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
  if (t.startsWith('<task-notification'))
    return `⚙ background task ${summary ? `— ${summary}` : 'update'}`;
  if (t.startsWith('<system-reminder')) return '⚙ system reminder';
  if (t.startsWith('<command-name') || t.startsWith('<command-message'))
    return '⌘ slash command';
  if (t.startsWith('<local-command-stdout')) return '⌘ command output';
  if (t.startsWith('<user-prompt-submit-hook') || t.startsWith('<session-'))
    return '⚙ session hook';
  return null;
}

function buildParts(
  blocks: Block[],
  resultsById: Map<string, CockpitToolResult>,
  isUser = false,
): Array<TextPart | ReasoningPart | ToolCallPart> {
  const parts: Array<TextPart | ReasoningPart | ToolCallPart> = [];

  for (const block of blocks) {
    switch (block.kind) {
      case 'text': {
        // Empty text parts are dropped by assistant-ui; skip to avoid noise.
        if (block.text && block.text.length > 0) {
          const compact = isUser ? compactSystemText(block.text) : null;
          parts.push({ type: 'text', text: compact ?? block.text });
        }
        break;
      }
      case 'thinking': {
        if (block.text && block.text.trim().length > 0) {
          parts.push({ type: 'reasoning', text: block.text });
        }
        break;
      }
      case 'tool_use': {
        const result = resultsById.get(block.id);
        // Structured input becomes the part's `args`; the precomputed summary
        // rides along under a reserved key the renderer strips back out.
        const input =
          block.input && typeof block.input === 'object'
            ? (block.input as Record<string, unknown>)
            : block.input != null
              ? { value: block.input }
              : {};
        parts.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name || 'tool',
          args: { ...input, [SUMMARY_KEY]: block.inputSummary ?? '' },
          argsText: block.inputSummary ?? '',
          result: result ?? undefined,
          isError: result?.isError,
        });
        break;
      }
      case 'tool_result':
        // Folded into the matching tool-call part above.
        break;
      default:
        break;
    }
  }

  return parts;
}
