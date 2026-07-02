// lib/prompt.js — detect a Claude Code TUI selection prompt from a pane capture.
//
// Permission prompts ("Do you want to proceed?  1. Yes / 2. Yes, don't ask /
// 3. No"), trust prompts, and similar numbered menus live ONLY in the live TUI —
// they are never written to the transcript JSONL. The cockpit is transcript-
// driven, so without this it shows a pending tool-call and looks stuck. We poll
// the pane, parse the prompt here, and surface it as an actionable modal.

// Strip ANSI/OSC escape sequences (capture-pane is taken with -e).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB0]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

// A numbered option line, optionally preceded by the TUI cursor (❯/›).
// `\d+` (not `\d`) so pickers with ≥10 rows parse their two-digit numbers.
const OPTION_RE = /^\s*([❯›]?)\s*(\d+)[.)]\s+(.+?)\s*$/;
// Tolerant option-start for detectPanePicker: the dot/paren after the number
// is OPTIONAL — narrow panes can render "5 Type something" with no separator.
// When a separator (./)) IS present it may have zero spaces after it (e.g.
// "3.Deep-verify" on a 22-col pane), so we use: separator + optional-space OR
// no-separator + mandatory-space. This prevents matching bare numbers in prose
// while still catching tight-packed option starts like "3.Deep-verify".
const OPTION_START_RE = /^\s*([❯›]?)\s*(\d+)(?:[.)]\s*|\s+)(.*)$/;
// Box-drawing / horizontal-rule lines to skip (separators, not option text).
const BOX_SEP_RE = /^[\s─━—–=_]+$/;
// Any Unicode box-drawing glyph (U+2500–U+257F). Claude's picker draws a
// floating preview panel with these to the RIGHT of the option column; real
// option labels never contain them, so the first one on a line marks where the
// tmux-flattened box begins.
const BOX_ANY_RE = /[─-╿]/;
// Leading/trailing box-drawing glyphs to strip from individual strings.
// eslint-disable-next-line no-misleading-character-class
const BOX_TRIM_RE = /^[\s─-╿─━—–=_┌┐└┘├┤┼┬┴╔╗╚╝╠╣╦╩╬]+|[\s─-╿─━—–=_┌┐└┘├┤┼┬┴╔╗╚╝╠╣╦╩╬]+$/g;

/**
 * Strip leading/trailing box-drawing glyphs from a string.
 * Preserves inner content including inner pipes that are part of labels.
 * @param {string} s
 * @returns {string}
 */
function stripBoxGlyphs(s) {
  return s.replace(BOX_TRIM_RE, '').trim();
}

/**
 * Strip a floating preview/tooltip box from a captured picker.
 *
 * Claude Code's AskUserQuestion renders a bordered preview panel to the RIGHT of
 * the option list (drawn with ┌─┐ │ └─┘). `tmux capture-pane` flattens that 2-D
 * overlay into text, so the box and its contents land on the SAME lines as the
 * option labels, e.g. (one captured line):
 *   "  2. Continue B2–B5 as    │ stop Phase B at 1/6; resume with app running… │"
 *
 * Since real option labels never contain box-drawing glyphs (U+2500–U+257F),
 * truncating each line at the first such glyph removes the floating box — a
 * full-width rule line collapses to empty, and the "│ …tooltip… │" tail is cut —
 * while leaving the left-hand option column intact. Non-bordered pickers have no
 * glyphs and pass through unchanged.
 *
 * @param {string[]} lines  stripped, trailing-whitespace-trimmed lines
 * @returns {string[]}
 */
function stripFloatingBox(lines) {
  return lines.map((line) => {
    const i = line.search(BOX_ANY_RE);
    return i === -1 ? line : line.slice(0, i).replace(/\s+$/, '');
  });
}
// AskUserQuestion footer phrases that survive width-collapsing into a single blob.
const AQU_FOOTER_A = /enter to select/;
const AQU_FOOTER_B = /to navigate/;
const AQU_FOOTER_C = /esc to\s+cancel/;
// A checkbox marker at the START of an option label, e.g. "[ ] Label" or "[x] Label".
// Matches the bracket content: space = unchecked; x/✓/✗ = checked.
const CHECKBOX_RE = /^\[([✓x✗ ])\]\s*(.*)/;
// The footer a real Claude Code SELECTION prompt renders under the options.
// Deterministically EXCLUDES "esc to interrupt" — that is the working-state
// footer (Claude is generating), not a prompt. A numbered list in assistant
// prose shown while Claude works would otherwise false-positive as a prompt.
// Real selection prompts say "esc to cancel / reject / keep".
const ESC_HINT_RE = /\besc\b[^\n]*(cancel|reject|keep)/i;
// How many lines from the bottom to consider. The active prompt always renders
// at the bottom of the pane; the cursor/Esc-footer guard (not this window) is
// what rejects assistant prose, so this can be generous. It must be large
// enough to contain a tall AskUserQuestion (long question + 5 options each with
// a multi-line description + footer) — otherwise the question + first options
// scroll out and the header heuristic grabs an option-description fragment.
const BOTTOM_REGION = 80;
const MAX_LABEL = 80;

