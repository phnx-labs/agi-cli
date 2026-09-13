// The publish path for `agents artifacts share <file>` — an authed PUT to the Worker.
// Pure logic (slug, expiry) is exported for tests; the network call is behind a DI seam.
//
// For HTML publishes it also captures a 1200×630 cover (the page's own hero) and
// injects og:image / twitter:card meta, so the link unfurls into a preview card in
// Slack / iMessage / Twitter / Discord. The cover is best-effort: if no headless
// browser is available it's skipped and the plain link still publishes.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hostname as osHostname } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { readSession } from '../identity/client.js';
import { readShareConfig, type ShareConfig } from './config.js';
import { resolveGitHubUsername } from '../git.js';
import { resolveShareBackend, sanitizeShareNamespace, type ResolveShareBackendOpts, type ShareBackendKind } from './backend.js';
import { captureCover, OG_WIDTH, OG_HEIGHT, OG_SCALE } from './capture.js';
import { deriveMeta, injectOgMeta } from './og.js';
import { extractShareHttpError, formatShareHttpErrorDetail } from './http-error.js';
import {
  type ShareVisibility,
  PUBLISH_VISIBILITY_LEVELS as STORAGE_PUBLISH_VISIBILITY_LEVELS,
  EDITABLE_VISIBILITY_LEVELS,
  resolveVisibility,
} from '../storage/visibility.js';
import { injectAnalyticsBeacon } from './analytics.js';
import { prepareShareHtml } from './html.js';

/** The share upload result. `body`/`retryAfter` carry the server's error
 * response so a failed publish can surface WHY (the Worker returns
 * `{"error":"…"}` + a `Retry-After` on a 429); they are read only on `!ok`
 * paths, and only ever fed through the bounded {@link extractShareHttpError}. */
type PutResult = {
  ok: boolean;
  status: number;
  url?: string;
  /** Response body text, present on the `!ok` path so the error can be extracted. */
  body?: string;
  /** `Retry-After` header value, present on a 429. */
  retryAfter?: string;
};

export type PutFn = (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
) => Promise<PutResult>;

interface PublishEndpoint {
  baseUrl: string;
  token: string;
}

export interface PublishOptions {
  /** Internal resolved backend; publishFile sets this after authentication. */
  backendKind?: ShareBackendKind;
  slug?: string;
  /**
   * Auto-expire window. Relative (`30d`, `12h`), absolute (`2026-08-01`), or
   * `never` / `none` / `permanent` for no expiry. When omitted, publishes default
   * to {@link DEFAULT_SHARE_EXPIRE} so an accidental share decays instead of
   * living forever (RUSH-2443).
   */
  expire?: string;
  contentType?: string;
  /**
   * Server-enforced visibility (RUSH-3135). `public` (default) is listed in
   * the gallery; `unlisted` is a capability URL (GET still 200, X-Robots-Tag:
   * noindex, hidden from gallery/list — obscurity, NOT authentication);
   * `private` is token-gated (the Worker serves it only to a request carrying
   * the matching viewer key, else 404 — the real read-auth fix, PHNX-3654);
   * `me` requires a Phoenix session and is visible only to the signed-in owner;
   * `org` requires the same and is visible to members of the same Phoenix
   * organization.
   */
  visibility?: ShareVisibility;
  /**
   * Hide this page from the public `/<user>` gallery and `agents artifacts share list`
   * (metadata `visibility=unlisted`). The direct URL is still world-readable —
   * unlisted, not secret (RUSH-2443). Alias of `--visibility unlisted` /
   * `--private` on the CLI. Kept so `sessions share` and existing callers do
   * not break.
   */
  unlisted?: boolean;
  /**
   * Token-gate this page (`--protected` → `visibility=private`, PHNX-3654). The
   * CLI mints a random viewer token, the Worker stores only its SHA-256 hash,
   * and the published URL carries `?k=<token>`; a request without a matching
   * `?k=` / `Authorization: Bearer` gets a `404`. Unlike `unlisted` (obscurity),
   * this is enforced read-auth. Alias of `--visibility private`.
   */
  protected?: boolean;
  /**
   * Bypass the pre-publish sensitive-content scan (emails / credential-shaped
   * strings). Required when the page intentionally carries those patterns.
   */
  force?: boolean;
  /** Generate + attach an OG cover for HTML pages (default true). */
  cover?: boolean;
  /** Inject the Cloudflare Web Analytics beacon (default true for HTML). */
  analytics?: boolean;
  /** Override the analytics token from share config. */
  analyticsToken?: string;
  /** Override the GitHub username used for the URL namespace (BYO path). */
  githubUser?: string;
  /**
   * Override the managed public handle (PHNX-3547). Managed publishes normally
   * namespace under the email local-part; when that handle is taken — or a
   * vanity namespace is wanted — pass an alternate. Sanitized to
   * `[a-z0-9-]` (max 63 chars, matching the Worker); the Worker binds it with
   * the same first-writer claim as a derived handle. Ignored on BYO (use
   * `githubUser` there).
   */
  handle?: string;
  /** DI seam for tests — override the persisted share endpoint config. */
  config?: ShareConfig;
  /** DI seam for tests — override the keychain-backed write token. Selects BYO. */
  writeToken?: string;
  /** DI seam for tests — override `readSession()`. `null` means signed out. */
  session?: import('../identity/client.js').PhoenixSession | null;
  /**
   * Override the sharer's avatar URL stamped on the object (test seam). When
   * omitted it is derived from the signed-in email via {@link resolveShareAvatar};
   * an empty string suppresses the stamp (initials-only bar).
   */
  avatar?: string;
  /** Force the BYO Cloudflare path even when signed in. */
  byo?: boolean;
  /** DI seam for tests — override the real HTTP PUT. */
  uploader?: PutFn;
  /** DI seam for tests — override cover capture (returns a PNG buffer or null). */
  capturer?: (htmlPath: string) => Promise<Buffer | null>;
  /**
   * Human display title, shown instead of the slug in the gallery and
   * `agents artifacts share list`. When omitted, one is derived (HTML `<title>`,
   * else a Markdown frontmatter `title:`, else the filename) — a share always
   * carries a label, never a blocking prompt (see {@link deriveLabel}).
   */
  label?: string;
  /**
   * Structured metadata (`--meta key=value`, repeatable). Keys are validated by
   * {@link parseMetaEntries} — lowercase `[a-z0-9-]`, and may not collide with
   * {@link RESERVED_META_KEYS} (Worker-stamped owner/visibility/expires-at,
   * plus provenance the CLI sets automatically).
   */
  meta?: Record<string, string>;
  /**
   * Skip revision retention on this publish — overwrite an existing slug's
   * object in place with no `<slug>/rev-<ts>` backup of the version it replaces
   * (default: keep it; see docs/distribution.md).
   */
  noRevision?: boolean;
  /** DI seam for tests — override provenance auto-capture (agent/session/host/repo/date). */
  provenance?: ShareProvenance;
}

