/** Read-only Arc profile/Space discovery from Arc's native metadata. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ArcSpace {
  /** Stable UUID used for every native operation. */
  id: string;
  /** Display-only title. */
  title: string;
}

export interface ArcProfile {
  /** Arc's profile directory basename: the stable profile identity. */
  profileId: string;
  /** Display-only profile name from Local State. */
  displayName: string;
  spaces: ArcSpace[];
}

export type ArcDiscoveryResult =
  | { ok: true; profiles: ArcProfile[]; userDataDir: string }
  | { ok: false; kind: 'unsupported' | 'not-installed' | 'invalid'; reason: string };

interface SidebarSpace {
  id: string;
  title: string;
  profileId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Arc's application-support root on this Mac. Arc keeps its Chromium `Local
 * State` under `<root>/User Data/` and its own sidebar model (Spaces and their
 * profile bindings) at `<root>/StorableSidebar.json` — two different levels,
 * so discovery is rooted here rather than at the Chromium user-data dir.
 * `AGENTS_ARC_DIR` points tests and non-default installs at another root.
 */
export function arcSupportDir(): string | undefined {
  const override = process.env.AGENTS_ARC_DIR;
  if (override) return path.resolve(override);
  if (process.platform !== 'darwin') return undefined;
  return path.join(os.homedir(), 'Library', 'Application Support', 'Arc');
}

export function parseLocalStateProfiles(
  localStatePath: string,
): Map<string, string> | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (error) {
    return {
      error: error instanceof SyntaxError
        ? 'Arc Local State is not valid JSON'
        : `Cannot read Arc Local State: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.profile) || !isRecord(parsed.profile.info_cache)) {
    return { error: 'Arc Local State has no profile.info_cache map' };
  }

  const profiles = new Map<string, string>();
  for (const [profileId, value] of Object.entries(parsed.profile.info_cache)) {
    if (profileId === '__ARC_SYSTEM_PROFILE') continue;
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
      return { error: `Arc Local State profile ${JSON.stringify(profileId)} has no non-empty name` };
    }
    profiles.set(profileId, value.name);
  }
  return profiles;
}

function parseProfileId(value: unknown, spaceId: string): string | { error: string } {
  if (!isRecord(value)) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has no profile mapping` };
  }
  if (value.default === true && value.custom === undefined) return 'Default';
  if (!isRecord(value.custom)) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has an unknown profile mapping` };
  }
  const entries = Object.values(value.custom);
  if (entries.length !== 1 || !isRecord(entries[0])) {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has an ambiguous custom profile mapping` };
  }
  const profileId = entries[0].directoryBasename;
  if (typeof profileId !== 'string' || profileId.trim() === '') {
    return { error: `Arc Space ${JSON.stringify(spaceId)} has no custom profile id` };
  }
  return profileId;
}

export function parseSidebarSpaces(
  sidebarPath: string,
): SidebarSpace[] | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(sidebarPath, 'utf8'));
  } catch (error) {
    return {
      error: error instanceof SyntaxError
        ? 'Arc StorableSidebar.json is not valid JSON'
        : `Cannot read Arc StorableSidebar.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    const version = isRecord(parsed) ? parsed.version : undefined;
    return { error: `Unsupported StorableSidebar version: ${String(version)}` };
  }
  if (!isRecord(parsed.sidebar) || !Array.isArray(parsed.sidebar.containers)) {
    return { error: 'StorableSidebar.json has no sidebar.containers array' };
  }

  const spaces: SidebarSpace[] = [];
  const ids = new Set<string>();
  for (const container of parsed.sidebar.containers) {
    if (!isRecord(container) || container.spaces === undefined) continue;
    if (!Array.isArray(container.spaces) || container.spaces.length % 2 !== 0) {
      return { error: 'StorableSidebar.json contains a malformed alternating spaces array' };
    }
    for (let i = 0; i < container.spaces.length; i += 2) {
      const encodedId = container.spaces[i];
      const value = container.spaces[i + 1];
      if (typeof encodedId !== 'string' || !isRecord(value)) {
        return { error: `StorableSidebar.json contains a malformed Space at index ${i}` };
      }
      if (typeof value.id !== 'string' || value.id !== encodedId) {
        return { error: `Arc Space key ${JSON.stringify(encodedId)} does not match its stable id` };
      }
      if (typeof value.title !== 'string') {
        return { error: `Arc Space ${JSON.stringify(encodedId)} has no title` };
      }
      if (ids.has(encodedId)) {
        return { error: `Arc Space ${JSON.stringify(encodedId)} appears more than once` };
      }
      const profileId = parseProfileId(value.profile, encodedId);
      if (typeof profileId !== 'string') return profileId;
      ids.add(encodedId);
      spaces.push({ id: encodedId, title: value.title, profileId });
    }
  }
  return spaces;
}

