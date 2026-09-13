/**
 * Best-effort login-state detection for browser profiles.
 *
 * Reads a profile's Chromium cookie store (presence only — never decrypts the
 * Keychain-encrypted values) to tell which login-gated services have a live
 * session in that profile. Powers the `agents browser start` guardrail (warn
 * when an agent opens a logged-out profile for a login-gated URL) and the
 * `agents browser profiles logins` view.
 *
 * Everything here is advisory: any failure (missing DB, locked file, unknown
 * schema) degrades to "no known session" and NEVER throws to callers — browser
 * start must not slow down or break because cookie inspection hiccuped.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import { getBrowserRuntimeDir, listProfiles } from './profiles.js';

/** A login-gated service signature: host substrings + the auth-cookie names
 *  whose presence indicates a live session, plus optional login metadata. */
interface ServiceSignature {
  hosts: string[];
  cookies: string[];
  /**
   * Where an interactive login for this service starts, and the bundle key
   * PREFIX its credentials live under. By convention a profile's `--secrets`
   * bundle holds `<PREFIX>_USERNAME` / `<PREFIX>_PASSWORD` (see
   * `credKeysForService`). The prefix is explicit — never string-munged from the
   * service id — so e.g. `x` → `X`, `google` → `GOOGLE`.
   */
  login?: { loginUrl: string; keyPrefix: string };
}

/**
 * Known login-gated services. Presence of ANY listed cookie on a matching host
 * (unexpired, or a session cookie) = logged in. Deliberately conservative: a
 * service absent from this map simply never triggers a warning — we do not
 * guess. Each cookie name here is the definitive authenticated-session token for
 * that service (e.g. LinkedIn's `li_at` is only set for a signed-in member;
 * visitor cookies like `bcookie`/`JSESSIONID` are NOT auth). Services whose
 * session is not reliably expressed as a recognizable cookie (e.g. Attio, whose
 * only same-site cookies are third-party analytics) are deliberately omitted so
 * we never emit a false "logged out" warning. Extend as needed.
 */
export const AUTH_SIGNATURES: Record<string, ServiceSignature> = {
  linkedin: {
    hosts: ['linkedin.com'],
    cookies: ['li_at'],
    login: { loginUrl: 'https://www.linkedin.com/login', keyPrefix: 'LINKEDIN' },
  },
  google: {
    hosts: ['google.com'],
    cookies: ['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
    login: { loginUrl: 'https://accounts.google.com/', keyPrefix: 'GOOGLE' },
  },
  x: {
    hosts: ['x.com', 'twitter.com'],
    cookies: ['auth_token'],
    login: { loginUrl: 'https://x.com/login', keyPrefix: 'X' },
  },
  reddit: {
    hosts: ['reddit.com'],
    cookies: ['reddit_session', 'token_v2'],
    login: { loginUrl: 'https://www.reddit.com/login', keyPrefix: 'REDDIT' },
  },
  github: {
    hosts: ['github.com'],
    cookies: ['user_session'],
    login: { loginUrl: 'https://github.com/login', keyPrefix: 'GITHUB' },
  },
};

/**
 * The bundle keys a profile's `--secrets` bundle should hold to log into
 * `service`: `<PREFIX>_USERNAME` / `<PREFIX>_PASSWORD`. Null for services with no
 * login metadata. Feed a resolved value to the page with
 * `agents browser type <ref> --secret <bundle>/<KEY>` (never printed).
 */
export function credKeysForService(service: string): { user: string; pass: string } | null {
  const login = AUTH_SIGNATURES[service]?.login;
  if (!login) return null;
  return { user: `${login.keyPrefix}_USERNAME`, pass: `${login.keyPrefix}_PASSWORD` };
}

/** The interactive login URL for a service, or null. */
export function loginUrlForService(service: string): string | null {
  return AUTH_SIGNATURES[service]?.login?.loginUrl ?? null;
}

interface CookieRow {
  host_key: string;
  name: string;
}

/**
 * Current time as microseconds since 1601-01-01 (Chromium's `expires_utc`
 * epoch), as a BigInt. Chromium expiries routinely exceed 2^53, so this is
 * bound into SQL as a BigInt and the comparison happens IN SQLite — the huge
 * integer never marshals back to JS (node:sqlite throws RangeError if it does).
 * 11644473600000 = ms between 1601-01-01 and 1970-01-01.
 */
function chromeNowMicrosBigInt(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 1000n;
}

function hostMatches(hostKey: string, host: string): boolean {
  return hostKey === host || hostKey === '.' + host || hostKey.endsWith('.' + host);
}

/**
 * Pure core: given a profile's (already expiry-filtered) cookie rows, return the
 * services with a live session. Exported for direct unit testing without disk.
 */
export function detectServices(rows: CookieRow[]): string[] {
  const services: string[] = [];
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    const found = rows.some(
      (r) => sig.cookies.includes(r.name) && sig.hosts.some((h) => hostMatches(r.host_key, h))
    );
    if (found) services.push(service);
  }
  return services;
}

/** Map a URL to a known login-gated service key, or null. */
export function serviceForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  for (const [service, sig] of Object.entries(AUTH_SIGNATURES)) {
    if (sig.hosts.some((h) => host === h || host.endsWith('.' + h))) return service;
  }
  return null;
}

