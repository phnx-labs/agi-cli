/**
 * Auth persistence across version switches (RUSH-1318): droid/antigravity/kimi
 * store login as files inside the per-version config home. Switching versions
 * repoints the ~/.<config> symlink to a home that was never logged in, silently
 * logging the CLI out. carryForwardAuthFiles seeds the target home with the
 * freshest credential; getAccountInfo falls back to the active HOME config so
 * non-active versions still report the account-global sign-in state.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TEST_VERSIONS_DIR = '';
let TEST_BACKUPS_DIR = '';

vi.mock('../state.js', async () => {
  const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
  return {
    ...actual,
    getVersionsDir: () => TEST_VERSIONS_DIR,
    getBackupsDir: () => TEST_BACKUPS_DIR,
    ensureAgentsDir: () => {},
  };
});

import { switchConfigSymlink, carryForwardAuthFiles, readAuthFileIdentity } from './shims.js';
import { getAccountInfo } from '../agents.js';
import { addNativeAccount, removeAccount } from '../account-registry.js';
import { recordSlot, slotDir } from '../accounts/slots.js';

const tempDirs: string[] = [];

function makeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-carry-'));
  tempDirs.push(root);
  TEST_VERSIONS_DIR = path.join(root, '.agents', 'versions');
  TEST_BACKUPS_DIR = path.join(root, '.agents', 'backups');
  fs.mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  process.env.AGENTS_REAL_HOME = root;
  return root;
}

function droidHome(v: string): string {
  const h = path.join(TEST_VERSIONS_DIR, 'droid', v, 'home');
  fs.mkdirSync(path.join(h, '.factory'), { recursive: true });
  return h;
}

function writeDroidAuth(home: string, body: string, mtimeMs?: number): void {
  const dir = path.join(home, '.factory');
  fs.writeFileSync(path.join(dir, 'auth.v2.file'), body, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'auth.v2.key'), 'KEY', { mode: 0o600 });
  if (mtimeMs) {
    const t = new Date(mtimeMs);
    fs.utimesSync(path.join(dir, 'auth.v2.file'), t, t);
    fs.utimesSync(path.join(dir, 'auth.v2.key'), t, t);
  }
}

/** Minimal JWT — only the payload segment is ever decoded (matches agents.ts). */
function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

/**
 * Write a Droid credential the REAL way: a JSON blob carrying a WorkOS
 * access-token JWT, encrypted AES-256-GCM as `ivB64:tagB64:ctB64`, keyed by the
 * base64 contents of auth.v2.key (identical to agents.test.ts writeDroidCredential
 * and to what the CLI writes). Identity derives from the JWT's email/org/sub, so
 * the guard sees the account through the same decrypt path production uses.
 * Returns the exact ciphertext written so callers can assert byte-equality after
 * a carry. `.key` is per-account (a fresh random key) so a foreign source can
 * never be decrypted with the destination account's key — exactly production.
 */
function writeDroidCred(
  home: string,
  claims: Record<string, unknown>,
  mtimeMs: number,
): string {
  const dir = path.join(home, '.factory');
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const credential = JSON.stringify({
    access_token: makeJwt(claims),
    refresh_token: 'rt',
    active_organization_id: (claims.org_id as string) ?? null,
  });
  const ct = Buffer.concat([cipher.update(credential, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = [iv, tag, ct].map(b => b.toString('base64')).join(':');
  fs.writeFileSync(path.join(dir, 'auth.v2.file'), blob, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'auth.v2.key'), key.toString('base64'), { mode: 0o600 });
  const t = new Date(mtimeMs);
  fs.utimesSync(path.join(dir, 'auth.v2.file'), t, t);
  fs.utimesSync(path.join(dir, 'auth.v2.key'), t, t);
  return blob;
}

/** Kimi credential dir (~/.kimi-code) — exact JSON shape from agents.test.ts. */
function writeKimiCred(home: string, userId: string, mtimeMs: number): void {
  const dir = path.join(TEST_VERSIONS_DIR, 'kimi', home, 'home', '.kimi-code', 'credentials');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kimi-code.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      access_token: makeJwt({ user_id: userId, sub: userId, scope: 'kimi-code' }),
      refresh_token: makeJwt({ type: 'refresh' }),
      token_type: 'Bearer',
    }),
    { mode: 0o600 },
  );
  const t = new Date(mtimeMs);
  fs.utimesSync(file, t, t);
}

