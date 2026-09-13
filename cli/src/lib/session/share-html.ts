/**
 * Wrap an already-rendered session transcript in ONE self-contained HTML page for
 * `agents sessions share`.
 *
 * Takes the Markdown document as an argument rather than producing it, so the
 * decisions that make a transcript safe to publish — redaction, synthetic-turn
 * filtering, tool-output truncation, reasoning visibility — stay in
 * `renderSessionMarkdownDocument()` and the HTML path can never drift from the
 * Markdown one. That also keeps this a pure presentation function with no import
 * back into the command layer.
 *
 * Self-contained on purpose: an inline <style>, no external assets, no CDN, no
 * dependency on the artifacts-cli host CLI (which is not configured on every box,
 * RUSH-2728). The page is uploaded verbatim to the share Worker.
 *
 * Terminal-coded per the agents-cli brand (#0a0a0a bg, #a3e635 lime accent,
 * JetBrains Mono), with a light theme under `prefers-color-scheme: light` and an
 * in-page toggle so a published link is readable in bright light and dim alike.
 */
import { marked, Renderer } from 'marked';
import type { SessionMeta } from './types.js';

interface SessionHtmlOptions {
  /** Whether the Markdown was rendered with redaction on — shown in the footer. */
  redacted?: boolean;
}