export function discoverArcProfilesAt(arcDir: string): ArcDiscoveryResult {
  const userDataDir = path.join(arcDir, 'User Data');
  if (!fs.existsSync(userDataDir)) {
    return { ok: false, kind: 'not-installed', reason: `Arc user data directory not found: ${userDataDir}` };
  }
  const profileNames = parseLocalStateProfiles(path.join(userDataDir, 'Local State'));
  if ('error' in profileNames) return { ok: false, kind: 'invalid', reason: profileNames.error };
  if (profileNames.size === 0) {
    return { ok: false, kind: 'invalid', reason: 'No Arc profiles found in Local State' };
  }
  const spaces = parseSidebarSpaces(path.join(arcDir, 'StorableSidebar.json'));
  if ('error' in spaces) return { ok: false, kind: 'invalid', reason: spaces.error };

  const profiles = new Map<string, ArcProfile>();
  for (const [profileId, displayName] of profileNames) {
    profiles.set(profileId, { profileId, displayName, spaces: [] });
  }
  for (const space of spaces) {
    const profile = profiles.get(space.profileId);
    if (!profile) {
      return {
        ok: false,
        kind: 'invalid',
        reason: `Arc Space ${JSON.stringify(space.id)} maps to unknown profile ${JSON.stringify(space.profileId)}`,
      };
    }
    profile.spaces.push({ id: space.id, title: space.title });
  }
  return { ok: true, profiles: [...profiles.values()], userDataDir };
}

export function discoverArcProfiles(): ArcDiscoveryResult {
  const arcDir = arcSupportDir();
  if (!arcDir) {
    return { ok: false, kind: 'unsupported', reason: 'Arc is not supported on this platform' };
  }
  return discoverArcProfilesAt(arcDir);
}

/** One Arc Space, flattened with the Arc profile it belongs to. */
export interface ArcSpaceProfile {
  /** The agents-cli profile name: `arc-<space-title-slug>`. */
  name: string;
  profileId: string;
  profileName: string;
  spaceId: string;
  spaceTitle: string;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Flatten discovery into one agents-cli profile per Space (the concept agents
 * already know), named `arc-<space-title>`. Two Spaces with the same title get
 * the first six characters of their stable Space id appended, so the names
 * stay distinct without inventing a second selector.
 */
export function arcSpaceProfiles(result: ArcDiscoveryResult): ArcSpaceProfile[] {
  if (!result.ok) return [];
  const flat: ArcSpaceProfile[] = [];
  for (const profile of result.profiles) {
    for (const space of profile.spaces) {
      flat.push({
        name: `arc-${slugify(space.title) || 'space'}`,
        profileId: profile.profileId,
        profileName: profile.displayName,
        spaceId: space.id,
        spaceTitle: space.title,
      });
    }
  }
  const counts = new Map<string, number>();
  for (const entry of flat) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return flat.map((entry) =>
    (counts.get(entry.name) ?? 0) > 1
      ? { ...entry, name: `${entry.name}-${slugify(entry.spaceId).slice(0, 6)}` }
      : entry,
  );
}
