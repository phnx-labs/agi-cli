/**
 * The authenticated GitHub user (`gh api user`) — login, display name, avatar.
 *
 * One REST read, cached twice: gh's own HTTP cache (`--cache 24h`) and a small
 * disk record here (`<cache>/github-viewer.json`) so a frequent reader such as
 * the menu-bar snapshot spawns no `gh` at all on the common path. The record
 * never holds an email: GitHub's public profile email is kept only as a SHA-256
 * digest, enough to tell whether this account belongs to a known person.
 */
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
  /** https URL of the profile picture, or null when GitHub returned none. */
  avatarUrl: string | null;
  /** {@link emailDigest} of the account's public profile email, or null when it has none. */
  emailSha256: string | null;
}

interface ViewerCacheRecord {
  /** Unix ms of the last `gh` attempt, successful or not. */
  checkedAt: number;
  /** Whether that attempt succeeded. A failure keeps the previous `viewer`. */
  ok: boolean;
  /** The last viewer gh named, or null when it never named one. */
  viewer: GithubViewer | null;
}

const VIEWER_JQ = '{login, avatar_url, name, email}';
/** A successful read is good for a day, matching gh's own `--cache 24h`. */
export const VIEWER_FRESH_MS = 24 * 60 * 60_000;
/** A failed read (gh absent, signed out, offline) is retried hourly, not every poll. */
export const VIEWER_RETRY_MS = 60 * 60_000;
/** Cap on the refresh's `gh` spawn, well inside the menu's 30 s snapshot deadline. */
export const VIEWER_REFRESH_TIMEOUT_MS = 5_000;

export function viewerCachePath(cacheDir: string = getCacheDir()): string {
  return path.join(cacheDir, 'github-viewer.json');
}

/** Case- and whitespace-insensitive SHA-256 of an email, for comparing identities without storing one. */
export function emailDigest(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Parse the `gh api user --jq '{login, avatar_url, name, email}'` output; null when it names no login. */
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

/** The authenticated user from a REST read gh caches for a day; null when gh cannot say. */
export async function fetchViewerProfile(gh: GhExec = ghExec): Promise<GithubViewer | null> {
  try {
    return parseViewer(await gh(['api', 'user', '--cache', '24h', '--jq', VIEWER_JQ]));
  } catch {
    return null;
  }
}

/** A stored viewer, or undefined when the value is not one (so the whole record is distrusted). */
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

/** The record on disk, or null when it is missing, corrupt, or not this shape. */
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

/** True when the record is inside its window: a day after a success, an hour after a failure. */
export function isViewerRecordFresh(rec: ViewerCacheRecord, nowMs: number = Date.now()): boolean {
  const age = nowMs - rec.checkedAt;
  return age >= 0 && age <= (rec.ok ? VIEWER_FRESH_MS : VIEWER_RETRY_MS);
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
 * at {@link VIEWER_REFRESH_TIMEOUT_MS}. A failed refresh keeps the last viewer
 * gh named and only moves the retry clock, so a blip never erases the avatar.
 */
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
    // An unwritable cache dir costs one gh spawn per call, never a wrong answer.
  }
  return next.viewer;
}
