/**
 * `<Markdown>` — stateless renderer tests via renderToString (bun tier).
 *
 * Pins the PR #18d.2 plan §3 decisions: GFM features render, links open
 * safely, embedded HTML stays escaped.
 */
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';

import { Markdown } from '../src/components/markdown';

function render(text: string): string {
  return renderToString(<Markdown text={text} />);
}

describe('Markdown', () => {
  test('renders the data-test marker and paragraphs', () => {
    const html = render('first paragraph\n\nsecond paragraph');
    expect(html).toContain('data-test="markdown"');
    expect(html).toContain('first paragraph');
    expect(html).toContain('second paragraph');
    expect(html.match(/<p[\s>]/g)?.length).toBe(2);
  });

  test('renders heading levels', () => {
    const html = render('# Title\n\n## Section\n\n### Sub');
    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('Title');
  });

  test('renders GFM tables', () => {
    const html = render('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
  });

  test('renders GFM strikethrough', () => {
    const html = render('~~gone~~');
    expect(html).toContain('<del>');
  });

  test('renders fenced code blocks as pre > code', () => {
    const html = render('```ts\nconst x = 1;\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('font-mono');
  });

  test('renders inline code', () => {
    const html = render('use `bun test` here');
    expect(html).toContain('<code');
    expect(html).toContain('bun test');
  });

  test('links open in a new tab with safe rel', () => {
    const html = render('[docs](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com"');
  });

  test('embedded HTML stays escaped — never becomes DOM', () => {
    const html = render('before <script>alert(1)</script> after');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('unordered and ordered lists', () => {
    const html = render('- one\n- two\n\n1. first\n2. second');
    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html.match(/<li[\s>]/g)?.length).toBe(4);
  });
});