// Stable phrases that mark a GENUINE Claude system prompt (permission / trust /
// plan-review) — as opposed to a custom numbered picker an agent or skill draws
// itself, or a prose question the assistant typed. Only system prompts should
// pop the question component via the pane scrape; AskUserQuestion flows through
// the structured transcript path instead. Conservative by design: an
// unrecognized picker is treated as NOT a system prompt and suppressed.
const SYSTEM_PROMPT_RE =
  /don'?t ask again|tell claude what to do differently|keep planning|auto-?accept edits|manually approve edits|do you want to proceed|would you like to proceed|do you trust|yes,?\s*proceed|no,?\s*exit/i;

/**
 * Is this parsed prompt a recognized Claude system prompt (permission / trust /
 * plan-review)? Matches the question text + option labels against stable system
 * phrasings. Returns false for custom agent/skill pickers and prose questions.
 *
 * @param {{question?:string, options?:{label:string}[]}|null} prompt
 * @returns {boolean}
 */
export function isSystemPrompt(prompt) {
  if (!prompt) return false;
  const text = [prompt.question || '', ...(prompt.options || []).map((o) => o.label)].join(' \n ');
  return SYSTEM_PROMPT_RE.test(text);
}

/**
 * Parse a Claude Code numbered selection prompt out of a pane capture.
 *
 * Strict by design: an interactive prompt is accepted ONLY when the numbered
 * block carries a real TUI signal — the ❯ cursor on an option, or an "Esc to
 * cancel / ctrl+… " footer right below it. This rejects the common false
 * positive where the assistant writes a numbered plan/list in its prose (no
 * cursor, no Esc footer), which must NOT pop an approval modal.
 *
 * @param {string} capture  raw `capture-pane -p -e` text
 * @returns {{ question: string, options: {key:string,label:string,selected:boolean}[] }|null}
 */
