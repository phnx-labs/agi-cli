import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  bundleBackendSync,
  bundleExistsSync,
  isSecretsClientError,
  readAndResolveBundleEnvSync,
  secretsKeychainItem,
  storeGetSync,
  storeHasSync,
} from './secrets-client.js';
import {
  AUTH_STORE_ALIAS,
  ReservedBundleWrongBackendError,
  assertReservedAuthBackend,
  isReservedBundleBackendError,
  isReservedStoreName,
} from './reserved-stores.js';
import type { SecretsBundle } from './secrets-types.js';
import { ensureSlot, recordSlot } from './accounts/slots.js';
import { harnessWorkerKinds } from './harness-auth-capabilities.js';
import type { DeviceAccountSlot, NativeAccountRecord } from './types.js';

/**
 * Reserved FILE-BASED secrets bundle holding long-lived, non-rotating Claude
 * setup-tokens. Usage/probe reads authenticate with these instead of Claude
 * Code's ACL-bound login item, so they never pop Touch ID. Keyed strictly
 * per-account (`CLAUDE_CODE_OAUTH_TOKEN_<slug>` from the account email) — never a
 * bare key, so one account's token can't be misapplied to another in a
 * multi-account fleet.
 */
/** Alias of the reserved-store name so mint/seed shares one source of truth. */
export const AUTH_BUNDLE = AUTH_STORE_ALIAS;
export { ReservedBundleWrongBackendError };

/**
 * A well-formed Claude OAuth setup-token: the `sk-ant-oat01-` prefix followed by
 * token-safe characters only, on a single line. `claude setup-token` mints exactly
 * this; nothing else is a token.
 *
 * The provisioning capture bug behind #1767 stored the raw `claude setup-token`
 * TTY stream — the welcome banner, ANSI control sequences, box-drawing art, and the
 * token buried inside — under a per-account key instead of the parsed value. That
 * blob is not a token: injected as `Authorization: Bearer <blob>` it made Anthropic
 * reject every request and the run crash. agents-cli only *consumes* these tokens
 * (the mint itself is the Rush Cloud / mint-auth path), so this is the boundary
 * where a corrupt bundle entry must be caught before it reaches the auth header.
 */
const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;

interface SetupTokenCacheEntry {
  readAt: number;
  token: string | null;
}

/**
 * Process-local memo of resolved setup-tokens, keyed by the caller's cache key
 * AND the per-account token key — a version home that switches accounts must
 * miss, never be served the previous account's token. Plaintext setup-tokens
 * are never written to another cache. The bundle now
 * lives behind the standalone `secrets` process (one spawn per read), so the
 * memo is what keeps a probe loop over many accounts from re-decrypting the
 * whole `auth` bundle per account; it is bounded by {@link SETUP_TOKEN_MEMO_TTL_MS}
 * so a rotation performed by another process is observed within seconds, and
 * an in-process writer clears it outright ({@link invalidateClaudeSetupTokenCache}).
 */
const setupTokenCache = new Map<string, SetupTokenCacheEntry>();
const SETUP_TOKEN_MEMO_TTL_MS = 10_000;

/** Drop every memoized setup-token; called after this process seeds or rotates one. */
export function invalidateClaudeSetupTokenCache(): void {
  setupTokenCache.clear();
}

/**
 * Read the reserved `auth` bundle through the standalone. Returns null when it
 * does not exist — checked explicitly, because a prompt-free (`agentOnly`) read
 * of a bundle that does not exist reports LOCKED, and a genuinely locked store
 * must stay distinguishable from an absent bundle. A keychain- or vault-backed
 * `auth` fails loud with {@link ReservedBundleWrongBackendError} — whether the
 * standalone refused the resolve (`WRONG_BACKEND`) or the returned metadata
 * names the wrong backend — so usage/probe never silently ignores a seeded
 * token (SEC-GAP-3).
 */
