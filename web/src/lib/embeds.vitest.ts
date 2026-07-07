import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { parseEmbedAttrs, embedNodesFromHtml, remarkEmbeds } from './embeds';
import { MarkdownImg } from '../components/EmbeddedMedia';

// Render markdown through the same plugin + img override MarkdownText uses.
// Static markup: effects never run, so relative-path embeds show their
// loading placeholder — enough to assert kind/size/url made it into elements.
function render(md: string): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, {
      remarkPlugins: [remarkEmbeds],
      components: { img: MarkdownImg },
      children: md,
    }),
  );
}

describe('parseEmbedAttrs', () => {
  it('parses url + size', () => {
    expect(parseEmbedAttrs(' url="shot.png" size="lg" ')).toEqual({
      url: 'shot.png',
      size: 'lg',
    });
  });
  it('defaults a missing or unknown size to md', () => {
    expect(parseEmbedAttrs(' url="shot.png" ')?.size).toBe('md');
    expect(parseEmbedAttrs(' url="shot.png" size="huge" ')?.size).toBe('md');
  });
  it('returns null without a url', () => {
    expect(parseEmbedAttrs(' size="lg" ')).toBeNull();
  });
});

describe('embedNodesFromHtml (tag parsing → node props)', () => {
  it('turns a tag into an image node carrying data-embed/data-size/data-url', () => {
    const nodes = embedNodesFromHtml('<embedded-video url="runs/demo.mp4" size="full" />');
    expect(nodes).toHaveLength(1);
    expect(nodes![0]).toMatchObject({
      type: 'image',
      url: 'runs/demo.mp4',
      data: {
        hProperties: { dataEmbed: 'video', dataSize: 'full', dataUrl: 'runs/demo.mp4' },
      },
    });
  });
  it('keeps text around tags and returns null when no tag is present', () => {
    const nodes = embedNodesFromHtml('before <embedded-image url="a.png" /> after');
    expect(nodes!.map((n) => n.type)).toEqual(['text', 'image', 'text']);
    expect(embedNodesFromHtml('<b>plain html</b>')).toBeNull();
  });
});

describe('markdown pipeline → element props', () => {
  it('renders an http image embed as a real <img> at the mapped width', () => {
    const html = render('Before\n\n<embedded-image url="https://example.com/s.png" size="lg" />\n\nAfter');
    expect(html).toContain('<p>Before</p>');
    expect(html).toContain('<p>After</p>');
    expect(html).toContain('src="https://example.com/s.png"');
    expect(html).toContain('class="embed-media"');
    expect(html).toContain('width:640px'); // lg
    expect(html).not.toContain('embedded-image'); // tag never leaks as text
  });

  it('renders a relative video embed as a loading placeholder at md width', () => {
    const html = render('<embedded-video url="runs/demo.webm" />');
    expect(html).toContain('embed-media-loading');
    expect(html).toContain('width:420px'); // default md
  });

  it('rejects file:// urls without emitting any media element', () => {
    const html = render('<embedded-image url="file:///etc/passwd" size="full" />');
    expect(html).toContain('media url rejected');
    expect(html).not.toContain('<img');
  });

  it('leaves regular markdown images untouched', () => {
    const html = render('![alt](https://example.com/plain.png)');
    expect(html).toContain('src="https://example.com/plain.png"');
    expect(html).not.toContain('embed-media');
  });

  it('leaves non-embed inline html escaped as before', () => {
    const html = render('a <b>bold?</b> b');
    expect(html).toContain('&lt;b&gt;');
  });
});