export function parsePanePrompt(capture) {
  // stripFloatingBox removes Claude's right-hand preview panel (flattened into
  // the option lines by tmux) before any option matching, so a line like
  // "2. Continue B2–B5 as │ …tooltip… │" becomes just "2. Continue B2–B5 as".
  const all = stripFloatingBox(
    stripAnsi(capture).split('\n').map((l) => l.replace(/\s+$/, '')),
  );
  const offset = Math.max(0, all.length - BOTTOM_REGION);
  const lines = all.slice(offset);

  // Collect every numbered-option line in the bottom region. The AskUserQuestion
  // picker renders each option as a header line PLUS a wrapped description line,
  // so options are NOT contiguous — we must look past the description lines and
  // stitch together a 1,2,3… sequence by key, not by adjacency.
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) continue;
    let label = stripBoxGlyphs(m[3]);
    // Detect and strip a checkbox marker from the label.
    let checked = undefined;
    const cbMatch = CHECKBOX_RE.exec(label);
    if (cbMatch) {
      checked = cbMatch[1] !== ' '; // space = unchecked; x/✓/✗ = checked
      label = cbMatch[2].trim();
    }
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';
    matches.push({ line: i, key: m[2], label, cursor: m[1] === '❯' || m[1] === '›', checked });
  }
  if (matches.length < 2) return null;

  // Sort by numeric key before run-building. This is a no-op for single-column
  // pickers (already in ascending order) but is required for two-column bordered
  // pickers where normalizeBoxLines emits left-column and right-column cells
  // interleaved by document row (producing key order 1,3,2,4,… rather than 1,2,3,4).
  const sortedMatches = matches.slice().sort((a, b) => Number(a.key) - Number(b.key));

  // Group into runs of consecutive ascending keys (1,2,3… OR 3,4,5… — the menu's
  // first options can scroll off the top of the capture, so we must NOT require
  // it to start at 1). Description lines between options don't break a run since
  // we key off the NUMBERS, not line adjacency. Pick the bottom-most run — the
  // active picker always renders at the bottom of the pane.
  const runs = [];
  let cur = [];
  for (const m of sortedMatches) {
    const prevKey = cur.length ? Number(cur[cur.length - 1].key) : null;
    if (prevKey !== null && Number(m.key) === prevKey + 1) {
      cur.push(m);
    } else if (prevKey !== null && Number(m.key) === prevKey) {
      // duplicate key (re-render artifact) — ignore
    } else {
      if (cur.length) runs.push(cur);
      cur = [m];
    }
  }
  if (cur.length) runs.push(cur);
  const options = [...runs].reverse().find((r) => r.length >= 2);
  // Need ≥2 consecutively-numbered options to look like a menu.
  if (!options) return null;

  // firstLine: line index of the first option in the chosen run (by key, which
  // may not be the minimum line index after sorting, so use the minimum .line).
  const firstLine = Math.min(...options.map((o) => o.line));
  // lastLine: the maximum line index of options in the chosen run. For a two-column
  // picker the last key's option may appear before other keys in document order,
  // so take the maximum rather than options[last].line.
  const lastLine = Math.max(...options.map((o) => o.line));
  const hasCursor = options.some((o) => o.cursor);

  // "Esc to cancel / ctrl+e" footer within a few lines below the last option.
  let hasEsc = false;
  for (let i = lastLine + 1; i <= Math.min(lines.length - 1, lastLine + 3); i++) {
    if (ESC_HINT_RE.test(lines[i])) {
      hasEsc = true;
      break;
    }
  }

  // Require a genuine interactive-prompt signal — not just numbered prose.
  if (!hasCursor && !hasEsc) return null;

  // Question = the contiguous block above the option run. Only trust it when the
  // run starts at key 1 — i.e. the WHOLE picker is in view. If it starts higher
  // (1/2 scrolled off despite the large window), the lines above the first
  // visible option are a prior option's wrapped DESCRIPTION, not the question, so
  // we emit no header rather than a misleading fragment.
  let question = null;
  if (Number(options[0].key) === 1) {
    let i = firstLine - 1;
    while (i >= 0 && !lines[i].trim()) i--; // skip the blank separator(s)
    const qLines = [];
    for (; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) break; // stop at the blank above the question block
      if (OPTION_RE.test(lines[i])) break; // don't bleed into a prior option
      qLines.unshift(t);
    }
    question = stripBoxGlyphs(qLines.join(' ')).slice(0, 400) || null;
  }

  // Each option may carry a wrapped DESCRIPTION — the indented sub-text the TUI
  // renders under the label (e.g. "Tear down the proxy/gateway…"). It lives on
  // the contiguous non-blank lines between this option's line and the next
  // option's line (or the footer), so capture those so the cockpit shows the
  // same context the TUI does instead of just the bare label.
  const descFor = (idx) => {
    const start = options[idx].line + 1;
    const end = idx + 1 < options.length ? options[idx + 1].line : lines.length;
    const out = [];
    for (let i = start; i < end; i++) {
      const t = lines[i].trim();
      if (!t || OPTION_RE.test(lines[i]) || ESC_HINT_RE.test(lines[i])) break;
      out.push(stripBoxGlyphs(t));
    }
    const desc = out.filter(Boolean).join(' ').slice(0, 300);
    return desc || undefined;
  };

  const hasCheckboxes = options.some((o) => o.checked !== undefined);
  return {
    question: question || 'Make a selection',
    ...(hasCheckboxes ? { multiSelect: true } : {}),
    options: options.map((o, idx) => {
      const description = descFor(idx);
      return {
        key: o.key,
        label: o.label,
        selected: o.cursor,
        ...(description ? { description } : {}),
        ...(o.checked !== undefined ? { checked: o.checked } : {}),
      };
    }),
  };
}

/**
 * Width-robust option reconstruction from a slice of stripped pane lines.
 *
 * Uses the tolerant OPTION_START_RE (dot/paren after number is optional),
 * marker-based continuation classification, checkbox stripping, and MAX_LABEL
 * clamping — the same logic detectPanePicker needs for option-start detection.
 * Factored out so parsePicker (lib/answer.js) can reuse the same primitive
 * instead of maintaining a parallel, narrower implementation.
 *
 * MARKER-BASED RULE: a line begins a NEW option iff OPTION_START_RE matches.
 * Every other non-blank, non-footer, non-box-separator continuation line is
 * part of the current option's `description`. The `label` is ONLY the title
 * text on the marker line (after stripping the number and optional checkbox).
 *
 * ACCEPTED TRADE-OFF: On an ultra-narrow pane where a TITLE itself word-wraps,
 * the wrapped tail becomes `description` rather than rejoining the label.
 * Acceptable: titles are short by design, the option stays selectable, and both
 * label+description render. The answer-side matcher (lib/answer.js planStep)
 * compensates by matching the structured label against label+description
 * (see labelMatches helper in answer.js).
 *
 * @param {string[]} lines  Stripped, trailing-whitespace-trimmed lines (bottom region).
 * @returns {{ line: number, key: string, label: string, description?: string, cursor: boolean, checked?: boolean }[]}
 *   Logical index of each option within the returned array is stored in `.line`.
 *   `description` is set when continuation lines are found below the marker line.
 */
