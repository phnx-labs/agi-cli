
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCacheDir } from '../state.js';
import { compareVersions } from '../agent-spec/primitives.js';
import { HELPER_RELEASE_REPO } from '../helper-download.js';
import { helperFloor } from '../helper-versions.js';
import { getCliVersion } from '../version.js';
import { menubarHelperAssetUrls } from './download-menubar.js';

// Plain github.com endpoints only: api.github.com allows 60 unauthenticated
// requests per hour per IP, and a shared IP exhausts that (PHNX-4326).
const MENUBAR_UPLOAD_PACK = `https://github.com/${HELPER_RELEASE_REPO}.git/git-upload-pack`;
const MENUBAR_TAG_REF_PREFIX = 'refs/tags/menubar/';

const MENUBAR_RESOLVE_TTL_MS = 12 * 60 * 60 * 1000;

interface MenubarResolveCache {
  checkedAt: number;
  version: string;
}

// agi-menu's release.sh marks a release --prerelease exactly when its tag has a
// -pre.N suffix, so the strict x.y.z shape is what excludes pre-releases.
const TAG = /^menubar\/v(\d+\.\d+\.\d+)$/;

function pktLine(payload: string): string {
  return (Buffer.byteLength(payload) + 4).toString(16).padStart(4, '0') + payload;
}

export const MENUBAR_LS_REFS_REQUEST = `${pktLine('command=ls-refs\n')}0001${pktLine(`ref-prefix ${MENUBAR_TAG_REF_PREFIX}\n`)}0000`;

export function parseLsRefsTags(body: Buffer): string[] {
  const tags: string[] = [];
  let at = 0;
  while (at < body.length) {
    const head = body.subarray(at, at + 4).toString('ascii');
    const len = /^[0-9a-f]{4}$/.test(head) ? Number.parseInt(head, 16) : -1;
    if (len < 0 || len === 3 || at + Math.max(len, 4) > body.length) {
      throw new Error('tag list: malformed git protocol response');
    }
    if (len === 0) return tags;
    if (len < 4) { at += 4; continue; }
    const line = body.subarray(at + 4, at + len).toString('utf8').trimEnd();
    if (line.startsWith('ERR ')) throw new Error(`tag list: ${line.slice(4)}`);
    const ref = line.split(' ')[1] ?? '';
    if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
    at += len;
  }
  throw new Error('tag list: git protocol response ended without a flush packet');
}

export async function pickNewestMenubarVersion(
  tags: string[],
  floor: string,
  hasPublishedAssets: (version: string) => Promise<boolean>,
): Promise<string> {
  const newer = tags
    .map((t) => TAG.exec(t)?.[1])
    .filter((v): v is string => v !== undefined && compareVersions(v, floor) > 0)
    .sort((a, b) => compareVersions(b, a));
  for (const version of new Set(newer)) {
    if (await hasPublishedAssets(version)) return version;
  }
  return floor;
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

export function cachedMenubarVersion(opts: { floor?: string; cacheFile?: string } = {}): string {
  const floor = opts.floor ?? helperFloor('menubar');
  const cache = readMenubarResolveCache(opts.cacheFile ?? menubarResolveCachePath());
  return cache && compareVersions(cache.version, floor) >= 0 ? cache.version : floor;
}

type FetchLike = (input: string, init: {
  method: 'GET' | 'HEAD' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect?: 'manual';
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

function userAgent(): Record<string, string> {
  return { 'User-Agent': `agents-cli/${getCliVersion()}` };
}

async function fetchMenubarTags(fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl(MENUBAR_UPLOAD_PACK, {
    method: 'POST',
    headers: {
      ...userAgent(),
      'Git-Protocol': 'version=2',
      'Content-Type': 'application/x-git-upload-pack-request',
      Accept: 'application/x-git-upload-pack-result',
    },
    body: MENUBAR_LS_REFS_REQUEST,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`tag list: HTTP ${res.status}`);
  return parseLsRefsTags(Buffer.from(await res.arrayBuffer()));
}

// A draft release serves no download, and a tag pushed before its upload
// finished has none yet: both answer 404 here and are skipped.
async function assetPublished(fetchImpl: FetchLike, url: string): Promise<boolean> {
  const res = await fetchImpl(url, { method: 'HEAD', headers: userAgent(), redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (res.status === 404) return false;
  if (res.ok || (res.status >= 300 && res.status < 400)) return true;
  throw new Error(`release asset check: HTTP ${res.status}`);
}

async function menubarAssetsPublished(fetchImpl: FetchLike, version: string): Promise<boolean> {
  const { zip, sha256 } = menubarHelperAssetUrls(version);
  const [hasZip, hasSha] = await Promise.all([assetPublished(fetchImpl, zip), assetPublished(fetchImpl, sha256)]);
  return hasZip && hasSha;
}

export async function resolveMenubarVersion(opts: {
  floor?: string;
  cacheFile?: string;
  now?: number;
  ttlMs?: number;
  force?: boolean;
  strict?: boolean;
  fetchImpl?: FetchLike;
} = {}): Promise<string> {
  const floor = opts.floor ?? helperFloor('menubar');
  const file = opts.cacheFile ?? menubarResolveCachePath();
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? MENUBAR_RESOLVE_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const cached = readMenubarResolveCache(file);
  if (cached && !opts.force && now - cached.checkedAt < ttl && compareVersions(cached.version, floor) >= 0) {
    return cached.version;
  }
  try {
    const tags = await fetchMenubarTags(fetchImpl);
    const version = await pickNewestMenubarVersion(tags, floor, (v) => menubarAssetsPublished(fetchImpl, v));
    writeMenubarResolveCache(file, { checkedAt: now, version });
    return version;
  } catch (error) {
    if (opts.strict) throw error;
    return cached && compareVersions(cached.version, floor) >= 0 ? cached.version : floor;
  }
}