/**
 * Locate candidate Chromium DBs for a profile at the given relative paths. The
 * live runtime dir is keyed by the composite `<profile>@<endpoint>` name, so we
 * scan the browser cache root for `<profile>` and `<profile>@*` dirs and return
 * every matching DB found, most-recently-modified first.
 */
function profileDbCandidates(profileName: string, relPaths: string[][]): string[] {
  const root = getBrowserRuntimeDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e === profileName || e.startsWith(profileName + '@'));
  const found: { p: string; mtime: number }[] = [];
  for (const d of dirs) {
    for (const rel of relPaths) {
      const p = path.join(root, d, ...rel);
      try {
        found.push({ p, mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* not present */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map((f) => f.p);
}

function cookieDbCandidates(profileName: string): string[] {
  return profileDbCandidates(profileName, [
    ['chrome-data', 'Default', 'Cookies'],
    ['chrome-data', 'Default', 'Network', 'Cookies'],
  ]);
}

function loginDbCandidates(profileName: string): string[] {
  return profileDbCandidates(profileName, [['chrome-data', 'Default', 'Login Data']]);
}

/**
 * Open a Chromium SQLite store safely: copy the DB (and any WAL/SHM sidecars) to
 * a temp dir first so a running browser's lock never blocks us and we never
 * touch the live file, run `fn`, then clean up. Returns `fallback` on any error.
 */
function withCopiedDb<T>(dbPath: string, fn: (db: InstanceType<typeof Database>) => T, fallback: T): T {
  let tmpDir: string | null = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browserdb-'));
    const tmpDb = path.join(tmpDir, 'db');
    fs.copyFileSync(dbPath, tmpDb);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, tmpDb + suffix);
    }
    const db = new Database(tmpDb);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } catch {
    return fallback;
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }
}

/** Read (expiry-filtered) cookie rows from a Chromium cookie DB. [] on failure. */
function readCookieRows(dbPath: string): CookieRow[] {
  return withCopiedDb(
    dbPath,
    (db) => {
      // Filter expiry in SQL (session cookies have expires_utc = 0; otherwise it
      // must be in the future) and select only text columns, so the huge
      // microsecond integer never crosses into JS.
      const rows = db
        .prepare('SELECT host_key, name FROM cookies WHERE expires_utc = 0 OR expires_utc > ?')
        .all(chromeNowMicrosBigInt()) as Array<{ host_key: unknown; name: unknown }>;
      return rows.map((r) => ({
        host_key: String(r.host_key ?? ''),
        name: String(r.name ?? ''),
      }));
    },
    [] as CookieRow[],
  );
}

/** A saved-login row from Chromium `Login Data` (username plaintext; password
 *  encrypted and never read). */
interface LoginRow {
  origin_url: string;
  username_value: string;
  signon_realm: string;
}

/** Read saved-login rows from a Chromium `Login Data` DB. Skips
 *  user-blacklisted origins ("never save"). Selects only text columns —
 *  `password_value` (encrypted) is never touched. [] on failure. */
function readLoginRows(dbPath: string): LoginRow[] {
  return withCopiedDb(
    dbPath,
    (db) => {
      const rows = db
        .prepare(
          'SELECT origin_url, username_value, signon_realm FROM logins WHERE blacklisted_by_user = 0',
        )
        .all() as Array<{ origin_url: unknown; username_value: unknown; signon_realm: unknown }>;
      return rows.map((r) => ({
        origin_url: String(r.origin_url ?? ''),
        username_value: String(r.username_value ?? ''),
        signon_realm: String(r.signon_realm ?? ''),
      }));
    },
    [] as LoginRow[],
  );
}

/**
 * Map a profile's saved logins to service → account username (identity, not
 * session). Best-effort; `{}` if `Login Data` is unreadable. The first non-empty
 * username per service wins.
 */
export async function accountsForProfile(profileName: string): Promise<Record<string, string>> {
  const candidates = loginDbCandidates(profileName);
  if (candidates.length === 0) return {};
  const rows = readLoginRows(candidates[0]);
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.username_value) continue;
    const service = serviceForUrl(r.origin_url) ?? serviceForUrl(r.signon_realm);
    if (service && !out[service]) out[service] = r.username_value;
  }
  return out;
}

/**
 * For each service with a LIVE session in the profile (cookie-gated), the
 * account it is signed in as (from saved logins). Intersecting with live
 * sessions means a stale saved-login for a service you've since logged out of
 * never shows.
 */
export async function loginsWithAccountsForProfile(
  profileName: string,
): Promise<Array<{ service: string; username?: string }>> {
  const active = await loginsForProfile(profileName);
  if (active.length === 0) return [];
  const accounts = await accountsForProfile(profileName);
  return active.map((service) => ({ service, username: accounts[service] }));
}

/** Services with a live session in the given profile (best-effort; [] if none
 *  detected or the cookie store is unreadable). */
export async function loginsForProfile(profileName: string): Promise<string[]> {
  const candidates = cookieDbCandidates(profileName);
  if (candidates.length === 0) return [];
  const rows = readCookieRows(candidates[0]);
  if (rows.length === 0) return [];
  return detectServices(rows);
}

/** Profile names that have a live session for the given service. */
export async function profilesLoggedInto(service: string): Promise<string[]> {
  const profiles = await listProfiles();
  const out: string[] = [];
  for (const p of profiles) {
    const logins = await loginsForProfile(p.name);
    if (logins.includes(service)) out.push(p.name);
  }
  return out;
}
