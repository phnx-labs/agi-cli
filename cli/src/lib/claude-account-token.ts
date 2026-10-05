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
  // Trust only an unambiguous, losslessly round-tripping token-key slug for identity recovery; underscore ambiguity returns null.
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
    // Wrong reserved-bundle backends must propagate instead of silently falling through to interactive credentials.
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

// Materialize only a validated durable setup-token in the worker slot; rotating OAuth credentials never copy here.
export function writeClaudeWorkerOauthToken(home: string, token: string): string {
  if (!isValidClaudeSetupToken(token)) {
    throw new Error('Refusing to write a malformed Claude setup-token to a worker slot.');
  }
  const tokenPath = path.join(home, '.claude', '.oauth_token');
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return tokenPath;
}

// Reserved stores read their file item directly; ordinary bundles retain ref, expiry, and lease resolution.
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

// Reconcile locally without transporting credentials; a durable Claude account fails loud if its synced token is absent.
export function provisionWorkerSlot(account: NativeAccountRecord): DeviceAccountSlot {
  const harness = account.agent;
  const durable = harnessWorkerKinds(harness).some(
    (kind) => kind === 'setup-token' || kind.startsWith('api-key'),
  );
  const slot = ensureSlot(harness, account.id);
  const checkedAt = new Date().toISOString();

  if (!durable) {
    // Per-device harnesses keep an explicit unconfigured slot until that worker performs its own login.
    const record: DeviceAccountSlot = { ...slot, authMode: 'per-device', verdict: 'unconfigured', checkedAt };
    recordSlot(account.id, record);
    return record;
  }

  if (harness === 'claude') {
    const cred = account.workerCredential;
    // Pre-T1 rows lack workerCredential, so retain the legacy email-keyed auth-bundle lookup.
    const token = cred
      ? readReservedCredential(cred.bundle, cred.key)
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
  // API-key harnesses intentionally materialize no file: spawn injects their credential from the reserved store.

  const record: DeviceAccountSlot = { ...slot, authMode: 'durable', verdict: 'unverified', checkedAt };
  recordSlot(account.id, record);
  return record;
}

// Provisioning is complete only when both the identity email and onboarding flag are present.
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
    }
    targets.add(target);
  }
  for (const p of targets) {
    let doc: Record<string, unknown> = {};
    try {
      doc = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      // Create a missing document, but never overwrite a malformed file that Claude may be rewriting concurrently.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    const existing = (doc.oauthAccount && typeof doc.oauthAccount === 'object'
      ? (doc.oauthAccount as Record<string, unknown>)
      : {});
    if (doc.hasCompletedOnboarding === true && (!trimmed || existing.emailAddress === trimmed)) continue;
    if (trimmed) doc.oauthAccount = { ...existing, emailAddress: trimmed };
    doc.hasCompletedOnboarding = true;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic rename prevents readers from observing a truncated identity document.
    const tmp = `${p}.agents-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, p);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch {  }
    }
  }
}