export function reconstructOptionLines(lines) {
  const matches = []; // { line, key, label, description?, cursor, checked? }
  let i = 0;
  while (i < lines.length) {
    const m = OPTION_START_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const cursor = m[1] === '❯' || m[1] === '›';
    const key = m[2];
    let label = m[3].trim();

    const descParts = [];

    // Append continuation lines until next option, footer, separator, or blank-before-footer.
    // Marker-based rule: every surviving continuation line is description.
    let j = i + 1;
    while (j < lines.length) {
      const nextLine = lines[j];
      // Stop at next option start
      if (OPTION_START_RE.test(nextLine)) break;
      // Stop at footer (ESC_HINT_RE or AQU footer keywords)
      if (ESC_HINT_RE.test(nextLine)) break;
      if (/enter to select|to navigate|esc to\s+cancel/i.test(nextLine)) break;
      // Stop at action/chat standalone lines — these are separate navigable rows, not
      // continuation text, even when they appear indented below an option.
      if (/^\s*(Next|Submit|Chat about this)$/i.test(nextLine)) break;
      // Stop at box-drawing separator (skip it, don't append)
      if (nextLine.trim() && BOX_SEP_RE.test(nextLine)) { j++; break; }
      // Stop at blank line (could be blank before footer)
      if (!nextLine.trim()) break;
      // Every surviving continuation line is description (marker-based rule).
      descParts.push(nextLine.trim());
      j++;
    }
    i = j;

    // Detect and strip checkbox marker.
    let checked = undefined;
    const cbMatch = CHECKBOX_RE.exec(label);
    if (cbMatch) {
      checked = cbMatch[1] !== ' ';
      label = cbMatch[2].trim();
    }

    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';

    // Build description from deeper-indented parts; strip leading box-drawing chars defensively.
    let description = descParts.join(' ').replace(/\s+/g, ' ').trim();
    description = description.replace(/^[─━—–=_\s]+/, '').trim();
    if (description.length > 300) description = description.slice(0, 299) + '…';
    description = description || undefined;

    matches.push({ line: matches.length, key, label, cursor, checked, description });
  }
  return matches;
}

/**
 * Width-robust pane picker detector. Handles hard-wrapped AskUserQuestion pickers
 * on narrow tmux splits (~22 cols) where the footer and option labels wrap mid-line.
 *
 * Unlike parsePanePrompt (which requires footer on a single line and options as
 * "N. label"), this function works on a whitespace-collapsed blob for footer
 * detection and does tolerant line reconstruction for options (dot/paren after
 * number is optional; continuation lines are appended).
 *
 * Supersedes the isSystemPrompt gate — surfaces ALL picker types (AskUserQuestion,
 * permission, trust, plan-review, custom agent menus), so the cockpit shows the
 * question component for every picker, not just system prompts.
 *
 * FALSE-POSITIVE GUARD (load-bearing): returns null when there is no footer
 * signature AND no ❯/› cursor. Plain numbered prose with neither signal is NOT
 * a picker.
 *
 * @param {string} capture  raw `capture-pane -p -e -J` text (joined lines)
 * @returns {{ question: string|undefined, multiSelect?: boolean, options: {key:string,label:string,description?:string,selected:boolean,checked?:boolean}[] }|null}
 */
