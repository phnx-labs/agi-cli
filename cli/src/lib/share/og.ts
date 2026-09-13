/**
 * Open Graph / Twitter card meta for a shared HTML page.
 *
 * `deriveMeta` pulls a title + description out of the document (its `<title>`/`<h1>`
 * and first real paragraph or existing `<meta name=description>`); `injectOgMeta`
 * splices the social tags into `<head>` (idempotent — it strips any tags we
 * previously added before re-inserting). Pure string work so it's unit-testable
 * without a browser or network.
 */

const OG_MARK_OPEN = '<!-- agents-share:og -->';
const OG_MARK_CLOSE = '<!-- /agents-share:og -->';

interface OgFields {
  title: string;
  description: string;
  imageUrl: string;
  pageUrl: string;
  /** Actual pixel dimensions of the served image (defaults to the 1200×630 OG card). */
  imageWidth?: number;
  imageHeight?: number;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pull a sensible title + description out of a plan/document's HTML. */
export function deriveMeta(html: string, fallbackTitle = 'agents-cli'): { title: string; description: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const title = stripTags(titleMatch?.[1] ?? h1Match?.[1] ?? '') || fallbackTitle;

  let description = '';
  const metaDesc = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html);
  if (metaDesc) {
    description = metaDesc[1].trim();
  } else {
    for (const m of html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const t = stripTags(m[1]);
      if (t.length > 40) {
        description = t;
        break;
      }
    }
  }
  if (description.length > 198) description = description.slice(0, 197).trimEnd() + '…';
  return { title, description };
}

/** Remove a previously-injected block so re-publishing doesn't stack duplicate tags. */
function stripPrevious(html: string): string {
  const re = new RegExp(`${OG_MARK_OPEN}[\\s\\S]*?${OG_MARK_CLOSE}\\n?`, 'g');
  return html.replace(re, '');
}

/** Splice OG + Twitter tags into `<head>` (or prepend if there's no head). Idempotent. */
export function injectOgMeta(html: string, f: OgFields): string {
  const cleaned = stripPrevious(html);
  const t = escapeAttr(f.title);
  const d = escapeAttr(f.description);
  const w = f.imageWidth ?? 1200;
  const h = f.imageHeight ?? 630;
  const block =
    `${OG_MARK_OPEN}\n` +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:site_name" content="agents-cli">\n` +
    `<meta property="og:title" content="${t}">\n` +
    `<meta property="og:description" content="${d}">\n` +
    `<meta property="og:url" content="${escapeAttr(f.pageUrl)}">\n` +
    `<meta property="og:image" content="${escapeAttr(f.imageUrl)}">\n` +
    `<meta property="og:image:width" content="${w}">\n` +
    `<meta property="og:image:height" content="${h}">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n` +
    `<meta name="twitter:title" content="${t}">\n` +
    `<meta name="twitter:description" content="${d}">\n` +
    `<meta name="twitter:image" content="${escapeAttr(f.imageUrl)}">\n` +
    `${OG_MARK_CLOSE}\n`;

  const headClose = cleaned.search(/<\/head>/i);
  if (headClose !== -1) return cleaned.slice(0, headClose) + block + cleaned.slice(headClose);
  const headOpen = /<head[^>]*>/i.exec(cleaned);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return cleaned.slice(0, at) + '\n' + block + cleaned.slice(at);
  }
  return block + cleaned;
}