// The visibility model — type, level sets, and resolver — is the shared
// `lib/storage/visibility` module, so `agents artifacts share` and the future
// `sessions` sync surface stamp the SAME levels and default. Re-exported here so
// existing `lib/share/publish.js` importers keep their import path.
export { type ShareVisibility } from '../storage/visibility.js';

/** The visibility levels a publish `--visibility` may select — the Worker's own
 * set. `private` (token-gated, PHNX-3654) is settable only at publish time,
 * since it mints a viewer token the metadata-edit route can't carry, so it is
 * NOT in {@link SHARE_VISIBILITY_LEVELS} (the in-place `share visibility <level>`
 * set). */
export const PUBLISH_VISIBILITY_LEVELS = STORAGE_PUBLISH_VISIBILITY_LEVELS;

/** The visibility levels an ALREADY-published share may be re-scoped to in place
 * — the set `share visibility <target> <level>` and the inline owner control
 * accept. Excludes `private`: re-scoping to token-gated needs a fresh viewer
 * token, which only the publish path mints. */
export const SHARE_VISIBILITY_LEVELS = EDITABLE_VISIBILITY_LEVELS;

export interface PublishResult {
  url: string;
  /** URL-safe object name, explicit (`--slug`) or deterministically derived. */
  slug?: string;
  expiresAt?: string;
  coverUrl?: string;
  /** Server-enforced visibility stamped on the object. */
  visibility?: ShareVisibility;
  /** True when the page was published with `visibility=unlisted`. */
  unlisted?: boolean;
  /** The raw viewer token minted for a `private` (token-gated) publish, or
   * undefined for any other visibility. It rides in {@link url} as `?k=<token>`;
   * only its hash is stored server-side. Treat as a secret. */
  viewerToken?: string;
  /** The label stored with this share — explicit (`--label`) or derived. */
  label?: string;
  /** Whether `label` came from `--label` or was auto-derived. */
  labelSource?: 'explicit' | 'derived';
}

/**
 * `--protected` / `{ protected: true }` map to `private` (token-gated — it wins
 * over `--unlisted` when both are set, being the stronger control); `--unlisted`
 * maps to `unlisted`; `--visibility private|unlisted|me|org` passes through;
 * otherwise `visibility` (default public).
 */
export function resolveShareVisibility(
  opts: { visibility?: ShareVisibility; unlisted?: boolean; protected?: boolean } = {},
): ShareVisibility {
  // Delegates to the shared visibility resolver. The library fallback stays
  // `public` so a lib caller that hasn't opted into the managed `me` default
  // (e.g. `sessions share --public`, which expresses "public" as the absence of
  // --unlisted) is never silently flipped. The PRODUCT default (`me` on managed)
  // is applied by the `agents artifacts share` command surface, which knows the
  // resolved backend — see `commands/share.ts`.
  return resolveVisibility(opts);
}

/** The bytes of viewer-token entropy the `private` mode mints (128-bit; the
 * base64url form is ~22 URL-safe chars). Well past the 64-bit floor a guessable
 * capability URL would fall to. */
const VIEWER_TOKEN_BYTES = 16;

/** Mint a fresh random viewer token for a `private` (token-gated) publish. The
 * raw token rides ONLY in the returned URL's `?k=`; the Worker stores just its
 * SHA-256 hash, so the object metadata never carries the secret. */
function generateViewerToken(): string {
  return randomBytes(VIEWER_TOKEN_BYTES).toString('base64url');
}

/** SHA-256 hex of a viewer token — the form the Worker also computes and stores,
 * so a CLI-side preview of the stored hash matches. Exported for tests. */
export function hashViewerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A 64-bit random slug tail (16 lowercase hex chars) for a capability-URL
 * publish, so the slug can never be derived/guessed from the title (PHNX-3654).
 * `unlisted` leans on this for obscurity; `private` uses it as defense-in-depth
 * behind the viewer token. */
function randomSlugTail(): string {
  return randomBytes(8).toString('hex');
}

/**
 * The loud stderr warning printed on an `unlisted` / `--private` publish
 * (PHNX-3654): `unlisted` is obscurity, NOT read-authentication — anyone with
 * the URL can read it. Points the user at the real controls (`--protected`,
 * `--expire`, `me`/`org`). Lives here beside the visibility logic; `share.ts`
 * prints it so the lib layer stays free of `console.*`.
 */
export function unlistedNotPrivateWarning(): string {
  return (
    'unlisted is NOT private — anyone with the URL can read it (a capability link, ' +
    'hidden from the gallery and marked noindex, but not authenticated).\n' +
    '  For sensitive content use --protected (a token-gated link that returns 404 ' +
    'without the key), and/or --expire to bound the window; --visibility me|org ' +
    'gates on your Phoenix login.'
  );
}

