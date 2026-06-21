// lib/agents/claude.js — ClaudeAdapter
//
// Concrete implementation of AgentAdapter for Claude Code. Wraps existing
// module-level functions so the shared runtime can swap adapters per-pane.
// This file must NOT import from lib/agents/index.js (would be circular).

import { parseRecord } from '../transcript.js';
import { detectTranscriptPending } from '../pending.js';
import { buildAnswerProgram } from '../answer.js';
import { parseTuiStatus, prettyModel } from '../tui.js';
import { buildClaudeTranscriptIndex } from '../transcript-index.js';

/** @type {import('./adapter.js').AgentAdapter} */
export const ClaudeAdapter = {
  id: 'claude',

  /**
   * A pane is a Claude Code session when its process title is the Claude
   * version string (e.g. "2.1.162") — shells report zsh/bash/etc.
   *
   * @param {string} cmd
   * @returns {boolean}
   */
  matchesProcess(cmd) {
    return /^\d+\.\d+(\.\d+)?$/.test(String(cmd || '').trim());
  },

  /**
   * Parse one JSONL line into a NormalizedMessage, or null.
   *
   * @type {import('./adapter.js').AgentAdapter['parseRecord']}
   */
  parseRecord,

  /**
   * Walk a set of JSONL tail lines and decide whether an AskUserQuestion is
   * still open. Delegates to the shared lib/pending.js implementation.
   *
   * @type {import('./adapter.js').AgentAdapter['detectTranscriptPending']}
   */
  detectTranscriptPending,

  /**
   * Build the keystroke program to answer the current AskUserQuestion prompt.
   *
   * @type {import('./adapter.js').AgentAdapter['buildAnswerProgram']}
   */
  buildAnswerProgram,

  /**
   * Parse model + ctx% from a capture-pane dump.
   *
   * @type {import('./adapter.js').AgentAdapter['parseTuiStatus']}
   */
  parseTuiStatus,

  /**
   * Prettify a raw transcript model id into a short display label.
   *
   * @type {import('./adapter.js').AgentAdapter['prettyModel']}
   */
  prettyModel,

  /**
   * Inspect a freshly-parsed NormalizedMessage and update the pending map.
   * Adds open AskUserQuestion tool_use ids and removes matching tool_result ids.
   *
   * Byte-identical logic to TranscriptTailer._trackPending (lib/transcript.js
   * lines ~413-429) but taking an explicit `pendingMap` argument so it is
   * adapter-injectable.
   *
   * @param {import('./adapter.js').NormalizedMessage} msg
   * @param {Map<string, object>} pendingMap
   */
  trackPending(msg, pendingMap) {
    for (const block of msg.blocks) {
      if (block.kind === 'tool_use' && block.name === 'AskUserQuestion') {
        // input.questions is the questions array per CONTRACT spec.
        const questions = Array.isArray(block.input?.questions)
          ? block.input.questions
          : [];
        pendingMap.set(block.id, {
          toolUseId: block.id,
          ts: msg.ts,
          questions,
        });
      } else if (block.kind === 'tool_result' && block.forId) {
        pendingMap.delete(block.forId);
      }
    }
  },

  /**
   * Scan Claude Code's projectsRoot for transcript JSONL files, return a
   * cwd-indexed TranscriptIndex. Delegates to buildClaudeTranscriptIndex in
   * lib/sessions.js to avoid duplicating the tail-read helpers.
   *
   * @param {import('./adapter.js').DiscoveryRoots} roots
   * @returns {Promise<import('./adapter.js').TranscriptIndex>}
   */
  async buildTranscriptIndex({ projectsRoot }) {
    return buildClaudeTranscriptIndex(projectsRoot);
  },

  /**
   * Build the spawn command for a new Claude Code session.
   * cwd is set via tmux -c; Claude does not need a -C flag.
   *
   * @param {{ bin?: string }} [opts]
   * @returns {{ bin: string, args: string[] }}
   */
  buildSpawnCommand({ bin = 'claude' } = {}) {
    return { bin, args: [] };
  },
};
