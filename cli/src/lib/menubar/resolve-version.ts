/** Chooses which menu-bar helper build to install: the newest published release at or above this
 * CLI's floor, so the helper auto-updates. Only `menubar/v<x.y.z>` releases with the asset AND its
 * sha256 count; cached a day, floor is the offline answer. Download verification is unchanged. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCacheDir } from '../state.js';
import { compareVersions } from '../agent-spec/primitives.js';
import { helperFloor } from '../helper-versions.js';
import { getCliVersion } from '../version.js';
import { MENUBAR_HELPER_ASSET } from './download-menubar.js';

const MENUBAR_RELEASES_API = 'https://api.github.com/repos/phnx-labs/agi-cli/releases?per_page=100';

const MENUBAR_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseCandidate {
  tagName: string;
  assets: string[];
  draft?: boolean;
  prerelease?: boolean;
}

interface MenubarResolveCache {
  checkedAt: number;
  version: string;
}

const TAG = /^menubar\/v(\d+\.\d+\.\d+)$/;

/** Pure: the newest candidate at or above `floor`, else the floor. A tag must be exactly
 * `menubar/v<x.y.z>` (no pre-release suffix), not a draft or pre-release, with both the zip and
 * its `.sha256`. */
export function pickNewestMenubarVersion(candidates: ReleaseCandidate[], floor: string): string {
  let best = floor;
  for (const c of candidates) {
    if (c.draft || c.prerelease) continue;
    const m = TAG.exec(c.tagName);
    if (!m) continue;
    if (!c.assets.includes(MENUBAR_HELPER_ASSET) || !c.assets.includes(`${MENUBAR_HELPER_ASSET}.sha256`)) continue;
    if (compareVersions(m[1], best) > 0) best = m[1];
  }
  return best;
}

function menubarResolveCachePath(): string {
  return path.join(getCacheDir(), 'menubar', 'latest.json');
}

export function readMenubarResolveCache(file: string): MenubarResolveCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<MenubarResolveCache>;
    if (typeof parsed.checkedAt === 'number' && typeof parsed.version === 'string' && /^\d+\.\d+\.\d+$/.test(parsed.version)) {
      return { checkedAt: parsed.checkedAt, version: parsed.version };
    }
  } catch {  }
  return null;
}

function writeMenubarResolveCache(file: string, cache: MenubarResolveCache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {  }
}

/** The cached answer when usable offline: at or above the floor, of any age. Sync and network-free;
 * read by the startup self-heal and status/doctor displays. */
export function cachedMenubarVersion(opts: { floor?: string; cacheFile?: string } = {}): string {
  const floor = opts.floor ?? helperFloor('menubar');
  const cache = readMenubarResolveCache(opts.cacheFile ?? menubarResolveCachePath());
  return cache && compareVersions(cache.version, floor) >= 0 ? cache.version : floor;
}

type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>;
}>;

async function fetchMenubarReleaseCandidates(fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<ReleaseCandidate[]> {
  const res = await fetchImpl(MENUBAR_RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `agents-cli/${getCliVersion()}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`release list: HTTP ${res.status}`);
  const body = (await res.json()) as Array<{ tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: string }> }>;
  if (!Array.isArray(body)) throw new Error('release list: not an array');
  return body.map((r) => ({
    tagName: r.tag_name ?? '',
    draft: r.draft,
    prerelease: r.prerelease,
    assets: (r.assets ?? []).map((a) => a.name ?? ''),
  }));
}

/** The helper version to install now: newest published build >= floor. Reads the day-old cache
 * first; re-reads the release list when missing, stale or `force`; falls back to the cache, then
 * the floor. Never throws, never below the floor. */
export async function resolveMenubarVersion(opts: {
  floor?: string;
  cacheFile?: string;
  now?: number;
  ttlMs?: number;
  force?: boolean;
  fetchImpl?: FetchLike;
} = {}): Promise<string> {
  const floor = opts.floor ?? helperFloor('menubar');
  const file = opts.cacheFile ?? menubarResolveCachePath();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? MENUBAR_RESOLVE_TTL_MS;
  const cached = readMenubarResolveCache(file);
  if (cached && !opts.force && now - cached.checkedAt < ttl && compareVersions(cached.version, floor) >= 0) {
    return cached.version;
  }
  try {
    const version = pickNewestMenubarVersion(await fetchMenubarReleaseCandidates(opts.fetchImpl), floor);
    writeMenubarResolveCache(file, { checkedAt: now, version });
    return version;
  } catch {
    return cached && compareVersions(cached.version, floor) >= 0 ? cached.version : floor;
  }
}