export interface ShareProvenance {
  /** Harness/agent name (`AGENTS_AGENT_NAME`), when publishing from an agent run. */
  agent?: string;
  /** Session id (`AGENTS_SESSION_ID` / `AGENT_SESSION_ID`), when publishing from an agent run. */
  session?: string;
  /** The machine the publish ran from (`os.hostname()`) — always present. */
  host?: string;
  /** git repo name at publish time, absent outside a git checkout — never invented. */
  repo?: string;
  /** ISO date (`yyyy-mm-dd`) this publish happened, from the local clock. */
  date?: string;
}

/**
 * Reserved `customMetadata` keys a `--meta key=value` may not target (see
 * {@link parseMetaEntries}). Matches the Worker's `RESERVED_METADATA_KEYS`:
 * provenance the CLI sets automatically, plus `expires-at` / `visibility` /
 * `owner` which the Worker stamps itself.
 */
export const RESERVED_META_KEYS = [
  'expires-at',
  'published-at',
  'visibility',
  'viewer-token-hash',
  'owner',
  'org_domain',
  'agent',
  'session',
  'host',
  'repo',
  'date',
  'avatar',
  'label',
  'label-source',
  'og-title',
  'og-description',
  'og-generated',
  'og-source-etag',
] as const;

const META_KEY_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Auto-capture publish provenance from the exec env, git, and the local clock.
 * Every field is present only when the environment genuinely carries it — a
 * human running the command by hand outside a git repo yields `session`/`agent`/
 * `repo` all undefined, never an invented value. `host` is always present
 * (`os.hostname()` never fails to return something real about where the publish
 * ran, so it isn't "invented" in the same sense).
 */
export function resolveShareProvenance(
  opts: { env?: NodeJS.ProcessEnv; hostname?: string; dir?: string; now?: Date } = {},
): ShareProvenance {
  const env = opts.env ?? process.env;
  return {
    session: env.AGENTS_SESSION_ID || env.AGENT_SESSION_ID || undefined,
    agent: env.AGENTS_AGENT_NAME || undefined,
    host: opts.hostname ?? osHostname(),
    repo: gitRepoName(opts.dir ?? process.cwd()),
    date: (opts.now ?? new Date()).toISOString().slice(0, 10),
  };
}

/**
 * The sharer's avatar URL, stamped so the share bar can show a real profile
 * picture instead of only the initials circle. A hosted OAuth profile image
 * already known to identity (PhoenixSession.avatarUrl — captured at login and
 * refreshed from `/api/v1/auth/me`) wins outright; only when none exists do we
 * fall back to a Gravatar keyed on the SHA-256 of the signed-in user's
 * lowercased email (Gravatar resolves either MD5 or SHA-256), with `d=404` so
 * Gravatar returns 404 for a user who has none — the bar's `<img>` onerror
 * then falls back to the initials circle. Only the hash lands in public
 * metadata, never the raw email. Returns '' when signed out (BYO without a
 * Phoenix session), leaving the bar on the initials circle.
 *
 * `opts.session === null` means "explicitly signed out" (a test seam / BYO) and
 * yields ''; `undefined` reads the real persisted session.
 */
export function resolveShareAvatar(
  opts: { session?: import('../identity/client.js').PhoenixSession | null } = {},
): string {
  const session = opts.session !== undefined ? opts.session : readSession();
  const hosted = session?.avatarUrl?.trim();
  if (hosted && /^https:\/\//i.test(hosted)) return hosted;
  const email = session?.email?.trim().toLowerCase();
  if (!email) return '';
  const hash = createHash('sha256').update(email).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?d=404&s=52`;
}

/**
 * Parse repeated `--meta key=value` CLI args into a validated metadata record.
 * Keys are lowercase `[a-z0-9-]`, up to 64 characters, and may not collide with
 * {@link RESERVED_META_KEYS} (Worker-stamped owner/visibility/expires-at, plus
 * the provenance the CLI sets automatically, plus label/label-source) — throws
 * naming the offending pair on any violation.
 */
export function parseMetaEntries(pairs: string[]): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Bad --meta '${pair}'. Expected key=value.`);
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if ((RESERVED_META_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `--meta ${key}=… is reserved (Worker-stamped, or set automatically from your session/git) — pass a different key.`,
      );
    }
    if (!META_KEY_RE.test(key)) {
      throw new Error(
        `Bad --meta key '${key}'. Keys are lowercase letters, digits, and hyphens, up to 64 characters.`,
      );
    }
    meta[key] = value;
  }
  return meta;
}

/** S3's `x-amz-meta` convention caps user metadata around 2KB; R2 publishes no
 * hard limit of its own, so stay under that ceiling to keep a share portable to
 * an S3-compatible mirror. Checked over the FULL customMetadata payload
 * (provenance + label + --meta combined), since that's what actually gets
 * written to the object. */
const MAX_METADATA_BYTES = 2048;

/** Throws when the combined `customMetadata` payload would exceed {@link MAX_METADATA_BYTES}. */
export function assertMetadataSize(customMetadata: Record<string, string>): void {
  const bytes = Buffer.byteLength(JSON.stringify(customMetadata), 'utf8');
  if (bytes > MAX_METADATA_BYTES) {
    throw new Error(
      `Share metadata is ${bytes} bytes, over the ${MAX_METADATA_BYTES}-byte cap ` +
        `(provenance + --label + --meta combined). Trim your --meta values.`,
    );
  }
}

/**
 * Collapse a label to a single line before it goes into the `x-share-label`
 * header or public customMetadata. `<title>[^<]{1,200}</title>` matches
 * newlines (`[^<]` excludes only `<`), and `.trim()` only strips leading/
 * trailing whitespace, not embedded newlines — a multi-line `<title>` (or an
 * explicit `--label`/`--title` the caller typed with a literal newline) was
 * previously passed straight into `Headers.set()` unsanitized, which throws
 * an unhandled `TypeError: Invalid value` and crashes the publish outright.
 */
