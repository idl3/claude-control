import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  isDeliveryPayload,
  safeParseDeliveryPayload,
  extraDeliveryFields,
  parsePrUrl,
  formatPrLabel,
  outcomeBadge,
  findDeliveryPayload,
  remarkDelivery,
  type DeliveryPayload,
} from './delivery';
import { remarkEmbeds } from './embeds';
import { MarkdownDiv } from '../components/DeliveryCard';
import { MarkdownImg } from '../components/EmbeddedMedia';

const EXAMPLE: DeliveryPayload = {
  type: 'delivery',
  outcome: 'pushed_pr',
  branch: 'linear/atl-9661',
  prUrl: 'https://github.com/atlas-kitchen/restaurant-web/pull/2946',
};
const EXAMPLE_JSON = JSON.stringify(EXAMPLE);

describe('isDeliveryPayload', () => {
  it('accepts a well-shaped delivery payload', () => {
    expect(isDeliveryPayload(EXAMPLE)).toBe(true);
  });
  it('accepts a minimal payload (only type + outcome)', () => {
    expect(isDeliveryPayload({ type: 'delivery', outcome: 'no_changes' })).toBe(true);
  });
  it('rejects the wrong type', () => {
    expect(isDeliveryPayload({ type: 'other', outcome: 'pushed_pr' })).toBe(false);
  });
  it('rejects a missing or empty outcome', () => {
    expect(isDeliveryPayload({ type: 'delivery' })).toBe(false);
    expect(isDeliveryPayload({ type: 'delivery', outcome: '' })).toBe(false);
  });
  it('rejects a non-string branch/prUrl', () => {
    expect(isDeliveryPayload({ type: 'delivery', outcome: 'pushed_pr', branch: 1 })).toBe(false);
    expect(isDeliveryPayload({ type: 'delivery', outcome: 'pushed_pr', prUrl: [] })).toBe(false);
  });
  it('rejects non-objects, null, and arrays', () => {
    expect(isDeliveryPayload(null)).toBe(false);
    expect(isDeliveryPayload('delivery')).toBe(false);
    expect(isDeliveryPayload([1, 2])).toBe(false);
  });
});

describe('safeParseDeliveryPayload', () => {
  it('parses valid delivery JSON', () => {
    expect(safeParseDeliveryPayload(EXAMPLE_JSON)).toEqual(EXAMPLE);
  });
  it('returns null for malformed JSON', () => {
    expect(safeParseDeliveryPayload('{not json')).toBeNull();
  });
  it('returns null for well-formed JSON that is not delivery-shaped', () => {
    expect(safeParseDeliveryPayload('{"type":"note","outcome":"pushed_pr"}')).toBeNull();
    expect(safeParseDeliveryPayload('{"a":1,"b":2}')).toBeNull();
  });
});

describe('extraDeliveryFields', () => {
  it('excludes the known keys and keeps the rest', () => {
    const payload = { ...EXAMPLE, filesChanged: 3, notes: 'looks good' };
    expect(extraDeliveryFields(payload)).toEqual([
      ['filesChanged', 3],
      ['notes', 'looks good'],
    ]);
  });
  it('is empty for a payload with only known keys', () => {
    expect(extraDeliveryFields(EXAMPLE)).toEqual([]);
  });
});

describe('parsePrUrl / formatPrLabel', () => {
  it('parses owner/repo/number from a github PR url', () => {
    expect(parsePrUrl(EXAMPLE.prUrl!)).toEqual({
      owner: 'atlas-kitchen',
      repo: 'restaurant-web',
      number: '2946',
    });
  });
  it('formats the label as owner/repo #number', () => {
    const parsed = parsePrUrl(EXAMPLE.prUrl!)!;
    expect(formatPrLabel(parsed)).toBe('atlas-kitchen/restaurant-web #2946');
  });
  it('tolerates a trailing slash or fragment', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/12/')).toEqual({ owner: 'o', repo: 'r', number: '12' });
    expect(parsePrUrl('https://github.com/o/r/pull/12#discussion_r1')).toEqual({
      owner: 'o',
      repo: 'r',
      number: '12',
    });
  });
  it('returns null for a non-PR or non-github url', () => {
    expect(parsePrUrl('https://github.com/o/r/issues/12')).toBeNull();
    expect(parsePrUrl('https://gitlab.com/o/r/pull/12')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });
});

describe('outcomeBadge', () => {
  it('maps known outcomes to labeled, toned badges', () => {
    expect(outcomeBadge('pushed_pr')).toEqual({ label: '✓ Pushed PR', tone: 'success' });
    expect(outcomeBadge('no_changes')).toEqual({ label: 'No changes', tone: 'neutral' });
    expect(outcomeBadge('failed')).toEqual({ label: '✗ Failed', tone: 'danger' });
    expect(outcomeBadge('error')).toEqual({ label: '✗ Error', tone: 'danger' });
  });
  it('falls back to a neutral badge showing the raw value for unknown outcomes', () => {
    expect(outcomeBadge('mystery_outcome')).toEqual({ label: 'mystery_outcome', tone: 'neutral' });
  });
});

