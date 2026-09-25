---
feature: artifacts-system
phase: a
tier: feature
autonomous: true
complexity-budget: { files: 7, loc-delta: 700 }
adopted-patterns: [prototype-component run.mjs --write-app, esbuild single-file inlined HTML, react-markdown, media-apps versioned convention]
---

# Phase A — /create-artifact skill (markdown / html / react-dataviz → publish → embed)

> **Scope**: A new GLOBAL skill `~/.claude/skills/create-artifact/` (sibling to prototype-component) that turns a request into a beautifully-rendered, inline-embeddable presentation artifact — Markdown docs, HTML micro-sites, interactive React data-viz/dashboards — published on the existing media-app plumbing WITHOUT the studio cc-bridge. Outside-repo work (global skill + shared producer); no repo branch.
> **Design**: docs/design/artifacts-system.md
> **Branch**: n/a (global skill dir; not repo-tracked — same as prototype-component D5)

## Status
| state | tasks |
|---|---|
| todo | (none) |
| done | A1, A2, A3, A4, A5 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-13. Feature tier. B2: 3-phase feature→epic signal noted but defining epic markers (regression matrix/rollback/multi-service/cross-service dep) ABSENT → feature stands (OQ4 deliberate). B7: phase branches non-main but standalone (not stacked) → acknowledged, re-target not needed. B6 elided: Audit-item-coverage kept (rubric populated). New dependency (charting lib, A4) will trip execute Halt-N — name + approve at execute time. -->

## Task list

### A1 — Scaffold the create-artifact skill
> **Goal**: `~/.claude/skills/create-artifact/SKILL.md` exists with invocation shapes + the 3-lane overview (markdown/html/react) + the publish→embed contract, framed as the presentation sibling to prototype-component (a prototype is one artifactKind).
> **Files**: ~/.claude/skills/create-artifact/SKILL.md
> **Acceptance**: SKILL.md present; describes the 3 lanes, `--type markdown|html|react` hint, publish via run.mjs --write-app --artifact-kind, and emitting `<embedded-app url="apps/<name>.html">`.
> **Verification**: test -f ~/.claude/skills/create-artifact/SKILL.md && grep -qiE 'markdown|html|react' ~/.claude/skills/create-artifact/SKILL.md && grep -q artifactKind ~/.claude/skills/create-artifact/SKILL.md
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — Producer: artifactKind + no-cc-bridge publish mode
> **Goal**: extend the shared producer (`prototype-component/scripts/run.mjs` --write-app + `manifest.mjs`) to accept `--artifact-kind <prototype|markdown|html|react>`, write it into the manifest schema, and SKIP cc-bridge injection for non-prototype kinds (presentation artifacts ship no props).
> **Files**: ~/.claude/skills/prototype-component/scripts/run.mjs, ~/.claude/skills/prototype-component/scripts/manifest.mjs
> **Acceptance**: `run.mjs --write-app <name> --html <f> --artifact-kind html` publishes a versioned app whose manifest carries `artifactKind:"html"` and whose HTML has NO cc-bridge runtime; `--artifact-kind prototype` (or absent) keeps today's behavior byte-for-byte.
> **Verification**: run --write-app on a fixture with --artifact-kind html; assert manifest JSON has artifactKind and the html lacks the bridge marker; re-run without the flag → unchanged.
> **Depends on**: none
> **Reversibility**: clean-revert

### A3 — Markdown lane + shared artifact theme
> **Goal**: a build lane that renders a Markdown doc → a beautifully-styled, self-contained HTML page (reuse `react-markdown` or a build-time renderer) using a shared "artifact theme" (tokens/typography/color/code) so all kinds look intentional; publish via A2 with artifactKind=markdown.
> **Files**: ~/.claude/skills/create-artifact/scripts/build-markdown.mjs, ~/.claude/skills/create-artifact/scripts/artifact-theme.css
> **Acceptance**: `/create-artifact` a markdown doc → a styled self-contained HTML artifact that renders inline via `<embedded-app>`; typography/code blocks look polished (design-quality).
> **Verification**: build a sample MD → HTML; publish; curl the served artifact; read a screenshot of the rendered page and confirm styling.
> **Depends on**: A1, A2
> **Reversibility**: clean-revert

### A4 — HTML + React data-viz lanes
> **Goal**: two lanes — (html) author + inline all assets into a self-contained page; (react) esbuild single-file inlined build (counter/palette harness MINUS the cc-bridge) for interactive data-viz/dashboards, with a LIGHTWEIGHT charting approach; both publish via A2. Charting library = the one new dependency (Halt-N: name + approve).
> **Files**: ~/.claude/skills/create-artifact/scripts/build-html.mjs, ~/.claude/skills/create-artifact/scripts/build-react.mjs
> **Acceptance**: `/create-artifact` a data chart/dashboard → a beautiful interactive HTML artifact that renders + interacts inline; an HTML micro-site likewise; both self-contained (no external fetch, sandbox-safe).
> **Verification**: build a sample chart artifact + a sample html page; publish; render-check (interactive + inline); assert self-contained (no external URLs) + emitted-size logged (P1).
> **Depends on**: A1, A2
> **Reversibility**: clean-revert

### A5 — E2E dogfood + CLAUDE.md pointer update
> **Goal**: produce one artifact of EACH kind (markdown/html/react), publish + emit `<embedded-app>` tags, confirm all render inline live; update the global `~/.claude/CLAUDE.md` "Inline media & component prototypes" pointer to mention `/create-artifact` (artifacts wording).
> **Files**: ~/.claude/CLAUDE.md, (media-root fixtures under ~/.claude-control/media/apps/)
> **Acceptance**: 3 live-embeddable artifacts (md/html/react); CLAUDE.md pointer names `/create-artifact` + the artifact kinds; `/api/media-apps/<name>/versions` shows each with `artifactKind`.
> **Verification**: curl each published artifact (200); versions endpoint shows artifactKind; CLAUDE.md grep for create-artifact.
> **Depends on**: A1, A2, A3, A4
> **Reversibility**: clean-revert

## Audit item coverage
| Task | Rubric |
|---|---|
| A2 | S2, S3 |
| A3 | S3 |
| A4 | T1, P1 |
| A5 | P1 |

## Dependencies between tasks
A1, A2 independent (parallel). A3 → (A1, A2). A4 → (A1, A2). A5 → (A1, A2, A3, A4).

## Review sign-off checklist
- [ ] Presentation artifacts are self-contained + sandbox-safe (no allow-same-origin, no external fetch) — T1
- [ ] `--artifact-kind prototype`/absent keeps prototype-component behavior byte-for-byte — S2
- [ ] Emitted artifact HTML size logged; lightweight charting preferred — P1
- [ ] PR/records target the right surface (global skill = no repo PR; note the run.mjs change rides the skill dir)
