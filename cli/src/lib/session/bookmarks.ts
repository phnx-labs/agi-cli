/** Bookmarked sessions: a human's durable mark, kept out of the rebuildable `sessions.db` cache (a
 * bookmark is not derivable from a transcript), in `~/.agents/.history/`. Not synced today (sync
 * carries only `.history/backups/`), so per-machine. Reads are memoized on mtime for the picker. */

import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir } from '../state.js';

/** The on-disk shape. Versioned so a later format can migrate rather than guess. */
interface BookmarksFile {
  version: 1;
  sessionIds: string[];
}

export function bookmarksFilePath(): string {
  return path.join(getHistoryDir(), 'bookmarks.json');
}

/** Memoized parse, invalidated by the file's mtime+size (another process — or
 *  another machine's sync — can rewrite it under us). */
let cache: { key: string; ids: Set<string> } | null = null;

function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

/** Drop the memoized read. Tests that write the file directly need this; nothing
 *  in the CLI does, because every mutation here refreshes the cache itself. */
export function clearBookmarksCache(): void {
  cache = null;
}

/** Every bookmarked session id. Empty (never throws) when the file is absent, unreadable or
 * malformed: a corrupt file must not take down `agents sessions`. */
export function listBookmarks(): Set<string> {
  const file = bookmarksFilePath();
  const key = statKey(file);
  if (cache && cache.key === key) return cache.ids;
  let ids = new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BookmarksFile>;
    if (Array.isArray(parsed?.sessionIds)) {
      ids = new Set(parsed.sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0));
    }
  } catch {
    // absent / unreadable / malformed — an empty set is the honest answer
  }
  cache = { key, ids };
  return ids;
}

export function isBookmarked(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return listBookmarks().has(sessionId);
}

/** Atomic write (tmp + rename) so a concurrent reader never sees a half file. */
function writeBookmarks(ids: Set<string>): void {
  const file = bookmarksFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: BookmarksFile = { version: 1, sessionIds: [...ids].sort() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache = { key: statKey(file), ids };
}

/** Set or clear the bookmark and return the resulting state. A no-op write is skipped so the file's
 * mtime, and other processes' memoized reads, stay untouched. */
export function setBookmark(sessionId: string, on: boolean): boolean {
  const ids = new Set(listBookmarks());
  if (ids.has(sessionId) === on) return on;
  if (on) ids.add(sessionId);
  else ids.delete(sessionId);
  writeBookmarks(ids);
  return on;
}

/** Flip the mark; returns the new state (`true` = now bookmarked). */
export function toggleBookmark(sessionId: string): boolean {
  return setBookmark(sessionId, !isBookmarked(sessionId));
}
