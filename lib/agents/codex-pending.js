// lib/agents/codex-pending.js
//
// Pure mappers between the native Codex capture pending shape (produced by
// CodexAdapter.detectPendingFromCapture) and the frontend Pending contract
// (web/src/lib/types.ts). Kept separate from codex.js to isolate the
// adapter's capture logic from the server-layer shape translation.
//
// This module has NO side effects — safe to import anywhere.

// ---------------------------------------------------------------------------
// djb2 hash — deterministic string hash used for stable synthetic toolUseIds.
// Produces a base-36 string. Collisions are astronomically unlikely for option
// label sets of any reasonable size.
//
// @param {string} str
// @returns {string}
// ---------------------------------------------------------------------------
function djb2hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    // djb2: h = ((h << 5) + h) ^ c
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    // Keep within 32-bit signed range (JS bitwise ops are 32-bit)
    h = h | 0;
  }
  // Convert to unsigned 32-bit, then base-36 string
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// kindLabel — human-readable label for a Codex pending kind.
//
// @param {string|null} kind
// @returns {string}
// ---------------------------------------------------------------------------
function kindLabel(kind) {
  switch (kind) {
    case 'exec_command':
      return 'Run command';
    case 'apply_patch':
      return 'Apply edits';
    case 'directory_trust':
      return 'Trust directory';
    default:
      return kind || 'Approval';
  }
}

/**
 * Map a native Codex capture pending shape to the frontend Pending contract.
 *
 * Returns null when the native shape is absent, not pending, or has no options
 * (nothing to render in the AskModal).
 *
 * The `toolUseId` is a synthetic, DETERMINISTIC identifier derived from the
 * modal's content so:
 *   - It is STABLE across repeated captures of the same modal (the stale-guard
 *     and the React modal `key` do not thrash).
 *   - It CHANGES when a new modal appears (different kind or different options).
 *
 * @param {{ transcriptPending: boolean, pendingKind: string|null, header: string|null, options: Array<{n:number,label:string,shortcut:string|null,highlighted:boolean}> }|null|undefined} native
 * @returns {{ toolUseId: string, questions: Array<{ question: string, header?: string, multiSelect: boolean, options: Array<{label:string,description?:string}> }> }|null}
 */
export function codexPendingToFrontend(native) {
  if (!native || !native.transcriptPending || native.options.length === 0) {
    return null;
  }

  const { pendingKind, header, options } = native;

  // Deterministic id: content-hash of the option list.
  const optionKey = options.map((o) => `${o.n}:${o.label}`).join('|');
  const toolUseId = `codex:${pendingKind}:${djb2hash(optionKey)}`;

  /** @type {Array<{label:string,description?:string}>} */
  const feOptions = options.map((o) => {
    /** @type {{label:string,description?:string}} */
    const fe = { label: o.label };
    if (o.shortcut) fe.description = `key: ${o.shortcut}`;
    return fe;
  });

  return {
    toolUseId,
    questions: [
      {
        question: header || 'Approval required',
        header: kindLabel(pendingKind),
        multiSelect: false,
        options: feOptions,
      },
    ],
  };
}

/**
 * Validate a frontend answer against the native pending options and return the
 * selections unchanged when valid.
 *
 * The frontend sends `selections = [[label]]` (one question, one chosen label).
 * This bridge validates the chosen label exists in `native.options`; throws when
 * not found (parity with Claude's reject-unknown-option guard). Returns the
 * original selections array on success so the caller can pass it straight to
 * `CodexAdapter.buildAnswerProgram(native, selections)`.
 *
 * @param {{ options: Array<{label:string}> }} native  native capture pending shape
 * @param {string[][]} selections  frontend selections: selections[0][0] = chosen label
 * @returns {string[][]}
 * @throws {Error} when the selected label is not present in native.options
 */
export function frontendSelectionToNative(native, selections) {
  const chosenLabel = selections?.[0]?.[0];
  if (chosenLabel != null) {
    const exists = (native?.options || []).some((o) => o.label === chosenLabel);
    if (!exists) {
      throw new Error('selection not in pending options');
    }
  }
  return selections;
}
