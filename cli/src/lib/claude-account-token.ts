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

/** Reserved file-based secrets bundle of long-lived Claude setup-tokens, so usage/probe reads never
 * pop Touch ID. Keyed per account, never a bare key, to avoid cross-account misuse. */
/** Alias of the reserved-store name so mint/seed shares one source of truth. */
export const AUTH_BUNDLE = AUTH_STORE_ALIAS;
export { ReservedBundleWrongBackendError };

/** A well-formed Claude OAuth setup-token: `sk-ant-oat01-` plus token-safe characters on one line.
 * Boundary for #1767, where a captured TTY stream was stored instead of the token and made every
 * request fail. */
const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;

interface SetupTokenCacheEntry {
  readAt: number;
  token: string | null;
}

/** Process-local memo of setup-tokens keyed by caller key and per-account token key, so an account
 * switch misses. Never written to another cache. TTL-bounded (SETUP_TOKEN_MEMO_TTL_MS) so rotation
 * elsewhere is seen; in-process writers clear it. */
const setupTokenCache = new Map<string, SetupTokenCacheEntry>();
const SETUP_TOKEN_MEMO_TTL_MS = 10_000;

/** Drop every memoized setup-token; called after this process seeds or rotates one. */
export function invalidateClaudeSetupTokenCache(): void {
  setupTokenCache.clear();
}

/** Read the reserved `auth` bundle via the standalone; null when absent (checked explicitly, since
 * a prompt-free read of a missing bundle reports LOCKED). A keychain/vault-backed `auth` fails
 * loud with ReservedBundleWrongBackendError (SEC-GAP-3). */
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

/** Resolve the setup-token for the account signed into `home` from the file-based `auth` bundle;
 * null if none. Never reads keychain, so it cannot trigger Touch ID. */
export function resolveClaudeSetupToken(home?: string): string | null {
  // Require a known account (email) up front: without it we cannot key a
  // per-account token, and we must NOT fall back to a bare shared key that
  // would misapply one account's setup-token to another.
  const email = readClaudeAccountEmail(home)
    // Self-heal (PHNX-3660): recover the email for a home with `.oauth_token` but no identity.
    // Explicit-home only; a library read must never rewrite the real ~/.claude.json.
    ?? (home ? discoverClaudeAccountEmailFromOauthToken(home) : null);
  if (!email) return null;
  return resolveClaudeSetupTokenForEmail(email, home ?? os.homedir());
}

/** Negative/positive discovery cache, keyed by home + .oauth_token fingerprint (SHOULD-2). */
const discoveryCache = new Map<string, { fingerprint: string; email: string | null }>();

/** Recover a home's email by matching its `.oauth_token` against the `auth` bundle, writing
 * identity back via seedClaudeWorkerHomeIdentity. Returns null and writes nothing on no match; a
 * no-match is cached by token fingerprint. */
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

/** Decode the email a `CLAUDE_CODE_OAUTH_TOKEN_<slug>` key encodes, or null if ambiguous.
 * Non-alphanumerics fold to `_`, so only a fully unambiguous decode (pure [a-z0-9], dots in domain
 * only) is trusted. */
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

/** Resolve a setup-token for an explicit email, independent of any home's `.claude.json`, so
 * headless worker homes can be seeded from the fleet-synced `auth` bundle. `cacheKey` scopes the
 * process-local cache. File-backed only and fail-closed, like the home-keyed path. */
export function resolveClaudeSetupTokenForEmail(email: string, cacheKey?: string): string | null {
  try {
    const trimmed = email.trim();
    if (!trimmed) return null;
    const key = claudeAccountTokenKey(trimmed);
    const ck = `${cacheKey ?? `email:${trimmed}`}\0${key}`;
    const cached = setupTokenCache.get(ck);
    if (cached && Date.now() - cached.readAt < SETUP_TOKEN_MEMO_TTL_MS) return cached.token;
    // SEC-GAP-3: a keychain/vault-backed `auth` now throws ReservedBundleWrongBackendError instead
    // of returning null, so usage/probe no longer falls through to interactive login with the
    // seeded token silently ignored.
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

/** Seed a keychain-less Linux worker's Claude home identity (email only) into both `.claude.json`
 * locations so the fleet-synced setup-token resolves. Never copies a rotating OAuth credential
 * (`.credentials.json`); preserves other fields. */
/** Write a worker slot's `.oauth_token` (0600) from a durable setup-token; refuses a malformed
 * token so a corrupt bundle entry never reaches the auth header. `home` is the slot dir; the shim
 * reads `$CLAUDE_CONFIG_DIR/.oauth_token` with CLAUDE_CONFIG_DIR=`<home>/.claude`. */
export function writeClaudeWorkerOauthToken(home: string, token: string): string {
  if (!isValidClaudeSetupToken(token)) {
    throw new Error('Refusing to write a malformed Claude setup-token to a worker slot.');
  }
  const tokenPath = path.join(home, '.claude', '.oauth_token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return tokenPath;
}

/** Read one non-rotating credential from a reserved store by key; null when absent. Reserved
 * `__<harness>__` stores are file-backed and read directly, since `readAndResolveBundleEnv` name
 * validation rejects reserved names on READ; other bundles use the normal resolver. */
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

/** Materialize a worker slot for a portable account from its synced durable credential (PHNX-3940
 * T6). Claude gets `.oauth_token` plus identity email; API-key harnesses get no file; per-device
 * harnesses get `per-device`. Never transports (invariant 1); fails loud with no claude token. */
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

/** True when a claude worker slot has both the identity email and the completed-onboarding flag;
 * older slots answer false so reconcile re-seeds. */
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

/** Seed a worker slot's `.claude.json` (both locations) with identity and `hasCompletedOnboarding`,
 * since no human can finish first-run onboarding on a worker. Without an email only the flag is
 * seeded (shared version home identity must not be rewritten). */
export function seedClaudeWorkerHomeIdentity(versionHome: string, email?: string): void {
  const trimmed = email?.trim() || undefined;
  // A version home usually links `.claude/.claude.json -> ../.claude.json`. The
  // temp-write + rename below would replace that link with a regular file and
  // split one config into two, so write through a link to the file it names.
  const targets = new Set<string>();
  for (const p of [
    path.join(versionHome, '.claude', '.claude.json'),
    path.join(versionHome, '.claude.json'),
  ]) {
    let target = p;
    try {
      if (fs.lstatSync(p).isSymbolicLink()) target = path.resolve(path.dirname(p), fs.readlinkSync(p));
    } catch {
      // Missing: written fresh below.
    }
    targets.add(target);
  }
  for (const p of targets) {
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
    if (doc.hasCompletedOnboarding === true && (!trimmed || existing.emailAddress === trimmed)) continue;
    if (trimmed) doc.oauthAccount = { ...existing, emailAddress: trimmed };
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