/** Antigravity token dir (~/.gemini/antigravity-cli) — { token: { refresh_token } }. */
function writeAntigravityCred(home: string, refreshToken: string, mtimeMs: number): void {
  const dir = path.join(TEST_VERSIONS_DIR, 'antigravity', home, 'home', '.gemini', 'antigravity-cli');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'antigravity-oauth-token');
  fs.writeFileSync(
    file,
    JSON.stringify({ token: { access_token: 'ya29.x', refresh_token: refreshToken, token_type: 'Bearer' } }),
    { mode: 0o600 },
  );
  const t = new Date(mtimeMs);
  fs.utimesSync(file, t, t);
}

afterEach(() => {
  delete process.env.AGENTS_REAL_HOME;
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('carryForwardAuthFiles — account-identity guard (RUSH-1764)', () => {
  beforeEach(() => { makeHome(); });

  it('droid: does NOT carry a NEWER foreign-account credential over an existing login', () => {
    const v1 = droidHome('latest');    // foreign account B, newer mtime
    const v2 = droidHome('0.159.1');   // active account A, older mtime
    // REAL AES-256-GCM credential with a distinct per-account key — a foreign
    // source can't even be decrypted with account A's key (identity mismatch).
    const blobA = writeDroidCred(v2, { email: 'a@x.com', org_id: 'orgA' }, 1_000_000);
    writeDroidCred(v1, { email: 'b@x.com', org_id: 'orgB' }, 2_000_000);

    carryForwardAuthFiles('droid', path.join(v2, '.factory'));

    // Account B's newer file must NOT have replaced account A's login — the
    // ciphertext AND the key are still account A's, so the login stays intact.
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe(blobA);
  });

  it('droid: DOES carry a newer refreshed credential for the SAME account', () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1');
    writeDroidCred(v2, { email: 'a@x.com', org_id: 'orgA' }, 1_000_000);
    const refreshed = writeDroidCred(v1, { email: 'a@x.com', org_id: 'orgA' }, 2_000_000);

    carryForwardAuthFiles('droid', path.join(v2, '.factory'));

    // Same email+org -> same identity -> the newer refreshed blob is carried.
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe(refreshed);
  });

  it('droid: seeds an EMPTY target from the freshest source (no identity to protect yet)', () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1'); // no auth files written -> empty target
    const blobA = writeDroidCred(v1, { email: 'a@x.com', org_id: 'orgA' }, 2_000_000);

    carryForwardAuthFiles('droid', path.join(v2, '.factory'));

    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe(blobA);
  });

  it('kimi: does NOT carry a NEWER foreign-account credential over an existing login', () => {
    writeKimiCred('0.159.1', 'USER_A', 1_000_000); // active account A, older
    writeKimiCred('latest', 'USER_B', 2_000_000);  // foreign account B, newer
    const destDir = path.join(TEST_VERSIONS_DIR, 'kimi', '0.159.1', 'home', '.kimi-code');

    carryForwardAuthFiles('kimi', destDir);

    const body = JSON.parse(fs.readFileSync(path.join(destDir, 'credentials', 'kimi-code.json'), 'utf8'));
    const payload = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString());
    expect(payload.user_id).toBe('USER_A'); // account B's newer file was refused
  });

  it('antigravity: does NOT carry a NEWER foreign-account token over an existing login', () => {
    writeAntigravityCred('1.0.12', 'REFRESH_A', 1_000_000); // active account A, older
    writeAntigravityCred('1.0.13', 'REFRESH_B', 2_000_000); // foreign account B, newer
    const destDir = path.join(TEST_VERSIONS_DIR, 'antigravity', '1.0.12', 'home', '.gemini', 'antigravity-cli');

    carryForwardAuthFiles('antigravity', destDir);

    const body = JSON.parse(fs.readFileSync(path.join(destDir, 'antigravity-oauth-token'), 'utf8'));
    expect(body.token.refresh_token).toBe('REFRESH_A'); // account B's newer token was refused
  });

  it('is a no-op once the harness has adopted an account slot — credentials are account-owned (PHNX-3940)', () => {
    // With no slot, an empty target is seeded from the freshest source (the
    // `seeds an EMPTY target` case above). Once this harness owns a materialized
    // slot, that version-home carry must stop entirely: switching a binary must
    // never refresh version-owned auth again.
    const v1 = droidHome('latest');    // a freshest source that WOULD be carried
    const v2 = droidHome('0.159.1');   // empty target
    writeDroidCred(v1, { email: 'a@x.com', org_id: 'orgA' }, 2_000_000);

    const acct = addNativeAccount(`carry-gate-${Date.now().toString(36)}`, 'droid', `droid:user=carry-${Date.now().toString(36)}`, 'a@x.com', 'version');
    try {
      const dir = slotDir('droid', acct.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
      recordSlot(acct.id, { accountId: acct.id, slotDir: dir, authMode: 'per-device', verdict: 'unconfigured' });

      carryForwardAuthFiles('droid', path.join(v2, '.factory'));

      // The empty target stayed empty — the adopted slot short-circuited the carry.
      expect(fs.existsSync(path.join(v2, '.factory', 'auth.v2.file'))).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      removeAccount(`droid#${acct.name}`);
    }
  });
});

