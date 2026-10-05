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

export const AUTH_BUNDLE = AUTH_STORE_ALIAS;
export { ReservedBundleWrongBackendError };

const SETUP_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]+$/;

interface SetupTokenCacheEntry {
  readAt: number;
  token: string | null;
}

const setupTokenCache = new Map<string, SetupTokenCacheEntry>();
const SETUP_TOKEN_MEMO_TTL_MS = 10_000;

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

export function isValidClaudeSetupToken(value: string): boolean {
  return SETUP_TOKEN_RE.test(value);
}

export function claudeAccountTokenKey(account: string): string {
  const slug = account
    .trim()
    .toUpperCase()
    .replace(/@/g, '_AT_')
    .replace(/\./g, '_DOT_')
    .replace(/[^A-Z0-9_]/g, '_');
  return `CLAUDE_CODE_OAUTH_TOKEN_${slug}`;
}

export function readClaudeAccountEmail(home?: string): string | null {
  const base = home ?? os.homedir();
  for (const p of [path.join(base, '.claude', '.claude.json'), path.join(base, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return email.trim();
    } catch {
    }
  }
  return null;
}

export function resolveClaudeSetupToken(home?: string): string | null {
  // Reserved auth is per-account, file-backed, and must never trigger Touch ID.
  const email = readClaudeAccountEmail(home)
    ?? (home ? discoverClaudeAccountEmailFromOauthToken(home) : null);
  if (!email) return null;
  return resolveClaudeSetupTokenForEmail(email, home ?? os.homedir());
}

const discoveryCache = new Map<string, { fingerprint: string; email: string | null }>();

function discoverClaudeAccountEmailFromOauthToken(home: string): string | null {
  // Discovery may rewrite identity only inside the explicit worker home.
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

function emailFromTokenKey(key: string): string | null {
  // Only a canonical per-email token key may reach an Authorization header.
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

export function resolveClaudeSetupTokenForEmail(email: string, cacheKey?: string): string | null {
  // Memoization includes both caller/home and account so tokens cannot cross identities.
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

export function seedClaudeWorkerHomeIdentity(versionHome: string, email?: string): void {
  // Follow an existing config symlink; replacing it would split Claude's configuration.
  const trimmed = email?.trim() || undefined;
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
