/**
 * Make an HTML page self-contained enough to view on share.getrush.ai.
 *
 * Chrome "Save as" (and some renderers) leave `file:///…html#section` TOC
 * links and sibling image paths. Those work on disk and 404 on the share
 * Worker, which only stores the one PUT body. Rewrite same-document file
 * anchors to `#section`, and inline local image files as data URIs.
 *
 * https citations, data: URIs already in the page, and missing files are
 * left alone. This is not a bundler — it only fixes what would otherwise
 * render as a broken page after a single-file publish.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Skip inlining a sibling that would bloat the page past a reasonable PUT. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/**
 * `href="file:///tmp/page.html#purpose"` → `href="#purpose"`.
 * Bare `file:///tmp/page.html` (no hash) becomes `href="#"`.
 */
export function rewriteFileAnchors(html: string): string {
  return html.replace(
    /\b(href\s*=\s*["'])file:\/\/[^"'#]*(#[^"']*)?(["'])/gi,
    (_m, attr: string, hash: string | undefined, quote: string) => `${attr}${hash ?? '#'}${quote}`,
  );
}

/**
 * Only a bare path or a `file:` URL can name a local asset; every other scheme
 * is left alone. A single-letter "scheme" is a Windows drive (`C:\\x.png`), not a URL.
 */
function isRemoteOrSpecial(url: string): boolean {
  if (url.startsWith('//') || url.startsWith('#')) return true;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1];
  return scheme !== undefined && scheme.length > 1 && scheme.toLowerCase() !== 'file';
}

function localImagePath(url: string, htmlDir: string): { path: string; mime: string } | null {
  if (!url || isRemoteOrSpecial(url)) return null;
  const withoutHash = url.split('#')[0] ?? url;
  let fsPath: string;
  if (withoutHash.startsWith('file:')) {
    try {
      fsPath = fileURLToPath(withoutHash);
    } catch {
      return null;
    }
  } else {
    fsPath = resolve(htmlDir, withoutHash);
  }
  if (!existsSync(fsPath)) return null;
  const mime = IMAGE_MIME[extname(fsPath).toLowerCase()];
  if (!mime) return null;
  return { path: fsPath, mime };
}

/** Replace local image src/href with a data URI when the file exists next to the page. */
export function inlineLocalAssets(html: string, htmlPath: string): string {
  const dir = dirname(htmlPath);
  return html.replace(/\b((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (full, pre: string, url: string, post: string) => {
    const local = localImagePath(url, dir);
    if (!local) return full;
    try {
      const buf = readFileSync(local.path);
      if (buf.length > MAX_INLINE_BYTES) return full;
      return `${pre}data:${local.mime};base64,${buf.toString('base64')}${post}`;
    } catch {
      return full;
    }
  });
}

export function prepareShareHtml(html: string, htmlPath: string): string {
  return inlineLocalAssets(rewriteFileAnchors(html), htmlPath);
}
