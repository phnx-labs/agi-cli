
import fs from 'node:fs';
import path from 'node:path';
import { getHistoryDir } from '../state.js';

interface BookmarksFile {
  version: 1;
  sessionIds: string[];
}

export function bookmarksFilePath(): string {
  return path.join(getHistoryDir(), 'bookmarks.json');
}

let cache: { key: string; ids: Set<string> } | null = null;

function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}

export function clearBookmarksCache(): void {
  cache = null;
}

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
  }
  cache = { key, ids };
  return ids;
}

export function isBookmarked(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return listBookmarks().has(sessionId);
}

function writeBookmarks(ids: Set<string>): void {
  const file = bookmarksFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: BookmarksFile = { version: 1, sessionIds: [...ids].sort() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n');
  fs.renameSync(tmp, file);
  cache = { key: statKey(file), ids };
}

export function setBookmark(sessionId: string, on: boolean): boolean {
  const ids = new Set(listBookmarks());
  if (ids.has(sessionId) === on) return on;
  if (on) ids.add(sessionId);
  else ids.delete(sessionId);
  writeBookmarks(ids);
  return on;
}

export function toggleBookmark(sessionId: string): boolean {
  return setBookmark(sessionId, !isBookmarked(sessionId));
}
