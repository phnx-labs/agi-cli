/**
 * Shared redaction helpers for text that may be exported or logged.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Local home paths identify operators and disclose internal filesystem layout.
  // Keep the useful path suffix while masking the machine-specific home prefix.
  [/(^|[\s,"'`(=:])\/(?:home|Users)\/[^/\s,"'`]+/g, '$1[HOME]'],
  [/(^|[\s,"'`(=])[A-Z]:\\Users\\[^\\\s,"'`]+/gi, '$1[HOME]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // GitHub: classic PATs (ghp_), OAuth (gho_), app/refresh/server tokens
  // (ghs_/ghr_), and fine-grained PATs (github_pat_). All share the 36-char
  // classic body; fine-grained tokens are longer, so match greedily.
  [/\bghp_[A-Za-z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgh[osru]_[A-Za-z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  // Anthropic credentials go before the generic sk- rule. Matches API keys (sk-ant-api03-...) AND
  // OAuth setup-tokens (sk-ant-oat01-...). The generic rule can't match oat01 (the hyphen after
  // `ant` breaks its run), so a setup-token would leak verbatim into logs and exports (#1767).
  [/\bsk-ant-[a-z0-9]{3,8}-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  // Stripe live secret / restricted keys.
  [/\b[rs]k_live_[A-Za-z0-9]{20,}\b/g, '[REDACTED_STRIPE_KEY]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]'],
  // Slack bot/user/app-level tokens (xoxb-/xoxp-/xapp-…).
  [/\bxox[bp]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bxapp-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED_NPM_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  // Headers frequently appear inside shell arguments. Consume a quoted header
  // as one unit so cookie attributes after a space do not survive redaction.
  [/(^|\s)(["'])(Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:\s*.*?\2/gi, '$1$2$3: [REDACTED]$2'],
  [/(^|\s)(["'])(Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:\s*(?:(?!\2).)*$/gi, '$1$2$3: [REDACTED]'],
  [/Bearer\s+\S+/gi, 'Bearer [REDACTED]'],
  [/\b((?:Cookie|Set-Cookie)\s*:\s*)\S+/gi, '$1[REDACTED]'],
  [/\b(Authorization\s*:\s*)(?!Bearer\s+\[REDACTED\])\S+(?:\s+\S+)?/gi, '$1[REDACTED]'],
  // Structured secret fields can arrive as raw JSON output rather than an
  // argument object, so the object walker alone is not sufficient.
  [/(^[,{\s]|["'])([A-Z0-9_-]*(?:TOKEN|KEY|SECRET|PASSWORD|AUTHORIZATION|COOKIE)[A-Z0-9_-]*["']?\s*:\s*)(["'][^"']*["']|[^,}\]\s]+)/gim, '$1$2"[REDACTED]"'],
  [/(\s--?(?:password|token|secret|api[_-]?key)(?:=|\s+))(["']?)[^\s"']+\2/gi, '$1[REDACTED]'],
  [/(\s--user(?:=|\s+))(["']?)[^\s"']+\2/gi, '$1[REDACTED]'],
  [/(\s-u\s+)(["']?)[^\s"']+\2/g, '$1[REDACTED]'],
  [/(\s--proxy-user(?:=|\s+))(["']?)[^\s"']+\2/gi, '$1[REDACTED]'],
  [/(\s-U\s+)(["']?)[^\s"']+\2/g, '$1[REDACTED]'],
  [/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@'],
  [/\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]'],
];

const ESC = 0x1b;
const BEL = 0x07;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const ST_8BIT = 0x9c;

/** C0 controls (minus \t \n \r), DEL, and the C1 range. */
function isControlByte(c: number): boolean {
  return (c <= 0x08) || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || (c >= 0x7f && c <= 0x9f);
}

/** End (exclusive) of a CSI parameter/intermediate/final run starting at `i`, or `i` when unterminated. */
function csiEnd(text: string, i: number): number {
  let j = i;
  while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j++;
  while (j < text.length && text.charCodeAt(j) >= 0x20 && text.charCodeAt(j) <= 0x2f) j++;
  if (j < text.length && text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e) return j + 1;
  return i;
}

/** Remove terminal control sequences from untrusted text. A single forward scan, not a regex: an OSC
 * lookup for its terminator is the classic polynomial-backtracking shape that crafted text can
 * trigger; here each character is visited a bounded number of times. */
export function sanitizeForTerminal(text: string): string {
  if (!text) return text;
  let out = '';
  let i = 0;
  const n = text.length;
  // Once an 8-bit OSC scan reaches the end without a terminator, no later one can find one either.
  let noOsc8Terminator = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === ESC && i + 1 < n) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5d) {
        // OSC: runs to BEL or ESC-\. Any other ESC aborts the sequence, so the
        // scan never re-covers ground a later OSC start could claim.
        let j = i + 2;
        while (j < n && text.charCodeAt(j) !== BEL && text.charCodeAt(j) !== ESC) j++;
        if (j < n && text.charCodeAt(j) === BEL) { i = j + 1; continue; }
        if (j + 1 < n && text.charCodeAt(j) === ESC && text.charCodeAt(j + 1) === 0x5c) { i = j + 2; continue; }
        i += 2;
        continue;
      }
      if (next === 0x5b) {
        const end = csiEnd(text, i + 2);
        if (end > i + 2) { i = end; continue; }
        i += 2;
        continue;
      }
      if (next >= 0x40 && next <= 0x5f) { i += 2; continue; }
      i += 1;
      continue;
    }
    if (c === OSC_8BIT && !noOsc8Terminator) {
      let j = i + 1;
      while (j < n && text.charCodeAt(j) !== BEL && text.charCodeAt(j) !== ST_8BIT) j++;
      if (j < n) { i = j + 1; continue; }
      noOsc8Terminator = true;
      i += 1;
      continue;
    }
    if (c === CSI_8BIT) {
      const end = csiEnd(text, i + 1);
      i = end > i + 1 ? end : i + 1;
      continue;
    }
    if (isControlByte(c)) { i += 1; continue; }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Env vars whose NAME marks their VALUE as a credential worth masking literally. */
const SECRET_ENV_NAME = /(?:TOKEN|KEY|SECRET|PASSWORD)/i;
/** Don't literal-mask trivially short values — they collide with ordinary text. */
const MIN_KNOWN_VALUE_LEN = 6;

/** Scrub secrets from `text` in two passes: format-based patterns, then a value-aware pass masking
 * any `knownValues` verbatim, since a credential already in hand leaks regardless of format. */
export function redactSecrets(text: string, knownValues?: readonly string[]): string {
  let safe = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  if (knownValues) {
    for (const value of knownValues) {
      if (value.length < MIN_KNOWN_VALUE_LEN) continue;
      safe = safe.split(value).join('[REDACTED]');
    }
  }
  return safe;
}

/** Secret values already in the environment (e.g. an injected secrets bundle), picked by
 * secret-shaped var NAME, fed to {@link redactSecrets} as known values so an exported transcript
 * can't leak a live credential that matches no pattern. */
export function knownSecretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_KNOWN_VALUE_LEN) continue;
    if (SECRET_ENV_NAME.test(name)) out.push(value);
  }
  return out;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Mask email addresses in rendered text: a published page's sensitive-content scan refuses a body
 * containing an email (as `artifacts share` does) and most transcripts carry some, so masking makes
 * the page genuinely free of them rather than training callers to pass `--force`. */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_RE, '[EMAIL]');
}