/** One metadata chip in the page header. */
interface Chip {
  label: string;
  value: string;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A transcript is untrusted text: it carries whatever the model wrote and whatever
 * a tool printed. marked passes raw HTML through by default, so a session that
 * merely *discussed* a `<script>` tag would ship an executable one on a public URL.
 * Escaping the html token's raw source neutralizes that without mangling the
 * visible text, and non-http(s) link schemes are dropped so `javascript:` cannot
 * ride in through a Markdown link.
 */
/**
 * The only raw HTML the transcript renderer itself emits: `--reasoning fold` wraps
 * each thinking block in a disclosure element (`session/render.ts` — the `fold`
 * branch pushes `<details>\n<summary>Reasoning</summary>` and `</details>`).
 *
 * Escaping those along with everything else published `&lt;details&gt;` as visible
 * text and no collapsing, so `--reasoning fold` shipped broken. They are allowed
 * back through by EXACT match on the token's raw source, not by parsing tags:
 * attribute-free `details`/`summary` carry no script, no URL, and no event handler,
 * and an exact-string gate cannot be widened by crafted input the way a tag parser
 * can. Anything else — including `<details onclick=…>` — still escapes.
 */
/**
 * Sentinel standing in for one folded reasoning block while the document goes
 * through marked. Deliberately not valid Markdown or HTML, and any pre-existing
 * occurrence in the transcript is neutralized before substitution.
 */
const FOLD_SENTINEL = 'aGeNtSfOlDbLoCk';
// The neutralization below is only sound because this literal is BORDER-FREE: its
// first character occurs nowhere else in it, so no occurrence can overlap another
// and splitting on it cannot leave a fresh one behind. A bordered literal (`aba`
// splits into a leftover `a` + `ba`) is defeatable. Keep that property if you
// ever change the string.

/** The exact block `session/render.ts` pushes on its `fold` branch. */
const FOLD_BLOCK = /<details>\n<summary>Reasoning<\/summary>\n\n([\s\S]*?)\n\n<\/details>/g;

/**
 * Lift every folded reasoning block out of the Markdown, leaving a sentinel.
 *
 * `renderer.html` escapes raw HTML unconditionally — the transcript body is model
 * and tool output, so nothing in it may round-trip as markup. That also escaped
 * the `<details>` wrapper `--reasoning fold` emits, which is why the disclosure
 * element has to be reconstructed here instead of allowlisted through.
 *
 * Allowlisting was tried twice and is the wrong shape: marked hands the same
 * markup over as several different raw strings depending on context (a whole-token
 * gate passed the opening tag and escaped the closing one in a real document), and
 * a bare `<details>` in ordinary prose is a complete INLINE html token — so prose
 * that merely mentions the tag would emit a live, unclosed element that swallows
 * every later turn into it. Reconstructing both ends here makes the pairing
 * structural: it cannot be unbalanced by anything the transcript contains.
 */
function liftFoldBlocks(markdown: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  // A transcript that literally contains the sentinel must not be able to forge a
  // disclosure element, so break any occurrence before inserting our own.
  const safe = markdown.split(FOLD_SENTINEL).join(`${FOLD_SENTINEL[0]}​${FOLD_SENTINEL.slice(1)}`);
  const text = safe.replace(FOLD_BLOCK, (_match, inner: string) => {
    blocks.push(inner);
    return `${FOLD_SENTINEL}${blocks.length - 1}${FOLD_SENTINEL}`;
  });
  return { text, blocks };
}

function safeRenderer(): Renderer {
  const renderer = new Renderer();
  renderer.html = ({ raw }) => escapeHtml(raw);
  const isSafeHref = (href: string): boolean => /^(https?:|mailto:|#|\/)/i.test(href.trim());
  renderer.link = ({ href, title, tokens }) => {
    const text = renderer.parser.parseInline(tokens);
    if (!isSafeHref(href)) return text;
    const attrs = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(href)}"${attrs} rel="noopener noreferrer nofollow">${text}</a>`;
  };
  renderer.image = ({ href, title, text }) => {
    if (!isSafeHref(href)) return escapeHtml(text);
    const attrs = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${attrs} loading="lazy" />`;
  };
  return renderer;
}

/** Human duration — "13 minutes", never "12m 49s". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The chips shown under the title.
 *
 * Deliberately excludes `account` (an email — the publish-time sensitive-content
 * scan rejects those, and correctly), `cwd`, and `machine`: a published transcript
 * should not carry the operator's identity or local paths in its chrome. Host and
 * repo already ride in the share object's provenance metadata, which is the right
 * home for them.
 */
export function buildChips(session: SessionMeta): Chip[] {
  const chips: Chip[] = [{ label: 'agent', value: session.agent }];
  if (session.model) chips.push({ label: 'model', value: session.model });
  if (session.mode) chips.push({ label: 'mode', value: session.mode });
  if (session.project) chips.push({ label: 'project', value: session.project });
  if (session.gitBranch) chips.push({ label: 'branch', value: session.gitBranch });
  if (session.ticketId) chips.push({ label: 'ticket', value: session.ticketId });
  const date = (session.timestamp || '').slice(0, 10);
  if (date) chips.push({ label: 'date', value: date });
  if (session.durationMs) chips.push({ label: 'duration', value: formatDuration(session.durationMs) });
  if (session.messageCount) chips.push({ label: 'turns', value: String(session.messageCount) });
  if (session.toolCallCount) chips.push({ label: 'tools', value: String(session.toolCallCount) });
  return chips;
}

/** Longest title that stays one readable line in the header and the gallery. */
const TITLE_MAX = 90;

/**
 * The page's `<title>` — `deriveLabel()` reads this as the share's gallery label.
 *
 * The document heading is derived from the session's first prompt, which in a real
 * session is routinely a pasted URL plus a file path plus the actual request. Left
 * whole it renders as a three-line wall above the transcript and an unreadable
 * gallery row, so it is collapsed to one line and cut at a word boundary. `--label`
 * overrides it outright.
 */
export function sessionPageTitle(session: SessionMeta, markdown: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.replace(/\s+/g, ' ').trim();
  if (!heading) return `${session.agent} session ${session.shortId || session.id}`;
  if (heading.length <= TITLE_MAX) return heading;
  const cut = heading.slice(0, TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // A single unbroken token longer than the cap (a URL) has no boundary to cut on;
  // a hard slice beats returning the whole thing.
  return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function renderSessionHtmlDocument(
  session: SessionMeta,
  markdown: string,
  options: SessionHtmlOptions = {},
): string {
  const title = sessionPageTitle(session, markdown);
  // The <h1> is re-rendered as the page header, so drop it from the body to
  // avoid printing the title twice.
  const { text, blocks } = liftFoldBlocks(markdown.replace(/^#\s+.+\n/, ''));
  const render = (md: string): string =>
    marked.parse(md, { renderer: safeRenderer(), async: false }) as string;
  // Reconstruct each disclosure element around its own separately-rendered
  // content, so the open/close pairing is ours and cannot be unbalanced by the
  // transcript.
  const body = blocks.reduce(
    (html, inner, i) => html.replace(
      new RegExp(`<p>${FOLD_SENTINEL}${i}${FOLD_SENTINEL}</p>`),
      // A FUNCTION replacement, never a string one. String.replace expands `$&`,
      // `` $` ``, `$'` and `$n` inside a string replacement, and marked turns
      // `& < > " '` into entities — so reasoning text containing `$'` (bash
      // ANSI-C quoting), `$&` (sed), or `$<` (make) would splice the matched
      // sentinel back into the page and destroy the character after it. A
      // function's return value is inserted verbatim.
      () => `<details><summary>Reasoning</summary>\n${render(inner)}</details>`,
    ),
    render(text),
  );
  const chips = buildChips(session)
    .map((c) => `<span class="chip"><span class="k">${escapeHtml(c.label)}</span>${escapeHtml(c.value)}</span>`)
    .join('\n      ');
  const redacted = options.redacted !== false;

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #0a0a0a; --panel: #121212; --border: #262626; --fg: #e5e5e5;
    --dim: #737373; --accent: #a3e635; --quote: #1a1a1a;
  }
  html[data-theme="light"] {
    --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
    --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
  }
  @media (prefers-color-scheme: light) {
    html[data-theme="auto"] {
      --bg: #fafafa; --panel: #ffffff; --border: #e5e5e5; --fg: #171717;
      --dim: #737373; --accent: #4d7c0f; --quote: #f5f5f5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
    font-size: 15px; line-height: 1.65;
  }
  header {
    border-bottom: 1px solid var(--border); padding: 28px 20px 20px;
  }
  header .inner, main { max-width: 900px; margin: 0 auto; }
  header .mark {
    color: var(--accent); font-weight: 700; letter-spacing: .5px; font-size: 12px;
    text-transform: uppercase; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  header h1 { font-size: 24px; line-height: 1.3; margin: 10px 0 14px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 11px;
    color: var(--fg); background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 2px 9px;
  }
  .chip .k { color: var(--dim); margin-right: 6px; }
  .toggle {
    float: right; cursor: pointer; background: none; border: 1px solid var(--border);
    color: var(--dim); border-radius: 6px; padding: 2px 8px; font-size: 14px;
  }
  main { padding: 24px 20px 64px; }
  h2 {
    font-size: 13px; color: var(--accent); border-bottom: 1px solid var(--border);
    padding-bottom: 6px; margin: 36px 0 14px; text-transform: uppercase;
    letter-spacing: 1px; font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  h3 { font-size: 15px; margin: 26px 0 8px; }
  h4 { font-size: 13px; color: var(--dim); margin: 20px 0 6px; font-weight: 600; }
  a { color: var(--accent); }
  blockquote {
    margin: 0 0 20px; padding: 12px 16px; background: var(--quote);
    border-left: 2px solid var(--border); border-radius: 0 6px 6px 0; color: var(--dim);
  }
  blockquote p { margin: 0 0 6px; }
  blockquote p:last-child { margin: 0; }
  pre {
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 14px; overflow-x: auto;
  }
  code {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace; font-size: 12.5px;
  }
  :not(pre) > code {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 5px;
  }
  hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
  details { margin: 0 0 12px; }
  summary { cursor: pointer; color: var(--dim); font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
  footer {
    max-width: 900px; margin: 0 auto; padding: 0 20px 48px;
    color: var(--dim); font-size: 12px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }
  footer a { color: var(--dim); }
</style>
</head>
<body>
<header>
  <div class="inner">
    <button class="toggle" id="theme" title="Toggle light and dark">&#9689;</button>
    <div class="mark">agents session</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="chips">
      ${chips}
    </div>
  </div>
</header>
<main>
${body}
</main>
<footer>
  ${redacted ? 'Secret-redacted transcript' : 'Unredacted transcript'} rendered by
  <a href="https://agents-cli.sh">agents-cli</a> &middot; <code>agents sessions share</code>
</footer>
<script>
  (function () {
    var root = document.documentElement;
    var saved = null;
    try { saved = localStorage.getItem('agents-share-theme'); } catch (e) {}
    if (saved) root.setAttribute('data-theme', saved);
    document.getElementById('theme').addEventListener('click', function () {
      var dark = getComputedStyle(root).getPropertyValue('--bg').trim() === '#0a0a0a';
      var next = dark ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('agents-share-theme', next); } catch (e) {}
    });
  })();
</script>
</body>
</html>
`;
}
