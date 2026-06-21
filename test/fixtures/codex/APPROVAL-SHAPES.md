# Codex Approval-Prompt TUI Shapes — Phase 0a capture findings

Codex CLI `v0.131.0-alpha.4`. Captured live via tmux `capture-pane` (the only
way to see these — they are TUI-only, absent from rollout JSONL).

## Common pattern (all modals)

```
  <heading line(s)>
  [optional body / command / diff]
› 1. <label> (<key>)
  2. <label> (<key>)
  3. <label> (<key>)
  <footer hint: "Press enter to confirm or esc to cancel">
```

- `›` (U+203A) marks the **highlighted** option; lines without it are unselected.
- Options are `N. <label> (<shortcut>)`. Answerable three ways: number key,
  the parenthetical shortcut char, or arrow-keys + Enter.
- Enter confirms the highlighted option; Esc cancels (usually == the "No" option).
- This is a **stable, anchorable numbered-select surface** → parseable. Gate PASSED.

## Shape 1 — directory trust (session start)

```
> You are in /private/tmp/codex-spike
  Do you trust the contents of this directory? ...
› 1. Yes, continue
  2. No, quit
  Press enter to continue
```
Note: options here have NO parenthetical shortcut; footer is "Press enter to continue".

## Shape 2 — command-exec approval

```
  Would you like to run the following command?
  $ printf 'hi\n' > hello.txt && cat hello.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `printf 'hi\n' > hello.txt && cat hello.txt` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
```
- Heading: literal "Would you like to run the following command?"
- Command echoed after `$ ` (may be multi-line — note embedded newline in printf).
- Resolved state (post-approval) renders as: `✔ You approved codex to run <cmd> this time`
- Option 2 label is dynamic (echoes the command prefix) — parser must not anchor on its text, only on the `N. ... (key)` structure.

## Shape 3 — apply_patch / file-edit approval

```
• Edited hello.txt (+1 -1)
    1 -hi
    1 +hello
  Would you like to make the following edits?
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
```
- Heading: literal "Would you like to make the following edits?"
- Body is a mini-diff: `• Edited <file> (+N -M)` then `<lineno> -<old>` / `<lineno> +<new>`.
- Same numbered-select structure; option 2 shortcut here is `(a)` ("don't ask again for these files").

## CONCLUSION — gate PASSED

All three modals (trust / exec / edit) share ONE structure. A parser anchoring on:
1. a heading question line,
2. contiguous `^\s*[›\s]\s*\d+\.\s+.+?(?:\s+\(\w+\))?$` option lines (`›` = highlighted),
3. a footer hint (`Press enter to …`),
handles every variant. Answer by: number key, the `(key)` shortcut, or arrows+Enter.
The approval surface is stable and anchorable → the load-bearing feasibility risk is retired.

## JSONL side (resolved actions only — approvals are NOT in JSONL)

Rollout type/payload taxonomy (validated on a live spike session):

| top-level `type` | `payload.type` | meaning |
|---|---|---|
| `session_meta` | — | line 1; `payload.cwd`, `id`, `originator`, `cli_version`, `model_provider` |
| `turn_context` | — | per-turn `cwd`, `approval_policy`, `sandbox_policy`, `permission_profile`, `current_date`, `timezone` |
| `response_item` | `message` | user/assistant message item |
| `response_item` | `reasoning` | **encrypted**: `encrypted_content` set, `summary: []`, `content: null` → render placeholder |
| `response_item` | `function_call` | `name: "exec_command"`, `arguments` = JSON string `{cmd, workdir, sandbox_permissions, justification, ...}`, `call_id` |
| `response_item` | `function_call_output` | `{call_id, output}` — match to call by `call_id`; output is a text blob (`Process exited with code N`, `Output:\n…`) |
| `response_item` | `custom_tool_call` | `name: "apply_patch"`, `input`, `status`, `call_id` |
| `response_item` | `custom_tool_call_output` | apply_patch result |
| `event_msg` | `user_message` | `{message, images, local_images, text_elements}` (`local_images` = attachment paths) |
| `event_msg` | `agent_message` | `{message, phase, memory_citation}` |
| `event_msg` | `patch_apply_end` | patch applied event |
| `event_msg` | `task_started` / `task_complete` | turn boundaries |
| `event_msg` | `token_count` | usage |

KEY ARCHITECTURAL FACT: the interactive approval gate ("Would you like to run…") never
appears in JSONL — only the proposed `function_call` and (post-approval) its
`function_call_output`. Therefore **pending-approval detection = capture-pane**; resolved
history = JSONL. This is exactly the seam the plan drew.