export function sanitizeLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Typographic characters that reach a header constantly — a curly quote from a
 * pasted prompt, an em dash from prose, the ellipsis a truncated title ends on —
 * each mapped to the ASCII form a reader loses nothing by seeing.
 */
const HEADER_TRANSLITERATIONS: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―]/g, '-'],
  [/…/g, '...'],
  [/[    ]/g, ' '],
  [/[•·]/g, '-'],
];

/**
 * Make a free-text value safe to put in an HTTP header.
 *
 * `fetch` encodes header values as a **ByteString**, so any code point above 255
 * throws `TypeError: Cannot convert argument to a ByteString` — an unhandled
 * crash with a stack trace, mid-publish, after the body has already been read.
 * Reproduced by publishing a session whose title ended in `…` (U+2026), and
 * reachable by any emoji, curly quote, accented name, or CJK text in a `--label`,
 * a `--meta` value, or a repo name.
 *
 * The transliterations above cover what actually shows up; anything else outside
 * latin1 is dropped, and a value that transliterates to nothing at all (a title
 * written entirely in a non-latin script) degrades to a marker rather than an
 * empty header. This value is the **latin1-safe floor** every Worker can read: a
 * pre-Unicode Worker only ever sees `x-share-<field>`, so it MUST stay folded.
 * Full Unicode rides ALONGSIDE it in a percent-encoded companion header
 * (`toPercentHeaderValue` / {@link needsUnicodeCompanion}), which a new Worker
 * opts into via `x-share-encoding: percent` and an old one ignores — so a
 * Japanese/emoji title renders in full on an updated Worker and still folds
 * gracefully everywhere else (PHNX-2786).
 */
export function toHeaderValue(text: string): string {
  let safe = text;
  for (const [pattern, replacement] of HEADER_TRANSLITERATIONS) safe = safe.replace(pattern, replacement);
  safe = safe.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/\s+/g, ' ').trim();
  // An input that was empty to begin with stays empty — `--meta note=` means an
  // empty note, not an unnamed one. The marker is only for a value that HAD
  // content and lost all of it to the latin1 fold.
  if (safe) return safe;
  return text.trim() ? '(unnamed)' : '';
}

/**
 * Whether text carries a code point above latin1 (U+00FF) — the meaningful
 * display content `fetch`'s ByteString cannot hold, which {@link toHeaderValue}
 * therefore transliterates or drops. This is the range worth carrying in the
 * percent-encoded companion: an em dash, a curly quote, an emoji, or any
 * CJK/Arabic/Hindi text. A plain accented latin1 name (`José`, é = U+00E9) is
 * NOT lossy and needs no companion.
 *
 * `toHeaderValue` ALSO strips C0/C1 control characters (below U+0020, and
 * U+007F–U+009F), which this deliberately does not flag: a raw ANSI/control
 * sequence is not display text and must not be reconstructed into a page's
 * rendered metadata, so it stays dropped on both the old and new Worker paths.
 */
export function needsUnicodeCompanion(text: string): boolean {
  return /[^\u0000-\u00ff]/.test(text);
}

/**
 * Percent-encode a single-line free-text value for the `x-share-<field>-u`
 * companion header. Whitespace is collapsed first (matching the folded value's
 * single-line shape), then `encodeURIComponent` makes it pure-ASCII and
 * header-safe. The Worker recovers the original with `decodeURIComponent`.
 */
export function toPercentHeaderValue(text: string): string {
  return encodeURIComponent(text.replace(/\s+/g, ' ').trim());
}

/**
 * Best-effort human title when `--label` is omitted: the HTML `<title>`, else a
 * Markdown frontmatter `title:`, else the filename. Always returns something —
 * a headless publish must never hang waiting on a prompt for one.
 */
export function deriveLabel(filePath: string, body: Buffer): string {
  const text = body.toString('utf8');
  const htmlTitle = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(text);
  if (htmlTitle?.[1]?.trim()) return sanitizeLabel(htmlTitle[1]);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (frontmatter) {
    const titleLine = /^title:\s*(.+)$/m.exec(frontmatter[1]);
    const cleaned = titleLine?.[1]?.trim().replace(/^["']|["']$/g, '').trim();
    if (cleaned) return sanitizeLabel(cleaned);
  }
  const base = basename(filePath).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return sanitizeLabel(base || basename(filePath));
}

/** Default auto-expire for unflagged publishes — accidental links decay (RUSH-2443). */
export const DEFAULT_SHARE_EXPIRE = '30d';

const UNIT_MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/** `30d` / `12h` / `2026-08-01` → an absolute ISO timestamp (or undefined). */
export function parseExpire(spec: string | undefined): string | undefined {
  if (!spec) return undefined;
  const rel = /^(\d+)\s*([smhdw])$/i.exec(spec.trim());
  if (rel) {
    return new Date(Date.now() + parseInt(rel[1], 10) * UNIT_MS[rel[2].toLowerCase()]).toISOString();
  }
  const d = new Date(spec);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  throw new Error(
    `Bad --expire '${spec}'. Use e.g. 30d, 12h, an absolute date like 2026-08-01, or 'never' for no expiry.`,
  );
}

/**
 * Resolve the publish expiry. Omitted → {@link DEFAULT_SHARE_EXPIRE}. Explicit
 * `never` / `none` / `permanent` → no expiry. Anything else → {@link parseExpire}.
 */
export function resolveExpire(spec: string | undefined): string | undefined {
  if (spec === undefined) return parseExpire(DEFAULT_SHARE_EXPIRE);
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === 'never' || trimmed === 'none' || trimmed === 'permanent') return undefined;
  return parseExpire(spec);
}

type SensitiveHitKind = 'email' | 'credential';

interface SensitiveHit {
  kind: SensitiveHitKind;
  /** Short redacted sample so the error names *what* was found without dumping it. */
  sample: string;
}

/** Email addresses — the RUSH-2428 incident page carried seven of these. */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Mask every email address in `text`, so a page can be published without tripping
 * {@link scanShareContent}.
 *
 * Lives here, beside the scanner, rather than in `lib/redact.ts`: it exists solely
 * to satisfy this gate, and sharing {@link EMAIL_RE} is what makes the masking
 * *sufficient* to clear it rather than merely reducing the hit count. Two copies of
 * the pattern in two modules would drift, and the failure mode of that drift is a
 * refused publish at runtime.
 *
 * Deliberately NOT part of `redactSecrets`: an email is not a credential, and a
 * transcript rendered for a private gist or local review reads better with the real
 * author addresses intact. It only becomes a leak once the text is PUBLISHED — a
 * world-readable page carrying seven of them is the RUSH-2428 incident.
 *
 * The whole address goes, domain included — a personal domain identifies its owner
 * as surely as the local part does, and keeping it would buy the reader nothing.
 */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, '[EMAIL]');
}

