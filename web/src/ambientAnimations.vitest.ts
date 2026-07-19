import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Perf regression guard: the ambient/decorative animation loops (cosmos
// backdrop + composer/pill conic ring) were retired because they kept the
// compositor — and, in the WKWebView desktop shell, the host process's CA
// layer-commit path — busy 100% of the time at idle (measured as a
// continuous double-digit %CPU burn). Decorative layers must stay static;
// motion is reserved for bounded transitions and transient STATE indicators
// (spinners, status pulses, streaming shimmers), which stop when their state
// ends. If one of these names reappears as an animation, that contract broke.
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

  it('cosmos backdrop layers declare no animation at all', () => {
    // Every `animation:` inside a rule whose selector mentions cosmos-.
    // Cheap structural scan: pair each top-level selector block with its body.
    const cosmosAnimated = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, sel, body]) => sel.includes('cosmos-') && /animation\s*:/.test(body),
    );
    expect(cosmosAnimated.map(([, sel]) => sel.trim())).toEqual([]);
  });
});
