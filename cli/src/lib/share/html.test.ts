import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineLocalAssets, prepareShareHtml, rewriteFileAnchors } from './html.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('rewriteFileAnchors', () => {
  it('turns a Chrome-saved TOC file:// link into an in-page hash', () => {
    const html = '<a href="file:///private/tmp/plan.html#purpose">Purpose</a>';
    expect(rewriteFileAnchors(html)).toBe('<a href="#purpose">Purpose</a>');
  });

  it('a file:// link with no hash becomes #', () => {
    expect(rewriteFileAnchors('<a href="file:///tmp/plan.html">x</a>')).toBe('<a href="#">x</a>');
  });

  it('leaves https citations and data URIs alone', () => {
    const html =
      '<a href="https://example.com/docs">docs</a><img src="data:image/png;base64,abc">';
    expect(rewriteFileAnchors(html)).toBe(html);
  });
});

describe('inlineLocalAssets', () => {
  it('inlines a sibling png so the published page does not 404 the image', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-html-'));
    const img = join(dir, 'hero.png');
    const page = join(dir, 'page.html');
    writeFileSync(img, PNG_1X1);
    writeFileSync(page, '<img src="hero.png">');
    const out = inlineLocalAssets('<img src="hero.png">', page);
    expect(out.startsWith('<img src="data:image/png;base64,')).toBe(true);
    expect(out).toContain(PNG_1X1.toString('base64'));
    expect(out).not.toContain('hero.png');
  });

  it('does not fetch or rewrite https image srcs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-html-'));
    const page = join(dir, 'page.html');
    const html = '<img src="https://cdn.example/hero.png">';
    expect(inlineLocalAssets(html, page)).toBe(html);
  });

  it('leaves any other scheme alone, not just the ones on a list (CodeQL js/incomplete-url-scheme-check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-html-'));
    const page = join(dir, 'page.html');
    for (const src of ['vbscript:x', 'javascript:x', 'blob:abc', 'agents:sess', 'mailto:a@b']) {
      const html = `<img src="${src}">`;
      expect(inlineLocalAssets(html, page)).toBe(html);
    }
  });

  it('leaves a missing relative src alone (no invented data URI)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-html-'));
    const page = join(dir, 'page.html');
    const html = '<img src="./gone.png">';
    expect(inlineLocalAssets(html, page)).toBe(html);
  });
});

describe('prepareShareHtml', () => {
  it('rewrites file:// TOC links and inlines local images in one pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'share-html-'));
    const img = join(dir, 'a.png');
    const page = join(dir, 'page.html');
    writeFileSync(img, PNG_1X1);
    const html =
      '<a href="file:///tmp/page.html#focus">Focus</a><img src="a.png">';
    const out = prepareShareHtml(html, page);
    expect(out).toContain('href="#focus"');
    expect(out).toContain('data:image/png;base64,');
    expect(out).not.toContain('file://');
    expect(out).not.toContain('src="a.png"');
  });
});
