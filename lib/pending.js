// lib/pending.js — shared pending-detection logic used by both SessionRegistry
// (discovery-time tail scan) and ClaudeAdapter (adapter contract method).
//
// Kept in a dedicated module to avoid a circular import between:
//   sessions.js → agents/index.js → agents/claude.js → sessions.js

const PENDING_QUESTION_MAX = 140; // truncate the surfaced question text

/**
 * Walk a set of JSONL tail lines and decide whether an AskUserQuestion is still
 * OPEN — i.e. an assistant `tool_use` block named "AskUserQuestion" exists whose
 * id has NO matching `tool_result` (tool_use_id) later in the tail. Pure and
 * unit-testable in isolation (see test/push-pending.test.js).
 *
 * @param {string[]} lines  Complete JSONL lines (partial first line tolerated).
 * @returns {{ transcriptPending: boolean, pendingToolUseId: string|null, pendingQuestion: string|null }}
 */
export function detectTranscriptPending(lines) {
  /** @type {Map<string, string|null>} open AskUserQuestion id -> first question text */
  const open = new Map();
  const resolved = new Set();

  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;

    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (
        rec.type === 'assistant' &&
        block.type === 'tool_use' &&
        block.name === 'AskUserQuestion' &&
        typeof block.id === 'string'
      ) {
        const q = block.input?.questions?.[0]?.question;
        open.set(block.id, typeof q === 'string' ? q : null);
      } else if (
        rec.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        resolved.add(block.tool_use_id);
      }
    }
  }

  // Newest still-open AskUserQuestion (Map preserves insertion order).
  let pendingToolUseId = null;
  let pendingQuestion = null;
  for (const [id, question] of open) {
    if (resolved.has(id)) continue;
    pendingToolUseId = id;
    pendingQuestion = question;
  }

  if (pendingQuestion && pendingQuestion.length > PENDING_QUESTION_MAX) {
    pendingQuestion = pendingQuestion.slice(0, PENDING_QUESTION_MAX);
  }

  return {
    transcriptPending: pendingToolUseId !== null,
    pendingToolUseId,
    pendingQuestion,
  };
}