describe('readAuthFileIdentity — decodes each agent REAL format', () => {
  beforeEach(() => { makeHome(); });

  it('returns null for a missing dir and an undecryptable droid credential', () => {
    const v = droidHome('x'); // dir exists, no auth files
    expect(readAuthFileIdentity('droid', path.join(v, '.factory'))).toBeNull();
    expect(readAuthFileIdentity('droid', path.join(v, 'nope'))).toBeNull();
    // Plaintext (not the AES-GCM format) can't be decrypted -> no identity.
    fs.writeFileSync(path.join(v, '.factory', 'auth.v2.file'), 'not-encrypted');
    fs.writeFileSync(path.join(v, '.factory', 'auth.v2.key'), 'KEY');
    expect(readAuthFileIdentity('droid', path.join(v, '.factory'))).toBeNull();
  });

  it('droid: equal for the SAME account (token differs), distinct for a DIFFERENT account', () => {
    const a1 = droidHome('a1');
    const a2 = droidHome('a2');
    const b = droidHome('b');
    writeDroidCred(a1, { email: 'a@x.com', org_id: 'orgA' }, 1_000_000);
    writeDroidCred(a2, { email: 'a@x.com', org_id: 'orgA' }, 2_000_000); // fresh key+token, same account
    writeDroidCred(b, { email: 'b@x.com', org_id: 'orgB' }, 1_000_000);
    const idA1 = readAuthFileIdentity('droid', path.join(a1, '.factory'));
    expect(idA1).not.toBeNull();
    expect(readAuthFileIdentity('droid', path.join(a2, '.factory'))).toBe(idA1);
    expect(readAuthFileIdentity('droid', path.join(b, '.factory'))).not.toBe(idA1);
  });

  it('kimi: identity from the access-token user_id claim', () => {
    writeKimiCred('a', 'USER_A', 1_000_000);
    writeKimiCred('b', 'USER_B', 1_000_000);
    const dirA = path.join(TEST_VERSIONS_DIR, 'kimi', 'a', 'home', '.kimi-code');
    const dirB = path.join(TEST_VERSIONS_DIR, 'kimi', 'b', 'home', '.kimi-code');
    expect(readAuthFileIdentity('kimi', dirA)).toBe('kimi:user=USER_A');
    expect(readAuthFileIdentity('kimi', dirA)).not.toBe(readAuthFileIdentity('kimi', dirB));
  });

  it('antigravity: identity from the refresh_token; null when absent', () => {
    writeAntigravityCred('a', 'REFRESH_A', 1_000_000);
    const dirA = path.join(TEST_VERSIONS_DIR, 'antigravity', 'a', 'home', '.gemini', 'antigravity-cli');
    // A non-JWT refresh token is a live credential — the identity carries its
    // SHA-256 fingerprint, never the token itself (it lands in cache keys).
    const idA = readAuthFileIdentity('antigravity', dirA);
    expect(idA).toMatch(/^antigravity:sub=[0-9a-f]{16}$/);
    expect(idA).not.toContain('REFRESH_A');
    // Distinct refresh tokens -> distinct identities.
    writeAntigravityCred('b', 'REFRESH_B', 1_000_000);
    const dirB = path.join(TEST_VERSIONS_DIR, 'antigravity', 'b', 'home', '.gemini', 'antigravity-cli');
    expect(readAuthFileIdentity('antigravity', dirB)).not.toBe(idA);
    // No refresh_token -> no identity.
    fs.writeFileSync(path.join(dirA, 'antigravity-oauth-token'), JSON.stringify({ token: {} }));
    expect(readAuthFileIdentity('antigravity', dirA)).toBeNull();
  });
});

