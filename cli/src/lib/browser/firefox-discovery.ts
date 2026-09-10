/**
 * Read-only Firefox profile discovery from `profiles.ini` (PHNX-4043).
 *
 * One agents-cli profile per `[ProfileN]` entry, named `firefox-<name-slug>`
 * and pinned to that entry's directory. The profile already carries its
 * cookies and logins, so it IS the browser profile agents pick with
 * `--profile` — the same shape Arc Space discovery uses (`arc-discovery.ts`).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FirefoxIniProfile {
  /** `Name=` of the `[ProfileN]` section. */
  name: string;
  /** Absolute profile directory (`Path=` resolved against the ini's dir when `IsRelative=1`). */
  dir: string;
  /** `Default=1` on the entry (a legacy marker; `[Install*]` sections carry the real one). */
  isDefault: boolean;
  /** The `profiles.ini` this entry came from. */
  iniPath: string;
}

export type FirefoxDiscoveryResult =
  | { ok: true; profiles: FirefoxIniProfile[]; iniPaths: string[] }
  | { ok: false; kind: 'not-installed' | 'invalid'; reason: string };

/**
 * Every directory a `profiles.ini` may live in on this machine. Ubuntu's snap
 * Firefox keeps its whole `.mozilla` under `~/snap/firefox/common/`, a deb or
 * tarball Firefox uses `~/.mozilla/firefox/` — a box can carry both, so both
 * are read. `AGENTS_FIREFOX_DIRS` (path-separator list) points tests and
 * non-default installs elsewhere.
 */
export function firefoxProfileRoots(): string[] {
  const override = process.env.AGENTS_FIREFOX_DIRS;
  if (override) return override.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Firefox')];
    case 'win32':
      return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')];
    default:
      return [
        path.join(home, '.mozilla', 'firefox'),
        path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
      ];
  }
}

/**
 * Parse one `profiles.ini`. Only `[Profile<n>]` sections are profiles;
 * `[General]` and `[Install<hash>]` (which record the per-install default) are
 * skipped. A `[Profile]` section that lacks `Name` or `Path` is a malformed
 * file, not a profile to guess at.
 */
export function parseProfilesIni(iniPath: string): FirefoxIniProfile[] | { error: string } {
  let text: string;
  try {
    text = fs.readFileSync(iniPath, 'utf8');
  } catch (error) {
    return { error: `Cannot read ${iniPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const root = path.dirname(iniPath);
  const sections: Array<{ header: string; values: Record<string, string> }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      sections.push({ header: header[1], values: {} });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || sections.length === 0) {
      return { error: `${iniPath} has a malformed line: ${JSON.stringify(raw)}` };
    }
    sections[sections.length - 1].values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }

  const profiles: FirefoxIniProfile[] = [];
  for (const section of sections) {
    if (!/^Profile\d+$/.test(section.header)) continue;
    const name = section.values.Name;
    const rel = section.values.Path;
    if (!name || !rel) {
      return { error: `${iniPath} [${section.header}] has no Name or Path` };
    }
    const isRelative = section.values.IsRelative !== '0';
    const dir = isRelative ? path.resolve(root, rel) : path.resolve(rel);
    profiles.push({ name, dir, isDefault: section.values.Default === '1', iniPath });
  }
  return profiles;
}

export function discoverFirefoxProfilesAt(roots: string[]): FirefoxDiscoveryResult {
  const iniPaths = roots.map((root) => path.join(root, 'profiles.ini')).filter((p) => fs.existsSync(p));
  if (iniPaths.length === 0) {
    return {
      ok: false,
      kind: 'not-installed',
      reason: `No Firefox profiles.ini under ${roots.join(', ')}`,
    };
  }
  const profiles: FirefoxIniProfile[] = [];
  for (const iniPath of iniPaths) {
    const parsed = parseProfilesIni(iniPath);
    if ('error' in parsed) return { ok: false, kind: 'invalid', reason: parsed.error };
    profiles.push(...parsed);
  }
  if (profiles.length === 0) {
    return { ok: false, kind: 'invalid', reason: `No [Profile] entries in ${iniPaths.join(', ')}` };
  }
  return { ok: true, profiles, iniPaths };
}

export function discoverFirefoxProfiles(): FirefoxDiscoveryResult {
  return discoverFirefoxProfilesAt(firefoxProfileRoots());
}

/** One discovered Firefox profile as an agents-cli profile row. */
export interface FirefoxDiscoveredProfile {
  /** The agents-cli profile name: `firefox-<name-slug>`. */
  name: string;
  profileName: string;
  profileDir: string;
  iniPath: string;
  isDefault: boolean;
  /** The local WebDriver BiDi port this profile is pinned to. */
  port: number;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** FNV-1a over the path, folded into the range. Stable across runs and daemons. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Firefox BiDi ports live in their own range so they never collide with the 9222-9399 CDP profiles. */
export const FIREFOX_PORT_RANGE = Object.freeze({ base: 9600, size: 100 });

/**
 * The port a discovered Firefox profile listens on: derived from its directory,
 * so the relaunch hint in an attach error is the same string every time and a
 * daemon restart reattaches to the Firefox it launched earlier. Collisions
 * between two discovered profiles resolve by linear probing within the range.
 */
export function firefoxProfilePort(profileDir: string, taken: Set<number> = new Set()): number {
  const { base, size } = FIREFOX_PORT_RANGE;
  let port = base + (stableHash(profileDir) % size);
  for (let i = 0; i < size && taken.has(port); i++) {
    port = base + ((port - base + 1) % size);
  }
  return port;
}

/**
 * Flatten discovery into one agents-cli profile per `profiles.ini` entry, named
 * `firefox-<name>` (`firefox-default`, `firefox-default-release`, …). Two
 * entries with the same name (one per ini, say) get the first six hex
 * characters of their directory hash appended so the names stay distinct.
 */
export function firefoxDiscoveredProfiles(result: FirefoxDiscoveryResult): FirefoxDiscoveredProfile[] {
  if (!result.ok) return [];
  const taken = new Set<number>();
  const flat: FirefoxDiscoveredProfile[] = result.profiles.map((profile) => {
    const port = firefoxProfilePort(profile.dir, taken);
    taken.add(port);
    return {
      name: `firefox-${slugify(profile.name) || 'profile'}`,
      profileName: profile.name,
      profileDir: profile.dir,
      iniPath: profile.iniPath,
      isDefault: profile.isDefault,
      port,
    };
  });
  const counts = new Map<string, number>();
  for (const entry of flat) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return flat.map((entry) =>
    (counts.get(entry.name) ?? 0) > 1
      ? { ...entry, name: `${entry.name}-${stableHash(entry.profileDir).toString(16).padStart(8, '0').slice(0, 6)}` }
      : entry,
  );
}