describe('findDeliveryPayload', () => {
  it('matches when the payload is the whole (trimmed) text', () => {
    const match = findDeliveryPayload(EXAMPLE_JSON);
    expect(match?.payload).toEqual(EXAMPLE);
    expect(match?.start).toBe(0);
    expect(match?.end).toBe(EXAMPLE_JSON.length);
  });
  it('matches an inline blob surrounded by prose, reporting real spans', () => {
    const text = `Delivered: ${EXAMPLE_JSON} — done.`;
    const match = findDeliveryPayload(text);
    expect(match?.payload).toEqual(EXAMPLE);
    expect(text.slice(0, match!.start)).toBe('Delivered: ');
    expect(text.slice(match!.end)).toBe(' — done.');
  });
  it('ignores braces inside JSON string values when balancing', () => {
    const payload = { type: 'delivery', outcome: 'pushed_pr', notes: 'contains { and } chars' };
    const json = JSON.stringify(payload);
    expect(findDeliveryPayload(json)?.payload).toEqual(payload);
  });
  it('skips a balanced object that is not delivery-shaped and keeps scanning', () => {
    const text = `{"a":1} then ${EXAMPLE_JSON}`;
    expect(findDeliveryPayload(text)?.payload).toEqual(EXAMPLE);
  });
  it('returns null when there is no delivery-shaped object at all', () => {
    expect(findDeliveryPayload('just some prose')).toBeNull();
    expect(findDeliveryPayload('{"a":1}')).toBeNull();
  });
  it('returns null for an unbalanced/truncated object', () => {
    expect(findDeliveryPayload('{"type":"delivery","outcome":"pushed_pr"')).toBeNull();
  });
});

// Render markdown through the exact plugin + component combination
// MarkdownText.tsx wires up in production (remarkGfm, remarkDelivery,
// remarkEmbeds; div → MarkdownDiv, img → MarkdownImg).
function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkDelivery, remarkEmbeds],
      components: { div: MarkdownDiv, img: MarkdownImg },
      children: md,
    }),
  );
}

describe('remarkDelivery integration (via ReactMarkdown)', () => {
  it('control: remark-gfm alone mangles the PR url (proves the bug this fixes)', () => {
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], children: EXAMPLE_JSON }),
    );
    // The trailing `"}` gets swallowed into the autolinked href.
    expect(html).toContain('href="https://github.com/atlas-kitchen/restaurant-web/pull/2946%22%7D"');
  });

  it('renders the exact dispatch payload as a clean card with an unmangled link', () => {
    const html = render(EXAMPLE_JSON);
    expect(html).toContain('delivery-card');
    expect(html).toContain('delivery-badge-success');
    expect(html).toContain('✓ Pushed PR');
    expect(html).toContain('linear/atl-9661');
    expect(html).toContain('href="https://github.com/atlas-kitchen/restaurant-web/pull/2946"');
    expect(html).toContain('atlas-kitchen/restaurant-web #2946');
    // No raw JSON leaked into the output, and no mangled href fragment.
    expect(html).not.toContain('"type":"delivery"');
    expect(html).not.toContain('%22%7D');
  });

  it('renders a fenced ```json delivery block as a card', () => {
    const md = '```json\n' + EXAMPLE_JSON + '\n```';
    const html = render(md);
    expect(html).toContain('delivery-card');
    expect(html).toContain('href="https://github.com/atlas-kitchen/restaurant-web/pull/2946"');
    expect(html).not.toContain('<pre');
  });

  it('renders an inline delivery blob mixed with prose as text + card + text', () => {
    const html = render(`Delivery result: ${EXAMPLE_JSON} — see above.`);
    expect(html).toContain('Delivery result:');
    expect(html).toContain('delivery-card');
    expect(html).toContain('see above.');
    expect(html).not.toContain('"type":"delivery"');
  });

  it('leaves non-delivery JSON as ordinary text (shape guard)', () => {
    const html = render('{"hello":"world"}');
    expect(html).not.toContain('delivery-card');
    expect(html).toContain('hello');
  });

  it('leaves a non-delivery fenced code block as a normal code block (shape guard)', () => {
    const html = render('```json\n{"hello":"world"}\n```');
    expect(html).not.toContain('delivery-card');
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
  });

  it('shows extra fields and handles a missing prUrl/branch without crashing', () => {
    const html = render('{"type":"delivery","outcome":"no_changes","filesChanged":0}');
    expect(html).toContain('delivery-card');
    expect(html).toContain('No changes');
    expect(html).toContain('filesChanged');
    expect(html).not.toContain('<a ');
  });

  it('shows a neutral badge with the raw outcome for an unknown outcome', () => {
    const html = render('{"type":"delivery","outcome":"partially_pushed"}');
    expect(html).toContain('delivery-badge-neutral');
    expect(html).toContain('partially_pushed');
  });
});