export function detectPanePicker(capture) {
  const stripped = stripAnsi(capture);

  // ── PICKER-OPEN detection: footer signature, ANCHORED TO THE BOTTOM ─────────
  // An active picker ALWAYS renders its footer at the bottom of the live pane
  // ("Enter to select · ↑/↓ to navigate · Esc to cancel", or a permission
  // "Esc to cancel/reject/keep"). Matching only the bottom region (collapsed, so
  // a narrow pane's 3-line wrapped footer still joins) is what makes detection
  // DETERMINISTIC:
  //   • numbered PROSE above a normal composer input prompt has no footer → no FP;
  //   • a stale footer left in scrollback by an already-answered picker is above
  //     the bottom region → ignored;
  //   • a bare ❯ is NOT a signal (it is also the composer input prompt) — the
  //     previous `|| hasCursorGlyph` is what surfaced phantom questions.
  const FOOTER_REGION = 14; // lines from the LAST NON-BLANK row that hold an active footer
  // Trim trailing blank rows FIRST: a picker that doesn't fill the pane height
  // leaves empty rows below its footer (observed: ~16 blank lines after
  // "Enter to select…"), which would push the footer out of a fixed last-N-physical
  // window and make detection FLAP (shows, then a redraw with more blanks → null →
  // the question vanishes). Anchor to the last non-blank content instead.
  const physLines = stripped.split('\n');
  let lastContent = physLines.length;
  while (lastContent > 0 && !physLines[lastContent - 1].trim()) lastContent -= 1;
  const footerBlob = physLines
    .slice(0, lastContent)
    .slice(-FOOTER_REGION)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const hasAquFooter =
    AQU_FOOTER_A.test(footerBlob) && AQU_FOOTER_B.test(footerBlob) && AQU_FOOTER_C.test(footerBlob);
  // Permission/trust/plan footers — but NEVER the working-state footer
  // ("esc to interrupt"), which means Claude is generating, not prompting.
  const hasEscFooter =
    /\besc\b.{0,40}(cancel|reject|keep)/.test(footerBlob) && !/esc to interrupt/.test(footerBlob);

  const pickerOpen = hasAquFooter || hasEscFooter;
  if (!pickerOpen) return null;

  // ── OPTION RECONSTRUCTION tolerant of hard-wrapping ──────────────────────────
  const all = stripped.split('\n').map((l) => l.replace(/\s+$/, ''));
  const offset = Math.max(0, all.length - BOTTOM_REGION);
  const lines = all.slice(offset);

  const matches = reconstructOptionLines(lines);

  if (matches.length < 2) return null;

  // ── Group into runs of consecutive ascending keys; pick bottom-most with ≥2 ──
  const runs = [];
  let cur = [];
  for (const m of matches) {
    const prevKey = cur.length ? Number(cur[cur.length - 1].key) : null;
    if (prevKey !== null && Number(m.key) === prevKey + 1) {
      cur.push(m);
    } else if (prevKey !== null && Number(m.key) === prevKey) {
      // duplicate (re-render artifact) — skip
    } else {
      if (cur.length) runs.push(cur);
      cur = [m];
    }
  }
  if (cur.length) runs.push(cur);
  const chosen = [...runs].reverse().find((r) => r.length >= 2);
  if (!chosen) return null;

  // ── QUESTION: contiguous non-blank block above the first option of the run ───
  // Only emit when run starts at key 1 (whole picker in view).
  let question = undefined;
  if (Number(chosen[0].key) === 1) {
    // Walk back through lines to find the question block above options.
    // We need to reconstruct from the original lines, but `matches[].line` is
    // now a logical index into matches, not into lines[]. Re-scan lines[] directly.
    // Find the line index of the first option in the original lines array.
    let firstOptionLineIdx = -1;
    {
      let logicalIdx = 0;
      let li = 0;
      while (li < lines.length && logicalIdx <= chosen[0].line) {
        if (OPTION_START_RE.test(lines[li])) {
          if (logicalIdx === chosen[0].line) { firstOptionLineIdx = li; break; }
          logicalIdx++;
        }
        li++;
      }
    }
    if (firstOptionLineIdx > 0) {
      let qi = firstOptionLineIdx - 1;
      while (qi >= 0 && !lines[qi].trim()) qi--; // skip blank separator(s)
      const qLines = [];
      for (; qi >= 0; qi--) {
        const t = lines[qi].trim();
        if (!t) break;
        if (OPTION_START_RE.test(lines[qi])) break;
        // Skip box-drawing separators
        if (BOX_SEP_RE.test(lines[qi])) continue;
        qLines.unshift(t);
      }
      const q = qLines.join(' ').slice(0, 400).trim();
      question = q || 'Make a selection';
    } else {
      question = 'Make a selection';
    }
  }

  const hasCheckboxes = chosen.some((o) => o.checked !== undefined);
  return {
    ...(question !== undefined ? { question } : {}),
    ...(hasCheckboxes ? { multiSelect: true } : {}),
    options: chosen.map((o) => ({
      key: o.key,
      label: o.label,
      selected: o.cursor,
      ...(o.checked !== undefined ? { checked: o.checked } : {}),
      ...(o.description ? { description: o.description } : {}),
    })),
  };
}