describe('carryForwardAuthFiles / switchConfigSymlink — auth survives version switch (RUSH-1318)', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });

  it('carries droid auth.v2.file + auth.v2.key into the version being switched to, preserving 0600, leaving source intact', async () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1');
    writeDroidAuth(v1, 'LOGGED_IN_BLOB');
    // Active config symlink starts at v1 (where the user logged in).
    const link = path.join(home, '.factory');
    fs.symlinkSync(path.join(v1, '.factory'), link);

    const res = await switchConfigSymlink('droid', '0.159.1');
    expect(res.success).toBe(true);

    // v2 now has the login...
    const dst = path.join(v2, '.factory', 'auth.v2.file');
    expect(fs.existsSync(dst)).toBe(true);
    expect(fs.readFileSync(dst, 'utf8')).toBe('LOGGED_IN_BLOB');
    expect(fs.existsSync(path.join(v2, '.factory', 'auth.v2.key'))).toBe(true);
    // POSIX perms don't survive on Windows — Node reports 0o666 regardless of the
    // mode copyFileSync was given, so asserting 0o600 there tests the OS, not us.
    if (process.platform !== 'win32') {
      expect(fs.statSync(dst).mode & 0o777).toBe(0o600);
    }
    // ...and the source is untouched (copy, not move).
    expect(fs.existsSync(path.join(v1, '.factory', 'auth.v2.file'))).toBe(true);
  });

  it('overwrites an OLDER credential in the target but keeps a NEWER one', () => {
    const v1 = droidHome('latest');
    const v2 = droidHome('0.159.1');

    // Case A: v1 newer than v2 -> v2 gets overwritten with v1's blob.
    writeDroidAuth(v1, 'FRESH', 2_000_000);
    writeDroidAuth(v2, 'STALE', 1_000_000);
    carryForwardAuthFiles('droid', path.join(v2, '.factory'));
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe('FRESH');

    // Case B: target already newest -> left alone.
    writeDroidAuth(v1, 'OLDER', 1_000_000);
    writeDroidAuth(v2, 'NEWEST', 3_000_000);
    carryForwardAuthFiles('droid', path.join(v2, '.factory'));
    expect(fs.readFileSync(path.join(v2, '.factory', 'auth.v2.file'), 'utf8')).toBe('NEWEST');
  });

  it('carries antigravity nested token across a switch', async () => {
    const relDir = path.join('.gemini', 'antigravity-cli');
    const v1 = path.join(TEST_VERSIONS_DIR, 'antigravity', '1.0.13', 'home');
    const v2 = path.join(TEST_VERSIONS_DIR, 'antigravity', '1.0.12', 'home');
    fs.mkdirSync(path.join(v1, relDir), { recursive: true });
    fs.mkdirSync(path.join(v2, relDir), { recursive: true });
    fs.writeFileSync(path.join(v1, relDir, 'antigravity-oauth-token'), '{"token":{"refresh_token":"r"}}', { mode: 0o600 });
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.symlinkSync(path.join(v1, relDir), path.join(home, relDir));

    const res = await switchConfigSymlink('antigravity', '1.0.12');
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(v2, relDir, 'antigravity-oauth-token'))).toBe(true);
  });

  it('is a no-op for agents without authFiles (claude)', () => {
    const cHome = path.join(TEST_VERSIONS_DIR, 'claude', '2.1.0', 'home', '.claude');
    fs.mkdirSync(cHome, { recursive: true });
    // Must not throw and must not create any file.
    expect(() => carryForwardAuthFiles('claude', cHome)).not.toThrow();
    expect(fs.readdirSync(cHome)).toEqual([]);
  });
});

describe('getAccountInfo — non-active version reflects account-global sign-in (screenshot bug)', () => {
  let home: string;
  beforeEach(() => { home = makeHome(); });

  it('reports droid signed-in for a version whose isolated home lacks auth, via active HOME fallback', async () => {
    const v1 = droidHome('latest');     // logged-in home
    const v2 = droidHome('0.159.1');    // isolated, empty
    writeDroidAuth(v1, 'BLOB');
    // Active ~/.factory -> v1 (has auth).
    fs.symlinkSync(path.join(v1, '.factory'), path.join(home, '.factory'));

    // Querying the EMPTY v2 home still resolves signed-in via the HOME fallback.
    const info = await getAccountInfo('droid', path.join(v2));
    expect(info.signedIn).toBe(true);
  });

  it('reports not-signed-in when neither the version home nor active HOME has auth', async () => {
    const v2 = droidHome('0.159.1');
    const info = await getAccountInfo('droid', path.join(v2));
    expect(info.signedIn).toBe(false);
  });
});