function readReservedAuthBundle(caller: string): { bundle: SecretsBundle; env: Record<string, string> } | null {
  if (!bundleExistsSync(AUTH_BUNDLE)) return null;
  let resolved: { bundle: SecretsBundle; env: Record<string, string> };
  try {
    resolved = readAndResolveBundleEnvSync(AUTH_BUNDLE, { caller, agentOnly: true });
  } catch (err) {
    if (isSecretsClientError(err, 'WRONG_BACKEND')) {
      throw new ReservedBundleWrongBackendError(AUTH_BUNDLE, bundleBackendSync(AUTH_BUNDLE));
    }
    throw err;
  }
  assertReservedAuthBackend(resolved.bundle.backend ?? 'keychain');
  return resolved;
}

function credentialFingerprint(credentialPath: string): string {
  try {
    const stat = fs.statSync(credentialPath, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/** True only for a clean, single-line `sk-ant-oat01-…` token — see {@link SETUP_TOKEN_RE}. */
export function isValidClaudeSetupToken(value: string): boolean {
  return SETUP_TOKEN_RE.test(value);
}

/** The per-account key an email maps to inside the `auth` bundle. */
export function claudeAccountTokenKey(account: string): string {
  const slug = account
    .trim()
    .toUpperCase()
    .replace(/@/g, '_AT_')
    .replace(/\./g, '_DOT_')
    .replace(/[^A-Z0-9_]/g, '_');
  return `CLAUDE_CODE_OAUTH_TOKEN_${slug}`;
}

/** Signed-in account email for a version home, from `.claude.json` (no keychain). */
export function readClaudeAccountEmail(home?: string): string | null {
  const base = home ?? os.homedir();
  for (const p of [path.join(base, '.claude', '.claude.json'), path.join(base, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return email.trim();
    } catch {
      // Missing/unreadable at this location — try the next.
    }
  }
  return null;
}

/**
 * Resolve a long-lived `claude setup-token` for the account signed into `home`
 * from the reserved FILE-BASED `auth` bundle. Returns the token or null. Reads
 * ONLY when the bundle is file-backed (never keychain), so this path itself can
 * never trigger a Touch ID prompt — that is the entire point: usage/probe reads
 * authenticate with the shareable setup-token, not the ACL-bound login item.
 */
export function resolveClaudeSetupToken(home?: string): string | null {
  // Require a known account (email) up front: without it we cannot key a
  // per-account token, and we must NOT fall back to a bare shared key that
  // would misapply one account's setup-token to another.
  const email = readClaudeAccountEmail(home)
    // Self-heal (PHNX-3660): a home provisioned before seed-on-attach carries an
    // `.oauth_token` but no identity. Recover the email from the bundle and
    // write it back, so the home converges instead of needing a re-attach.
    // Explicit-home only: with no home the probe targets the operator's real
    // ~/.claude.json, which a library read must never rewrite.
    ?? (home ? discoverClaudeAccountEmailFromOauthToken(home) : null);
  if (!email) return null;
  return resolveClaudeSetupTokenForEmail(email, home ?? os.homedir());
}

/** Negative/positive discovery cache, keyed by home + .oauth_token fingerprint (SHOULD-2). */
const discoveryCache = new Map<string, { fingerprint: string; email: string | null }>();

/**
 * Recover a home's account email from its `.claude/.oauth_token` by matching
 * the token VALUE against the `auth` bundle (the slug encodes the email, and
 * the re-encode check makes the decode lossless or fail). On a match the
 * identity is written back via {@link seedClaudeWorkerHomeIdentity}, so this
 * runs at most once per home. Returns null — and writes nothing — when the
 * file is missing, malformed, or matches no bundle key: a token that no longer
 * exists in the bundle must not resurrect an account mapping. A no-match
 * result is cached against the token file's fingerprint so a rotated-out home
 * does not re-decrypt the bundle on every probe.
 */
function discoverClaudeAccountEmailFromOauthToken(home: string): string | null {
  try {
    const tokenPath = path.join(home, '.claude', '.oauth_token');
    const fingerprint = credentialFingerprint(tokenPath);
    if (fingerprint === 'missing') return null;
    const cached = discoveryCache.get(home);
    if (cached && cached.fingerprint === fingerprint) return cached.email;
    const email = discoverEmailUncached(home, tokenPath);
    discoveryCache.set(home, { fingerprint, email });
    return email;
  } catch (err) {
    if (isReservedBundleBackendError(err)) throw err;
    return null;
  }
}

function discoverEmailUncached(home: string, tokenPath: string): string | null {
  let token: string;
  try {
    token = fs.readFileSync(tokenPath, 'utf-8').trim();
  } catch {
    return null;
  }
  if (!isValidClaudeSetupToken(token)) return null;
  const resolved = readReservedAuthBundle('usage');
  if (!resolved) return null;
  for (const [key, value] of Object.entries(resolved.env)) {
    if (value.trim() !== token) continue;
    const email = emailFromTokenKey(key);
    if (!email) continue;
    seedClaudeWorkerHomeIdentity(home, email);
    return email;
  }
  return null;
}

/**
 * Decode the email a `CLAUDE_CODE_OAUTH_TOKEN_<slug>` key encodes — or null
 * when the decode is ambiguous. The mapping collapses every non-alphanumeric
 * to `_`, so a `_` surviving in the decoded address cannot be told apart from
 * a folded `.`/`+`/etc. (`FIRST_DOT_LAST_AT_GMAIL_DOT_COM` decodes to
 * `first_dot_last@gmail.com`, which round-trips — wrongly — under the bare
 * re-encode check; review BLOCKER 1). Only a fully unambiguous decode — local
 * and domain pure `[a-z0-9]`, dots in the domain only — is trusted.
 */
function emailFromTokenKey(key: string): string | null {
  const prefix = 'CLAUDE_CODE_OAUTH_TOKEN_';
  if (!key.startsWith(prefix)) return null;
  const slug = key.slice(prefix.length);
  const [local, domain, ...rest] = slug.split('_AT_');
  if (!local || !domain || rest.length > 0) return null;
  const email = `${local}@${domain.replace(/_DOT_/g, '.')}`.toLowerCase();
  if (!/^[a-z0-9]+@[a-z0-9.]+$/.test(email)) return null;
  if (claudeAccountTokenKey(email) !== key) return null;
  return email;
}

/**
 * Resolve a long-lived setup-token for an EXPLICIT account email, independent of
 * any version home's `.claude.json`. This is what lets worker-slot provisioning
 * seed a headless worker home that has never had an interactive login: the
 * account's non-rotating setup-token is already fleet-synced in the file-based
 * `auth` bundle, keyed by email ({@link claudeAccountTokenKey}), so we can write
 * the home's `.oauth_token` from it without the circular
 * "read the home's email to resolve the home's token" dependency that
 * {@link resolveClaudeSetupToken} has. Same file-backed-only, fail-closed,
 * fingerprint-stable read as the home-keyed path — it is the shared core.
 *
 * `cacheKey` scopes the process-local token cache; callers pass a version home
 * so a home-keyed and email-keyed read of the same account share nothing stale.
 */
export function resolveClaudeSetupTokenForEmail(email: string, cacheKey?: string): string | null {
  try {
    const trimmed = email.trim();
    if (!trimmed) return null;
    const key = claudeAccountTokenKey(trimmed);
    const ck = `${cacheKey ?? `email:${trimmed}`}\0${key}`;
    const cached = setupTokenCache.get(ck);
    if (cached && Date.now() - cached.readAt < SETUP_TOKEN_MEMO_TTL_MS) return cached.token;
    // SEC-GAP-3: a keychain/vault-backed `auth` used to return null here, so
    // usage/probe fell through to the interactive login (Touch ID) with no
    // hint that the seeded setup-token was being ignored. readReservedAuthBundle
    // throws ReservedBundleWrongBackendError instead, which propagates.
    const resolved = readReservedAuthBundle('usage');
    const v = (resolved?.env[key] ?? '').trim();
    const token = v.length > 0 && isValidClaudeSetupToken(v) ? v : null;
    setupTokenCache.set(ck, { readAt: Date.now(), token });
    return token;
  } catch (err) {
    if (isReservedBundleBackendError(err)) throw err;
    return null;
  }
}

/**
 * Seed a keychain-less Linux worker's Claude version-home identity so an account's
 * fleet-synced setup-token resolves for it. A worker home never had an interactive
 * browser login, so its `.claude.json` carries no `oauthAccount.emailAddress` and
 * the account reads "signed out" even though its non-rotating setup-token is present
 * in the `auth` bundle. This writes ONLY the descriptive identity (the email), merged
 * into both `.claude.json` locations Claude Code reads, preserving every other field.
 * It never copies a rotating OAuth credential (`.credentials.json`) — the setup-token
 * stays the credential of record.
 */
/**
 * Write a Claude worker slot's `.oauth_token` (0600) from a durable setup-token,
 * the way the pre-slot worker home was provisioned. Refuses a malformed token so
 * a corrupt bundle entry can never reach the auth header (see {@link SETUP_TOKEN_RE}).
 * `home` is the slot dir; the claude adapter shim reads `$CLAUDE_CONFIG_DIR/.oauth_token`
 * where `CLAUDE_CONFIG_DIR` is `<home>/.claude`. Returns the written path.
 */
export function writeClaudeWorkerOauthToken(home: string, token: string): string {
  if (!isValidClaudeSetupToken(token)) {
    throw new Error('Refusing to write a malformed Claude setup-token to a worker slot.');
  }
  const tokenPath = path.join(home, '.claude', '.oauth_token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return tokenPath;
}

/**
 * Read one non-rotating credential value from a reserved store by its storage
 * key. Returns null when the bundle or key is absent. Used to materialize a
 * worker slot from a synced durable credential (setup-token / API key).
 *
 * A reserved `__<harness>__` store is file-backed by design (headless, fleet-
 * shareable) and its item is read directly, symmetric with how it is written —
 * `readAndResolveBundleEnv`'s name validation does not yet accept a reserved
 * name on the READ path (a secrets-track seam; see the PR body). A non-reserved
 * bundle (the legacy `auth` alias, a provider bundle) goes through the normal
 * resolver so refs/expiry/lease gates still apply.
 */
export function readReservedCredential(bundle: string, key: string): string | null {
  try {
    if (isReservedStoreName(bundle) && bundle.startsWith('__')) {
      const item = secretsKeychainItem(bundle, key);
      if (!storeHasSync('file', item)) return null;
      const value = storeGetSync('file', item).trim();
      return value.length > 0 ? value : null;
    }
    const { env } = readAndResolveBundleEnvSync(bundle, {
      keys: [key],
      keyMode: 'storage',
      agentOnly: true,
      caller: 'provision-worker-slot',
    });
    const value = (env[key] ?? '').trim();
    return value.length > 0 ? value : null;
  } catch (err) {
    if (isReservedBundleBackendError(err)) throw err;
    return null;
  }
}

/**
 * Materialize a worker slot for a portable account from its synced durable
 * credential (PHNX-3940 T6 — the generalization of the pre-slot Claude worker-home
 * provisioning). Creates the HOME-shaped slot dir (T1 `ensureSlot`), then, for a
 * durable harness, writes the credential into it the way the Claude worker home is
 * provisioned today: for `claude`, the setup-token → `.oauth_token` (0600) + the
 * seeded identity email (the read-side join in agent-spec then completes the uuids
 * from the registry row). API-key harnesses need no file — the key is injected at
 * spawn from the reserved store (T5) — so their slot is created and recorded
 * `durable` with no write. A per-device harness (`worker: 'none'`) gets a
 * `per-device` slot and no credential — it logs in per box.
 *
 * This is worker-side reconciliation: it runs on the box where the key landed and
 * NEVER transports anything (the SSH push that delivered the key is the daemon's
 * job — invariant 1). Fails loud when a durable claude account has no resolvable
 * token on this device rather than recording a slot that cannot authenticate.
 */
export function provisionWorkerSlot(account: NativeAccountRecord): DeviceAccountSlot {
  const harness = account.agent;
  const durable = harnessWorkerKinds(harness).some(
    (kind) => kind === 'setup-token' || kind.startsWith('api-key'),
  );
  const slot = ensureSlot(harness, account.id);
  const checkedAt = new Date().toISOString();

  if (!durable) {
    const record: DeviceAccountSlot = { ...slot, authMode: 'per-device', verdict: 'unconfigured', checkedAt };
    recordSlot(account.id, record);
    return record;
  }

  if (harness === 'claude') {
    const cred = account.workerCredential;
    const token = cred
      ? readReservedCredential(cred.bundle, cred.key)
      // Claude row predating T1 (no workerCredential): the legacy `auth` bundle
      // keys the token by the account email.
      : account.identityLabel
        ? resolveClaudeSetupTokenForEmail(account.identityLabel, slot.slotDir)
        : null;
    if (!token) {
      const where = cred ? `${cred.bundle}:${cred.key}` : `'${AUTH_BUNDLE}' keyed by ${account.identityLabel ?? '(no email)'}`;
      throw new Error(
        `No durable Claude setup-token for account ${account.id} on this device (${where}). `
        + `Mint and sync it from the headed device.`,
      );
    }
    writeClaudeWorkerOauthToken(slot.slotDir, token);
    if (account.identityLabel) seedClaudeWorkerHomeIdentity(slot.slotDir, account.identityLabel);
  }
  // API-key harnesses: the key rides the reserved store and is injected at spawn
  // (T5); nothing is written into the slot here.

  const record: DeviceAccountSlot = { ...slot, authMode: 'durable', verdict: 'unverified', checkedAt };
  recordSlot(account.id, record);
  return record;
}

/**
 * True when a claude worker slot carries everything provisioning seeds: the
 * identity email AND the completed-onboarding flag. A slot provisioned before
 * onboarding was seeded answers false, so the daemon's reconcile re-seeds it.
 */
export function isClaudeWorkerHomeSeeded(home: string): boolean {
  for (const p of [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]) {
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        hasCompletedOnboarding?: unknown;
        oauthAccount?: { emailAddress?: unknown };
      };
      const email = doc.oauthAccount?.emailAddress;
      if (doc.hasCompletedOnboarding !== true) return false;
      if (typeof email !== 'string' || email.trim().length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Seed a worker slot's `.claude.json` (both locations Claude Code reads) with
 * the account identity AND `hasCompletedOnboarding`. A worker never has a human
 * at it, so nothing else can complete Claude Code's first-run onboarding (theme
 * picker, "Let's get started"); without the flag every slot launch re-onboarded.
 * Everything else in the document is preserved.
 */
export function seedClaudeWorkerHomeIdentity(versionHome: string, email: string): void {
  const trimmed = email.trim();
  if (!trimmed) return;
  for (const p of [
    path.join(versionHome, '.claude', '.claude.json'),
    path.join(versionHome, '.claude.json'),
  ]) {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      // Missing file → write a fresh minimal document. A file that EXISTS but
      // does not parse is being concurrently rewritten by Claude Code itself —
      // skip it rather than overwrite a live config with the minimal doc.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    const existing = (doc.oauthAccount && typeof doc.oauthAccount === 'object'
      ? (doc.oauthAccount as Record<string, unknown>)
      : {});
    doc.oauthAccount = { ...existing, emailAddress: trimmed };
    doc.hasCompletedOnboarding = true;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Temp-write + rename: a reader mid-write never sees a truncated doc.
    const tmp = `${p}.agents-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, p);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
}
