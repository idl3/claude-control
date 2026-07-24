# @idl3/agent-ui-kit

Headless agent-interaction UI renderers, maintained in
[idl3/claude-control](https://github.com/idl3/claude-control) (the source of
truth) and published as a versioned package to **GitHub Packages** so external
hosts — currently the olam `@olam/plan-chat-spa` — consume the exact same
renderers cockpit ships, upgraded deliberately by version pin.

**The boundary is hard:** components take data + callbacks via props and are
themed via CSS custom properties. No data fetching, no auth, no tenancy, no
runtime dependencies (`react` is a peer). Each host supplies its own adapter.

## Components

### `AskQuestionForm`

The structured AskUserQuestion renderer: option lists, multi-select,
split-preview layout (mobile-first; two columns ≥760px), keyboard navigation,
and the free-text ("Type something" / "Chat about this") flow.

```tsx
import { AskQuestionForm, type AskAnswer } from '@idl3/agent-ui-kit';
import '@idl3/agent-ui-kit/styles.css';

<AskQuestionForm
  questions={[{ question: 'Deploy target?', options: [{ label: 'Staging' }, { label: 'Prod' }] }]}
  onSubmit={(answers: AskAnswer[]) => submit(answers)}
/>;
```

| Prop | Type | Notes |
|---|---|---|
| `questions` | `AskQuestion[]` | One entry per question: `question`, `header?`, `multiSelect?`, `options[{label, description?, preview?}]`. |
| `onSubmit` | `(answers: AskAnswer[]) => void` | One entry per question — `string[]` of chosen labels, or a `{kind:'text'\|'chat', text}` free-text directive. |
| `onFreeTextReply?` | `(text) => void` | When set, free-text submits call this instead of `onSubmit` (for pendings with no structured picker behind them — claude-control's synthesized `__flag__` case). |
| `freeTextRows?` | `boolean` (default `true`) | Append the Claude-TUI-parity "Type something"/"Chat about this" rows. |
| `submitLabel?` | `string` (default `'Send Answer'`) | claude-control keeps the default; the olam SPA sets its own. |
| `flipContainerRef?` | `RefObject<HTMLElement>` | Height-FLIP target when the host owns the scroller; defaults to the kit root. |
| `className?` | `string` | Extra classes on the kit root (which always carries `agent-ui-kit`). |

Also exported: `questionHasPreview`, `isFreeTextOption`, `useHeightFlip`
(WAAPI height FLIP, reduced-motion gated), `prefersReducedMotion`, and the
`AskQuestion` / `AskOption` / `AskAnswer` types.

## Theming — the `--auk-*` contract

`styles.css` ships inside **`@layer agent-ui-kit`** with every rule scoped
under `:where(.agent-ui-kit)` (zero added specificity). Unlayered host CSS
beats layered CSS regardless of load order, so **any host rule overrides any
kit rule deterministically** — no import-order contract.

Theme by re-declaring tokens on `.agent-ui-kit` (defaults are a neutral dark
theme):

| Token | Used for | Token | Used for |
|---|---|---|---|
| `--auk-bg` | preview pane, selected row bg | `--auk-accent` | selection, primary button |
| `--auk-surface` | split rows, secondary button | `--auk-accent-contrast` | text on accent |
| `--auk-surface-hover` | hover surface | `--auk-accent-2` | headers, focused row, spinner |
| `--auk-option-bg` | option button bg | `--auk-focus-ring` | focus outline (defaults to accent) |
| `--auk-option-bg-hover` | option hover bg | `--auk-blur` | backdrop blur (glass hosts) |
| `--auk-option-bg-on` | selected option bg | `--auk-ease` | transition easing |
| `--auk-line` | borders | `--auk-radius`, `--auk-radius-sm` | radii |
| `--auk-text`, `--auk-text-dim`, `--auk-text-faint` | text ramp | `--auk-font-md/body/meta/mono-size/input` | type scale |

claude-control's mapping lives in `web/src/styles.css` (`.agent-ui-kit { --auk-text: var(--text); … }`).

**Tailwind v4 hosts:** Tailwind's own layers must outrank the kit where you
want utilities to win. Declare the order once, before both imports:

```css
@layer theme, base, agent-ui-kit, components, utilities;
```

(kit beats `base`/preflight resets; `components`/`utilities` beat the kit.)

## Consuming from pleri/olam (`@olam/plan-chat-spa`) — Phase C runbook

GitHub Packages **requires auth to install even public packages**, and
`@idl3` ≠ `pleri`, so olam's Actions `GITHUB_TOKEN` can never read it — a PAT
is structurally required.

1. **Token**: classic PAT from the `idl3` account with `read:packages` only
   (fine-grained PATs have limited Packages support). Set an expiration and a
   rotation reminder. ⚠️ Creating the `IDL3_PACKAGES_TOKEN` repo secret in
   pleri/olam is a **gated secrets-write** — operator confirmation required
   (G-003) before an execute agent creates or rotates it.
2. **Registry** — append to olam's root `.npmrc` (precedent: the `@pleri`
   lines already there):
   ```
   @idl3:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${IDL3_PACKAGES_TOKEN}
   ```
   npm ≥10 tolerates the var being unset until an `@idl3` dep must resolve.
