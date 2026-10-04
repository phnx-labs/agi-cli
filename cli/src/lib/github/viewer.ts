/**
 * The authenticated GitHub user (`gh api user`) — login, display name, avatar.
 *
 * One REST read, cached twice: gh's own HTTP cache (`--cache 24h`) and a small
 * disk record here (`<cache>/github-viewer.json`) so a frequent reader such as
 * the menu-bar snapshot spawns no `gh` at all on the common path. The record
 * carries no email: only what `gh api user` returns publicly.
 */
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteJsonSync } from '../fs-atomic.js';
import { getCacheDir } from '../state.js';
import { ghExec, type GhExec } from './pr-mergeable.js';

export interface GithubViewer {
  login: string;
  name: string | null;
  /** https URL of the profile picture, or null when GitHub returned none. */
  avatarUrl: string | null;
}

interface ViewerCacheRecord {
  /** Unix ms of the read. A failed read is recorded too, as `viewer: null`. */
  fetchedAt: number;
  viewer: GithubViewer | null;
}

const VIEWER_JQ = '{login, avatar_url, name}';
/** A successful read is good for a day, matching gh's own `--cache 24h`. */
export const VIEWER_FRESH_MS = 24 * 60 * 60_000;
/** A failed read (gh absent, signed out, offline) is retried hourly, not every poll. */
export const VIEWER_RETRY_MS = 60 * 60_000;
/** Cap on the refresh's `gh` spawn, well inside the menu's 30 s snapshot deadline. */
export const VIEWER_REFRESH_TIMEOUT_MS = 5_000;

export function viewerCachePath(cacheDir: string = getCacheDir()): string {
  return path.join(cacheDir, 'github-viewer.json');
}

/** Parse the `gh api user --jq '{login, avatar_url, name}'` output; null when it names no login. */
export function parseViewer(raw: string): GithubViewer | null {
  let data: { login?: unknown; avatar_url?: unknown; name?: unknown };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    return null;
  }
  if (typeof data?.login !== 'string' || !data.login.trim()) return null;
  const avatar = typeof data.avatar_url === 'string' ? data.avatar_url.trim() : '';
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  return {
    login: data.login.trim(),
    name: name || null,
    avatarUrl: /^https:\/\/\S+$/i.test(avatar) ? avatar : null,
  };
}

/** The authenticated user from a REST read gh caches for a day; null when gh cannot say. */
export async function fetchViewerProfile(gh: GhExec = ghExec): Promise<GithubViewer | null> {
  try {
    return parseViewer(await gh(['api', 'user', '--cache', '24h', '--jq', VIEWER_JQ]));
  } catch {
    return null;
  }
}

function readRecord(file: string): ViewerCacheRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as ViewerCacheRecord;
    if (typeof rec?.fetchedAt !== 'number') return null;
    if (rec.viewer !== null && typeof rec.viewer?.login !== 'string') return null;
    return rec;
  } catch {
    return null;
  }
}

/** True when the record is still inside its window (a day for a hit, an hour for a miss). */
export function isViewerRecordFresh(rec: ViewerCacheRecord, nowMs: number = Date.now()): boolean {
  const age = nowMs - rec.fetchedAt;
  return age >= 0 && age <= (rec.viewer ? VIEWER_FRESH_MS : VIEWER_RETRY_MS);
}

interface CachedViewerOptions {
  gh?: GhExec;
  cacheDir?: string;
  nowMs?: number;
}

/**
 * The viewer from the disk record, refreshed through `gh` only when the record
 * is missing or past its window. The read is the record's writer (the
 * `devices/stats-cache.ts` pattern): no daemon timer, and the refresh is capped
 * at {@link VIEWER_REFRESH_TIMEOUT_MS}. A failed refresh is recorded so the next
 * caller does not retry until {@link VIEWER_RETRY_MS} has passed.
 */
export async function cachedViewer(opts: CachedViewerOptions = {}): Promise<GithubViewer | null> {
  const file = viewerCachePath(opts.cacheDir);
  const nowMs = opts.nowMs ?? Date.now();
  const rec = readRecord(file);
  if (rec && isViewerRecordFresh(rec, nowMs)) return rec.viewer;
  const gh = opts.gh ?? ((args: string[]) => ghExec(args, { timeoutMs: VIEWER_REFRESH_TIMEOUT_MS }));
  const viewer = await fetchViewerProfile(gh);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteJsonSync(file, { fetchedAt: nowMs, viewer } satisfies ViewerCacheRecord);
  } catch {
    // An unwritable cache dir costs one gh spawn per call, never a wrong answer.
  }
  return viewer;
}
