// Lazy, locally-bundled syntax highlighting via highlight.js core.
//
// We register only a small common-language set (keeps the highlighter chunk
// small) and load the whole module lazily so the highlighter + its languages
// split into their own bundle, off the critical path. The dark theme CSS is
// bundled separately (see highlight-theme.css, imported once at app startup).
//
// highlight.js escapes the source text and emits ONLY <span class="hljs-*">
// wrappers around that escaped text — its output is safe to inject as HTML.
// We never feed user/transcript text to innerHTML except through hljs, and we
// fall back to React-escaped plain text when a language is unknown or the
// highlighter fails to load.

import type { HLJSApi } from 'highlight.js';

// Canonical language ids we support, plus common aliases mapped onto them.
// Anything not in this map renders as plain (escaped) text.
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  py: 'python',
  python: 'python',
  diff: 'diff',
  patch: 'diff',
  md: 'markdown',
  markdown: 'markdown',
  html: 'xml',
  xml: 'xml',
  css: 'css',
};

/** Map a fenced-code language tag onto a registered language, or null. */
export function resolveLanguage(language: string | undefined | null): string | null {
  if (!language) return null;
  return ALIASES[language.trim().toLowerCase()] ?? null;
}

// Memoized lazy import of the configured highlighter. The first call kicks off
// the dynamic import + language registration; subsequent calls reuse it.
let hljsPromise: Promise<HLJSApi> | null = null;

async function loadHljs(): Promise<HLJSApi> {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import('highlight.js/lib/core');
      const [ts, js, json, bash, python, diff, markdown, xml, css] =
        await Promise.all([
          import('highlight.js/lib/languages/typescript'),
          import('highlight.js/lib/languages/javascript'),
          import('highlight.js/lib/languages/json'),
          import('highlight.js/lib/languages/bash'),
          import('highlight.js/lib/languages/python'),
          import('highlight.js/lib/languages/diff'),
          import('highlight.js/lib/languages/markdown'),
          import('highlight.js/lib/languages/xml'),
          import('highlight.js/lib/languages/css'),
        ]);
      hljs.registerLanguage('typescript', ts.default);
      hljs.registerLanguage('javascript', js.default);
      hljs.registerLanguage('json', json.default);
      hljs.registerLanguage('bash', bash.default);
      hljs.registerLanguage('python', python.default);
      hljs.registerLanguage('diff', diff.default);
      hljs.registerLanguage('markdown', markdown.default);
      hljs.registerLanguage('xml', xml.default);
      hljs.registerLanguage('css', css.default);
      return hljs;
    })();
  }
  return hljsPromise;
}

/**
 * Highlight `code` for a resolved language, returning safe HTML (hljs-escaped).
 * Returns null when the language is unsupported or highlighting fails — callers
 * then render the raw (React-escaped) text instead.
 */
export async function highlightCode(
  language: string | undefined | null,
  code: string,
): Promise<string | null> {
  const lang = resolveLanguage(language);
  if (!lang) return null;
  try {
    const hljs = await loadHljs();
    const { value } = hljs.highlight(code, { language: lang, ignoreIllegals: true });
    return value;
  } catch {
    return null;
  }
}
