/**
 * Read-only discovery of a Chromium-family browser's OWN profiles (PHNX-4042).
 *
 * Chromium keeps its profiles under one user-data dir: `Local State` lists them
 * in `profile.info_cache` keyed by directory (`Default`, `Profile 1`, ...) with
 * the display name the user sees in the profile menu. Each entry becomes one
 * agents-cli profile (`comet-work`, ...) pinned to that dir and directory, so
 * the owner and agents share ONE window per profile instead of agents spawning
 * a rival instance under a cache dir. Nothing here writes to the browser's
 * files.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrowserType } from './types.js';

export interface ChromiumNativeProfile {
  browser: BrowserType;
  /** The agents-cli profile name: `<browser>-<display-name-slug>`. */
  name: string;
  /** The browser's user-data dir (its own, never a cache dir). */
  userDataDir: string;
  /** Profile directory basename inside the user-data dir. Authoritative id. */
  profileDirectory: string;
  /** Display-only name from Local State. */
  displayName: string;
}

export type ChromiumDiscoveryResult =
  | { ok: true; profiles: ChromiumNativeProfile[]; userDataDir: string }
  | { ok: false; kind: 'unsupported' | 'not-installed' | 'invalid'; reason: string };

/** Browsers whose native profiles are discovered, and the env var that points tests at another user-data dir. */
const NATIVE_CHROMIUM: Partial<Record<BrowserType, { dirName: string; envOverride: string }>> = {
  comet: { dirName: 'Comet', envOverride: 'AGENTS_COMET_DIR' },
};

/** The browser's own user-data dir on this platform, or undefined where it does not ship. */
export function chromiumUserDataDir(browser: BrowserType): string | undefined {
  const entry = NATIVE_CHROMIUM[browser];
  if (!entry) return undefined;
  const override = process.env[entry.envOverride];
  if (override) return path.resolve(override);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', entry.dirName);
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, entry.dirName, 'User Data');
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function discoverChromiumProfilesAt(browser: BrowserType, userDataDir: string): ChromiumDiscoveryResult {
  const localState = path.join(userDataDir, 'Local State');
  if (!fs.existsSync(localState)) {
    return { ok: false, kind: 'not-installed', reason: `${browser} Local State not found: ${localState}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(localState, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      kind: 'invalid',
      reason: error instanceof SyntaxError
        ? `${browser} Local State is not valid JSON`
        : `Cannot read ${browser} Local State: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.profile) || !isRecord(parsed.profile.info_cache)) {
    return { ok: false, kind: 'invalid', reason: `${browser} Local State has no profile.info_cache map` };
  }
  const rows: ChromiumNativeProfile[] = [];
  for (const [profileDirectory, value] of Object.entries(parsed.profile.info_cache)) {
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
      return { ok: false, kind: 'invalid', reason: `${browser} Local State profile ${JSON.stringify(profileDirectory)} has no non-empty name` };
    }
    rows.push({
      browser,
      name: `${browser}-${slugify(value.name) || 'profile'}`,
      userDataDir,
      profileDirectory,
      displayName: value.name,
    });
  }
  // Two profiles with the same display name stay distinct by their directory.
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
  return {
    ok: true,
    userDataDir,
    profiles: rows.map((row) =>
      (counts.get(row.name) ?? 0) > 1 ? { ...row, name: `${row.name}-${slugify(row.profileDirectory)}` } : row,
    ),
  };
}

export function discoverChromiumProfiles(browser: BrowserType): ChromiumDiscoveryResult {
  const userDataDir = chromiumUserDataDir(browser);
  if (!userDataDir) {
    return { ok: false, kind: 'unsupported', reason: `${browser} profiles are not discovered on this platform` };
  }
  return discoverChromiumProfilesAt(browser, userDataDir);
}

/** Every browser whose native profiles agents-cli discovers on this platform. */
export function discoverableChromiumBrowsers(): BrowserType[] {
  return (Object.keys(NATIVE_CHROMIUM) as BrowserType[]).filter((browser) => chromiumUserDataDir(browser) !== undefined);
}