/**
 * Credential-shaped strings that an agent routinely dumps into reports: GitHub
 * PATs, OpenAI/Anthropic/etc. API keys, AWS access keys, Slack tokens, and a
 * generic long `sk-…` / `Bearer …` form. Keep the set tight — false positives
 * force `--force` and train agents to bypass the gate.
 */
const CREDENTIAL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bghp_[A-Za-z0-9_]{20,}\b/g, label: 'ghp_…' },
  { re: /\bgho_[A-Za-z0-9_]{20,}\b/g, label: 'gho_…' },
  { re: /\bghu_[A-Za-z0-9_]{20,}\b/g, label: 'ghu_…' },
  { re: /\bghs_[A-Za-z0-9_]{20,}\b/g, label: 'ghs_…' },
  { re: /\bghr_[A-Za-z0-9_]{20,}\b/g, label: 'ghr_…' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, label: 'github_pat_…' },
  { re: /\bsk-(?:ant|proj|live|test)?[_-]?[A-Za-z0-9]{16,}\b/g, label: 'sk-…' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AKIA…' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'xox…' },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi, label: 'Bearer …' },
];

function redactSample(raw: string, max = 12): string {
  if (raw.length <= max) return raw.slice(0, 4) + '…';
  return raw.slice(0, Math.min(6, max)) + '…';
}

/**
 * Scan a text body for email addresses and credential-shaped strings. Returns
 * the first few hits (deduped by kind+sample). Binary / non-text bodies yield
 * nothing — the gate is for HTML/text reports, not screenshots.
 */
export function scanShareContent(body: string | Buffer): SensitiveHit[] {
  // Skip clearly-binary content (null bytes in the first 1KB) so a PNG/MP4
  // publish never false-positives on binary noise.
  if (Buffer.isBuffer(body)) {
    const head = body.subarray(0, Math.min(body.length, 1024));
    if (head.includes(0)) return [];
  }
  const text = typeof body === 'string' ? body : body.toString('utf8');
  const hits: SensitiveHit[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(EMAIL_RE)) {
    const sample = redactSample(m[0]);
    const key = `email:${sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'email', sample });
    if (hits.length >= 5) return hits;
  }

  for (const { re, label } of CREDENTIAL_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) continue;
    const sample = label;
    const key = `credential:${sample}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'credential', sample });
    if (hits.length >= 5) return hits;
  }

  return hits;
}

/** Build the refuse message when the pre-publish scan finds sensitive content. */
export function formatSensitiveContentError(hits: SensitiveHit[]): string {
  const kinds = Array.from(new Set(hits.map((h) => h.kind)));
  const samples = hits.map((h) => h.sample).join(', ');
  const what =
    kinds.length === 2
      ? 'email addresses and credential-shaped strings'
      : kinds[0] === 'email'
        ? 'email addresses'
        : 'credential-shaped strings';
  return (
    `Refusing to publish: found ${what} (${samples}) in the file, label, or metadata. ` +
    `Shares are world-readable by URL — pass --force to publish anyway, ` +
    `or --unlisted --expire 12h to bound the blast radius.`
  );
}

/** Normalize artifact title text into a URL-safe slug. */
function normalizeSlug(name: string): string {
  return (
    name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'page'
  );
}

/** Derive a URL-safe slug from a filename, stripping its path and extension. */
export function slugify(name: string): string {
  return normalizeSlug(basename(name).replace(/\.[^.]+$/, ''));
}

function sanitizeSlugPart(s: string): string {
  return sanitizeShareNamespace(s);
}

/** The current repo's name, or undefined outside a git checkout — never a
 * fallback guess, since callers that want one (detectProject) supply it themselves. */
function gitRepoName(dir: string): string | undefined {
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (top) return sanitizeSlugPart(basename(top)) || undefined;
  } catch {
    // not a git repo
  }
  return undefined;
}

/** The project the file belongs to — git repo name, else the cwd's basename. */
export function detectProject(dir: string = process.cwd()): string {
  return gitRepoName(dir) ?? (sanitizeSlugPart(basename(dir)) || 'share');
}

/**
 * Stable default slug for an artifact: prefer its HTML `<title>` or Markdown
 * frontmatter `title:`, then fall back to its filename. The same artifact title
 * always yields the same slug, so republishing without `--slug` updates the same
 * URL. `--slug` remains an exact override.
 */
export function defaultSlug(filePath: string, body?: Buffer): string {
  return body ? normalizeSlug(deriveLabel(filePath, body)) : slugify(filePath);
}

