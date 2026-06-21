// lib/agents/index.js — the adapter registry.
//
// ONE literal, ordered list of the agents claude-control knows how to drive.
// No plugin loader, no dynamic registration, no config-driven discovery — adding
// an agent means adding its module and one entry here (anti-over-engineering
// guard, see the parity plan §7).
//
// Phase 0 registers Claude only. Codex slots in as a second entry in a later
// phase; ordering is the process-match priority for `adapterFor`.

import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';

/** @type {import('./adapter.js').AgentAdapter[]} */
export const ADAPTERS = [ClaudeAdapter, CodexAdapter];

/** The adapter used when none is specified (back-compat default). */
export const DEFAULT_ADAPTER = ClaudeAdapter;

/**
 * Resolve the adapter whose process-match claims a tmux pane command, in
 * registration order. Returns null when no adapter recognises the process.
 *
 * @param {string} cmd  tmux pane_current_command
 * @returns {import('./adapter.js').AgentAdapter|null}
 */
export function adapterFor(cmd) {
  for (const adapter of ADAPTERS) {
    if (adapter.matchesProcess(cmd)) return adapter;
  }
  return null;
}

/**
 * Resolve an adapter by its id.
 *
 * @param {string} id
 * @returns {import('./adapter.js').AgentAdapter|null}
 */
export function adapterById(id) {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}
