import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Perf regression guard: the old ambient/decorative animation loops (cosmos
// backdrop + composer/pill conic ring) were retired because they kept the
// compositor — and, in the WKWebView desktop shell, the host process's CA
// layer-commit path — busy 100% of the time at idle (measured as a
// continuous double-digit %CPU burn). Decorative layers stay static by
// default. CodeWhale's explicit bubble mode is the narrow exception: exactly
// three already-existing layers may animate transform only. No background
// repaint, filter, per-bubble DOM, or unscoped ambient loop is allowed.
const raw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
);
// Comments legitimately narrate the retired loops' history; only code counts.
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

describe('ambient animation ban', () => {
  it.each([
    'cosmos-nebula',
    'cosmos-drift',
    'cosmos-twinkle',
    'cosmos-aurora-1',
    'cosmos-aurora-2',
    'composer-ring-flow',
    'composer-ring-pulse',
  ])('retired ambient loop "%s" has no keyframes or animation use', (name) => {
    expect(css).not.toMatch(new RegExp(`@keyframes ${name}\\b`));
    // (?<![\w-]) so the still-registered --composer-ring-* custom properties
    // (parked static, read by gradients/calc) don't false-positive.
    expect(css).not.toMatch(new RegExp(`(?<![\\w-])${name}\\b`));
  });

  it('only CodeWhale-scoped bubble planes may declare cosmos animation', () => {
    // Every `animation:` inside a rule whose selector mentions cosmos-.
    // Cheap structural scan: pair each top-level selector block with its body.
    const cosmosAnimated = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, sel, body]) => sel.includes('cosmos-') && /animation\s*:/.test(body),
    );
    expect(cosmosAnimated.length).toBeGreaterThan(0);
    for (const [, selector] of cosmosAnimated) {
      expect(selector).toContain(".app[data-codewhale-mode='true']");
      expect(selector).toMatch(/\.cosmos-stars-(far|mid|near)/);
    }
  });

  it('CodeWhale bubble keyframes animate compositor transforms only', () => {
    const bubbleKeyframes = [...css.matchAll(
      /@keyframes\s+(codewhale-bubbles-(?:far|mid|near))\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g,
    )];
    expect(bubbleKeyframes.map(([, name]) => name).sort()).toEqual([
      'codewhale-bubbles-far',
      'codewhale-bubbles-mid',
      'codewhale-bubbles-near',
    ]);
    for (const [, , body] of bubbleKeyframes) {
      const declarations = [...body.matchAll(/\{([^{}]*)\}/g)]
        .flatMap(([, step]) => step.split(';'))
        .map((declaration) => declaration.trim())
        .filter(Boolean);
      expect(declarations.length).toBeGreaterThan(0);
      expect(declarations.every((declaration) => declaration.startsWith('transform:'))).toBe(true);
    }
  });
});