3. **Pin** in `packages/plan-chat-spa/package.json`:
   `"@idl3/agent-ui-kit": "0.1.0"` (exact pin; upgrades are deliberate).
4. **CI env** — export `IDL3_PACKAGES_TOKEN` on every job that runs `npm ci`:
   `ci.yml` (7 steps: build, llm-judge, test, test-cli-sharded, playwright,
   audit, onboarding-smoke — `runner-boot-smoke` has no npm ci) plus
   `e2e-preview.yml`, `storybook.yml`, `source-mode-parity.yml`, `release.yml`.
5. **Operator machine** — the 3-org prod deploy is manual wrangler
   (`wrangler.<org>.toml` via olam:deploy / pleri-deploy-orgs), so the local
   env needs `IDL3_PACKAGES_TOKEN` too for the pre-deploy `npm ci` + build.
   `build-topo` needs no changes (external deps are invisible to it).
6. **Adapter** — map `@olam/question-inbox-core`'s `InboxQuestion[]` →
   `AskQuestion[]` (label/description straight across; keep `value` /
   `destructive` host-side in a label→option map), fold `AskAnswer[]` into
   `BatchAnswer` via `buildBatchAnswer`, and add the `--auk-*` mapping block
   against the SPA's `@theme` vars + the `@layer` order line above.
7. **Upgrade cadence** — operator-driven; when bumping the pin, read the kit
   changelog section of the release tag. Pre-1.0, minor versions may change
   props. (A Renovate rule scoped to `@idl3` with registry auth is a sensible
   follow-up if manual bumps prove forgettable.)

## Developing in this repo

`web/` consumes the kit via a `file:` link (`web/package.json` →
`file:../packages/agent-ui-kit`), so cockpit always runs the local source —
no publish loop. The link resolves through `dist/`, so:

```bash
cd packages/agent-ui-kit && npm run dev   # tsc --watch, pane 1
cd web && npm run dev                     # vite, pane 2
```

(CSS edits: `npm run build` copies `src/styles.css` → `dist/`.)
`web/vite.config.ts` sets `resolve.dedupe: ['react','react-dom']` — required,
because the symlinked kit's own `node_modules/react` (test devDep) would
otherwise double-load React.

## Publishing

Deliberate, tag-driven — never on merge:

```bash
# bump version in packages/agent-ui-kit/package.json first, then:
git tag agent-ui-kit-v0.1.0 && git push origin agent-ui-kit-v0.1.0
```

`.github/workflows/publish-agent-ui-kit.yml` verifies tag ↔ package.json
version, builds, tests, runs a pack-smoke (installs the actual tarball into a
bare project, node-ESM imports it, SSR-renders, resolves the styles export)
and publishes with the repo `GITHUB_TOKEN` — no extra secrets. A
`workflow_dispatch` run with `dry_run: true` (the default) rehearses
everything except the publish.