function guessContentType(filePath: string): string {
  if (/\.html?$/i.test(filePath)) return 'text/html; charset=utf-8';
  if (/\.css$/i.test(filePath)) return 'text/css; charset=utf-8';
  if (/\.js$/i.test(filePath)) return 'text/javascript; charset=utf-8';
  if (/\.json$/i.test(filePath)) return 'application/json';
  if (/\.svg$/i.test(filePath)) return 'image/svg+xml';
  // Raster images + video: agents publish screenshots and screen recordings as PR
  // evidence, and GitHub's image proxy (camo) only renders an inline `![](url)` when
  // the asset is served with a real image/video content-type — octet-stream is
  // refused. Type them so the share URL embeds instead of downloading.
  if (/\.png$/i.test(filePath)) return 'image/png';
  if (/\.jpe?g$/i.test(filePath)) return 'image/jpeg';
  if (/\.gif$/i.test(filePath)) return 'image/gif';
  if (/\.webp$/i.test(filePath)) return 'image/webp';
  if (/\.avif$/i.test(filePath)) return 'image/avif';
  if (/\.ico$/i.test(filePath)) return 'image/x-icon';
  if (/\.mp4$/i.test(filePath)) return 'video/mp4';
  if (/\.mov$/i.test(filePath)) return 'video/quicktime';
  if (/\.webm$/i.test(filePath)) return 'video/webm';
  if (/\.pdf$/i.test(filePath)) return 'application/pdf';
  if (/\.txt$|\.md$/i.test(filePath)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Best-effort OG cover: capture a screenshot, upload it as `<slug>.png`, and return
 * the page body with og:image meta injected (+ the cover URL). All IO is injected
 * (`put`, `capturer`), so this whole path is unit-testable without config/keychain.
 * Any miss — no capturer output, a failed upload — returns the original body and no
 * coverUrl, so publishing never fails because a cover couldn't be made.
 */
export async function attachOgCover(
  filePath: string,
  body: Buffer,
  ctx: {
    /** Absolute URL to PUT the cover to, `${pageUrl}.png`. Doubles as the cover URL. */
    pngUrl: string;
    pageUrl: string;
    put: PutFn;
    pngHeaders: Record<string, string>;
    capturer: (p: string) => Promise<Buffer | null>;
  },
): Promise<{ body: Buffer; coverUrl?: string }> {
  const png = await ctx.capturer(filePath).catch(() => null);
  if (!png) return { body };
  const cr = await ctx.put(ctx.pngUrl, png, ctx.pngHeaders);
  if (!cr.ok) return { body };
  const { title, description } = deriveMeta(body.toString('utf8'));
  const injected = injectOgMeta(body.toString('utf8'), {
    title,
    description,
    imageUrl: ctx.pngUrl,
    pageUrl: ctx.pageUrl,
    imageWidth: OG_WIDTH * OG_SCALE,
    imageHeight: OG_HEIGHT * OG_SCALE,
  });
  return { body: Buffer.from(injected, 'utf8'), coverUrl: ctx.pngUrl };
}

/** Resolve the publisher's GitHub username, with an explicit override winning first. */
export async function resolveShareUsername(opts: { githubUser?: string } = {}): Promise<string> {
  if (opts.githubUser) {
    const sanitized = sanitizeSlugPart(opts.githubUser);
    if (sanitized) return sanitized;
  }
  const resolved = await resolveGitHubUsername();
  if (resolved) return sanitizeSlugPart(resolved);
  throw new Error(
    "Could not determine your GitHub username for the share URL namespace. " +
      "Authenticate with `gh auth login`, set `git config --global github.user <user>`, " +
      "or pass `--github-user <user>`.",
  );
}

/** Build the R2 object key from a namespace username and a slug part. */
export function buildShareKey(username: string, slugPart: string): string {
  const user = sanitizeSlugPart(username);
  const part = sanitizeSlugPart(slugPart.replace(/\//g, '-'));
  if (!user) throw new Error('GitHub username is required for the share URL namespace.');
  if (!part) throw new Error('Share slug is empty.');
  return `${user}/${part}`;
}

export async function publishFile(
  filePath: string,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const backend = resolveShareBackend(opts as ResolveShareBackendOpts);
  const managedHandle = backend.kind === 'managed' ? requireManagedHandle(opts.handle) : '';
  const username =
    backend.kind === 'managed'
      ? managedHandle || backend.namespace
      : await resolveShareUsername({ githubUser: opts.githubUser || backend.namespace || undefined });
  const analyticsToken =
    opts.analyticsToken ?? (backend.kind === 'byo' ? (opts.config ?? readShareConfig())?.analyticsToken : undefined);
  return publishToEndpoint(filePath, { baseUrl: backend.baseUrl, token: backend.token }, {
    ...opts,
    githubUser: username,
    analyticsToken,
    backendKind: backend.kind,
  });
}

/** Sanitize a caller-chosen managed handle to the Worker's namespace shape.
 * Returns '' when the result is empty or over the Worker's 63-char cap (the
 * caller then falls back to the derived handle / errors). */
export function resolveManagedHandle(handle: string | undefined): string {
  if (!handle) return '';
  const sanitized = sanitizeShareNamespace(handle);
  return sanitized && sanitized.length <= 63 ? sanitized : '';
}

function requireManagedHandle(handle: string | undefined): string {
  const resolved = resolveManagedHandle(handle);
  if (handle && !resolved) {
    throw new Error(`Invalid --handle '${handle}': must sanitize to 1-63 [a-z0-9-] characters`);
  }
  return resolved;
}

export async function publishToEndpoint(
  filePath: string,
  endpoint: PublishEndpoint,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  // A managed publish may carry an explicit --handle: it namespaces the URL and
  // rides the x-share-handle header so the Worker binds the claim to it (a
  // derived handle is proven by the email; an alternate one must be declared).
  const managedHandle = opts.backendKind === 'managed' ? requireManagedHandle(opts.handle) : '';
  const username = managedHandle || (await resolveShareUsername(opts));
  let body: Buffer = readFileSync(filePath);
  const expiresAt = resolveExpire(opts.expire);
  const visibility = resolveShareVisibility(opts);
  const unlisted = visibility === 'unlisted';
  // A capability-URL publish (unlisted / token-gated private) must not have a
  // guessable slug — that was the PHNX-3654 hole. Without an explicit --slug the
  // slug always carries a 64-bit random tail (a title-derived prefix may lead it,
  // but the random suffix is what makes the whole URL unguessable); an explicit
  // --slug is the caller's own choice (e.g. republishing to a known URL) and is
  // honored verbatim.
  const capabilityUrl = visibility === 'unlisted' || visibility === 'private';
  const explicitSlug = typeof opts.slug === 'string' && opts.slug.trim() !== '';
  const slugPart = (
    explicitSlug
      ? opts.slug!
      : capabilityUrl
        ? `${defaultSlug(filePath, body)}-${randomSlugTail()}`
        : defaultSlug(filePath, body)
  ).replace(/^\/+/, '');
  const key = buildShareKey(username, slugPart);
  // Token-gated read auth (PHNX-3654): mint a random viewer token for a private
  // publish. Only its hash is sent to the Worker; the raw token rides in ?k=.
  const viewerToken = visibility === 'private' ? generateViewerToken() : undefined;
  const pageUrl = `${endpoint.baseUrl.replace(/\/+$/, '')}/${key}`;
  const provenance = opts.provenance ?? resolveShareProvenance();
  const avatarUrl = opts.avatar ?? resolveShareAvatar({ session: opts.session });
  const meta = opts.meta ?? {};

  const put =
    opts.uploader ??
    (async (u: string, b: Buffer, h: Record<string, string>): Promise<PutResult> => {
      const res = await fetch(u, { method: 'PUT', headers: h, body: new Uint8Array(b) });
      // Read the error body only on failure, so the caller can surface the
      // Worker's own `{"error":"…"}` + Retry-After (bounded by extractShareHttpError).
      if (res.ok) return { ok: true, status: res.status, url: u };
      const body = await res.text().catch(() => undefined);
      return { ok: false, status: res.status, url: u, body, retryAfter: res.headers.get('retry-after') ?? undefined };
    });

  let coverUrl: string | undefined;
  const isHtml = /\.html?$/i.test(filePath);
  if (isHtml) {
    body = Buffer.from(prepareShareHtml(body.toString('utf8'), filePath), 'utf8');
  }

  const explicitLabel = opts.label?.trim();
  // sanitizeLabel here (not just inside deriveLabel) covers an explicit
  // --label/--title the caller typed with an embedded newline — deriveLabel
  // is only reached when --label is omitted.
  const label = explicitLabel ? sanitizeLabel(explicitLabel) : deriveLabel(filePath, body);
  const labelSource: 'explicit' | 'derived' = explicitLabel ? 'explicit' : 'derived';
  const ogMeta = isHtml ? deriveMeta(body.toString('utf8')) : undefined;

  // The managed Worker owns deterministic OG generation. Point crawlers at the
  // lazy sibling route without invoking a browser on the publishing machine.
  if (isHtml && opts.cover !== false && opts.backendKind === 'managed' && ogMeta) {
    coverUrl = `${pageUrl}.png`;
    body = Buffer.from(injectOgMeta(body.toString('utf8'), {
      ...ogMeta,
      imageUrl: coverUrl,
      pageUrl,
      imageWidth: OG_WIDTH,
      imageHeight: OG_HEIGHT,
    }), 'utf8');
  }

  // Pre-publish scan (RUSH-2443/RUSH-2683): refuse emails / credential-shaped
  // strings unless --force. Runs on the raw file body AND on every piece of
  // free-text metadata that lands in public customMetadata — --label (explicit
  // or derived) and every --meta value. Metadata is visible in the gallery,
  // `share list --list-json`, and `share revisions` just like the page itself, so a
  // credential smuggled in there is exactly as exposed as one in the body; it
  // must not have a free pass around this gate. Runs before analytics/cover
  // mutation so a beacon injection never triggers a false positive on the body
  // scan. Binary media bodies are a no-op for the body scan.
  if (opts.force !== true) {
    const hits = [
      ...scanShareContent(body),
      ...scanShareContent(label),
      ...Object.values(meta).flatMap((v) => scanShareContent(v)),
    ];
    if (hits.length > 0) {
      throw new Error(formatSensitiveContentError(hits));
    }
  }

  // Validate the FULL customMetadata payload before any network call — fail
  // fast, not mid-upload.
  const metadataPreview: Record<string, string> = { ...meta, label, 'label-source': labelSource };
  if (ogMeta && opts.backendKind === 'managed') {
    metadataPreview['og-title'] = ogMeta.title;
    metadataPreview['og-description'] = ogMeta.description;
  }
  if (provenance.agent) metadataPreview.agent = provenance.agent;
  if (provenance.session) metadataPreview.session = provenance.session;
  if (provenance.host) metadataPreview.host = provenance.host;
  if (provenance.repo) metadataPreview.repo = provenance.repo;
  if (provenance.date) metadataPreview.date = provenance.date;
  if (avatarUrl) metadataPreview.avatar = avatarUrl;
  assertMetadataSize(metadataPreview);

  const authHeaders = (contentType: string): Record<string, string> => {
    const h: Record<string, string> = { authorization: `Bearer ${endpoint.token}`, 'content-type': contentType };
    if (managedHandle) h['x-share-handle'] = managedHandle;
    if (expiresAt) h['x-share-expires-at'] = expiresAt;
    h['x-share-visibility'] = visibility;
    // Token-gated read auth (PHNX-3654): send the RAW viewer token. The Worker
    // hashes it (SHA-256) and stores only the hash in customMetadata, so the
    // secret never lands in object metadata. Only present for a private publish.
    if (viewerToken) h['x-share-viewer-token'] = viewerToken;
    // Two headers per free-text field, backward-compatible by construction
    // (PHNX-2786): `x-share-<field>` always carries the latin1-safe folded value
    // an already-deployed Worker reads verbatim, and — only when the fold is lossy
    // (a curly quote, em dash, emoji, CJK/Arabic/Hindi) — a percent-encoded
    // `x-share-<field>-u` companion carries the full Unicode. A new Worker opts
    // into the companions via `x-share-encoding: percent`; an old one ignores the
    // unknown headers and keeps folding gracefully. The floor also keeps the
    // ByteString crash fixed: a non-latin1 code point never reaches a raw header.
    let unicodeCompanion = false;
    const setText = (name: string, value: string) => {
      h[name] = toHeaderValue(value);
      if (needsUnicodeCompanion(value)) {
        h[`${name}-u`] = toPercentHeaderValue(value);
        unicodeCompanion = true;
      }
    };
    if (provenance.agent) setText('x-share-agent', provenance.agent);
    if (provenance.session) setText('x-share-session', provenance.session);
    if (provenance.host) setText('x-share-host', provenance.host);
    if (provenance.repo) setText('x-share-repo', provenance.repo);
    if (provenance.date) setText('x-share-date', provenance.date);
    if (avatarUrl) setText('x-share-avatar', avatarUrl);
    setText('x-share-label', label);
    h['x-share-label-source'] = labelSource;
    if (ogMeta && opts.backendKind === 'managed') {
      setText('x-share-og-title', ogMeta.title);
      setText('x-share-og-description', ogMeta.description);
    }
    // Per VALUE, before JSON.stringify — folding the serialized form would rewrite
    // a curly quote inside a value into a bare `"`, which is structural in JSON and
    // makes the Worker's JSON.parse throw. It swallows that error, so every --meta
    // key would silently vanish on a 200. The companion carries the whole raw meta
    // object percent-encoded once, so a new Worker recovers full-Unicode keys AND
    // values in one JSON.parse rather than per-field.
    if (Object.keys(meta).length > 0) {
      const headerMeta = Object.fromEntries(
        Object.entries(meta).map(([k, v]) => [toHeaderValue(k), toHeaderValue(v)]),
      );
      h['x-share-meta'] = JSON.stringify(headerMeta);
      if (Object.entries(meta).some(([k, v]) => needsUnicodeCompanion(k) || needsUnicodeCompanion(v))) {
        h['x-share-meta-u'] = encodeURIComponent(JSON.stringify(meta));
        unicodeCompanion = true;
      }
    }
    if (unicodeCompanion) h['x-share-encoding'] = 'percent';
    if (opts.noRevision) h['x-share-no-revision'] = '1';
    return h;
  };

  // Analytics: cookieless CF Web Analytics beacon, injected for HTML by default.
  if (isHtml && opts.analytics !== false && opts.analyticsToken) {
    body = Buffer.from(injectAnalyticsBeacon(body.toString('utf8'), opts.analyticsToken), 'utf8');
  }

  // Cover: screenshot the page's hero → upload <slug>.png → inject og:image meta.
  // Unlisted pages still get a cover (the direct URL is the capability), but the
  // cover inherits visibility=unlisted so it is also omitted from the gallery.
  if (isHtml && opts.cover !== false && opts.backendKind !== 'managed') {
    const res = await attachOgCover(filePath, body, {
      pngUrl: `${pageUrl}.png`,
      pageUrl,
      put,
      pngHeaders: authHeaders('image/png'),
      capturer: opts.capturer ?? captureCover,
    });
    body = res.body;
    coverUrl = res.coverUrl;
  }

  const r = await put(pageUrl, body, authHeaders(opts.contentType ?? guessContentType(filePath)));
  if (!r.ok) {
    // 409 has two distinct shapes on the managed Worker: 'handle taken' (the
    // caller's namespace belongs to another account) and 'publish conflict'
    // (a concurrent write won the republish race — retry, per PHNX-3547).
    const httpError = extractShareHttpError({ status: r.status, body: r.body, retryAfter: r.retryAfter });
    if (r.status === 409 && httpError.serverMessage === 'handle taken' && opts.backendKind === 'managed') {
      throw new Error(
        `Handle '${username}' is already claimed by another account. ` +
          'If you signed in again and got a new account id, republishing with the same email re-binds your handle automatically; ' +
          'otherwise pick a different public namespace with --handle <name>.',
      );
    }
    const detail = formatShareHttpErrorDetail(httpError);
    // The write-token/setup advice is only meaningful for an auth failure — a
    // 413 (quota/size) or 429 (rate) rejection has nothing to do with the
    // token, and 'Check the write token' there is plain wrong (PHNX-3579).
    // Managed endpoints carry a Phoenix bearer, so the recovery is re-login.
    let advice = '';
    if (r.status === 401 || r.status === 403) {
      advice =
        opts.backendKind === 'managed'
          ? ". Check that you're signed in — run 'agents auth login'."
          : ". Check the write token, or that 'agents artifacts setup' completed.";
    }
    throw new Error(`Publish failed (${r.status}) for ${pageUrl}${detail}${advice}`);
  }
  // A token-gated page is only reachable WITH its key, so the URL we hand back
  // (and store nowhere) carries it — https://<host>/<user>/<slug>?k=<token>.
  const baseUrl = r.url ?? pageUrl;
  const url = viewerToken ? `${baseUrl}?k=${encodeURIComponent(viewerToken)}` : baseUrl;
  return {
    url,
    slug: key.slice(key.indexOf('/') + 1),
    expiresAt,
    coverUrl,
    label,
    labelSource,
    visibility,
    ...(unlisted ? { unlisted: true } : {}),
    ...(viewerToken ? { viewerToken } : {}),
  };
}
