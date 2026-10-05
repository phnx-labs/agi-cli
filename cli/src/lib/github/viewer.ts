import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { httpsUrl } from '../actor.js';
import { atomicWriteJsonSync } from '../fs-atomic.js';
import { getCacheDir } from '../state.js';
import { ghExec, type GhExec } from './pr-mergeable.js';

export interface GithubViewer {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  emailSha256: string | null;
}

interface ViewerCacheRecord {
  checkedAt: number;
  ok: boolean;
  viewer: GithubViewer | null;
}

const VIEWER_JQ = '{login, avatar_url, name, email}';
export const VIEWER_FRESH_MS = 24 * 60 * 60_000;
export const VIEWER_RETRY_MS = 60 * 60_000;
export const VIEWER_REFRESH_TIMEOUT_MS = 5_000;

export function viewerCachePath(cacheDir: string = getCacheDir()): string {
  return path.join(cacheDir, 'github-viewer.json');
}

export function emailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function parseViewer(raw: string): GithubViewer | null {
  let data: { login?: unknown; avatar_url?: unknown; name?: unknown; email?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return null;
  }
  const login = nonEmpty(data?.login);
  if (!login) return null;
  const email = nonEmpty(data.email);
  return {
    login,
    name: nonEmpty(data.name),
    avatarUrl: httpsUrl(nonEmpty(data.avatar_url) ?? undefined) ?? null,
    emailSha256: email ? emailDigest(email) : null,
  };
}

export async function fetchViewerProfile(gh: GhExec = ghExec): Promise<GithubViewer | null> {
  try {
    return parseViewer(await gh(['api', 'user', '--cache', '24h', '--jq', VIEWER_JQ]));
  } catch {
    return null;
  }
}

function storedViewer(v: unknown): GithubViewer | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const { login, name, avatarUrl, emailSha256 } = v as Record<string, unknown>;
  if (typeof login !== 'string' || !login) return undefined;
  if (name !== null && typeof name !== 'string') return undefined;
  if (avatarUrl !== null && !(typeof avatarUrl === 'string' && httpsUrl(avatarUrl) === avatarUrl)) return undefined;
  if (emailSha256 !== null && !(typeof emailSha256 === 'string' && /^[0-9a-f]{64}$/.test(emailSha256))) return undefined;
  return { login, name, avatarUrl, emailSha256 };
}

function readRecord(file: string): ViewerCacheRecord | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof rec?.checkedAt !== 'number' || typeof rec.ok !== 'boolean') return null;
  const viewer = storedViewer(rec.viewer);
  if (viewer === undefined) return null;
  return { checkedAt: rec.checkedAt, ok: rec.ok, viewer };
}

export function isViewerRecordFresh(rec: ViewerCacheRecord, nowMs: number = Date.now()): boolean {
  const age = nowMs - rec.checkedAt;
  return age >= 0 && age <= (rec.ok ? VIEWER_FRESH_MS : VIEWER_RETRY_MS);
}

interface CachedViewerOptions {
  gh?: GhExec;
  cacheDir?: string;
  nowMs?: number;
}

export async function cachedViewer(opts: CachedViewerOptions = {}): Promise<GithubViewer | null> {
  const file = viewerCachePath(opts.cacheDir);
  const nowMs = opts.nowMs ?? Date.now();
  const prev = readRecord(file);
  if (prev && isViewerRecordFresh(prev, nowMs)) return prev.viewer;
  const gh = opts.gh ?? ((args: string[]) => ghExec(args, { timeoutMs: VIEWER_REFRESH_TIMEOUT_MS }));
  const fetched = await fetchViewerProfile(gh);
  const next: ViewerCacheRecord = fetched
    ? { checkedAt: nowMs, ok: true, viewer: fetched }
    : { checkedAt: nowMs, ok: false, viewer: prev?.viewer ?? null };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJsonSync(file, next);
  } catch {
  }
  return next.viewer;
}
