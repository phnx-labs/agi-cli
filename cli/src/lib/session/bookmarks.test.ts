import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-bookmarks-'));
process.env.HOME = TEST_HOME;

const { listBookmarks, isBookmarked, setBookmark, toggleBookmark, bookmarksFilePath, clearBookmarksCache } =
  await import('./bookmarks.js');

/** Bookmarks are asserted by a human, not derived by the scanner, so the properties that matter are
 * durability (atomic real file surviving a reindex) and that a corrupt or absent file means
 * "nothing bookmarked" instead of breaking `agents sessions`. */
describe('session bookmarks', () => {
  it('round-trips a bookmark through the real file and reports it back', () => {
    expect(isBookmarked('sid-a')).toBe(false);
    expect(setBookmark('sid-a', true)).toBe(true);
    expect(isBookmarked('sid-a')).toBe(true);
    expect([...listBookmarks()]).toEqual(['sid-a']);
    // The store is a real file on disk, not process state.
    const onDisk = JSON.parse(fs.readFileSync(bookmarksFilePath(), 'utf8'));
    expect(onDisk.sessionIds).toContain('sid-a');
    expect(onDisk.version).toBe(1);
  });

  it('toggles, and removing a bookmark deletes the id instead of keeping a false entry', () => {
    setBookmark('sid-b', true);
    expect(toggleBookmark('sid-b')).toBe(false);
    expect(isBookmarked('sid-b')).toBe(false);
    expect(JSON.parse(fs.readFileSync(bookmarksFilePath(), 'utf8')).sessionIds).not.toContain('sid-b');
    expect(toggleBookmark('sid-b')).toBe(true);
    expect(isBookmarked('sid-b')).toBe(true);
  });

  it('is idempotent — a redundant set leaves the file untouched', () => {
    setBookmark('sid-c', true);
    const before = fs.statSync(bookmarksFilePath()).mtimeMs;
    expect(setBookmark('sid-c', true)).toBe(true);
    expect(fs.statSync(bookmarksFilePath()).mtimeMs).toBe(before);
  });

  it('picks up a file another process rewrote (the memoized read is mtime-keyed)', () => {
    setBookmark('sid-d', true);
    expect(isBookmarked('sid-d')).toBe(true);
    // Simulate a peer/sync writing the file underneath us.
    fs.writeFileSync(bookmarksFilePath(), JSON.stringify({ version: 1, sessionIds: ['sid-elsewhere'] }));
    clearBookmarksCache();
    expect(isBookmarked('sid-d')).toBe(false);
    expect(isBookmarked('sid-elsewhere')).toBe(true);
  });

  it('treats a malformed or absent store as empty instead of throwing', () => {
    fs.writeFileSync(bookmarksFilePath(), '{ this is not json');
    clearBookmarksCache();
    expect(listBookmarks().size).toBe(0);
    // Non-string entries are dropped, not trusted into the set.
    fs.writeFileSync(bookmarksFilePath(), JSON.stringify({ version: 1, sessionIds: ['ok', 42, null, ''] }));
    clearBookmarksCache();
    expect([...listBookmarks()]).toEqual(['ok']);
    fs.rmSync(bookmarksFilePath());
    clearBookmarksCache();
    expect(listBookmarks().size).toBe(0);
    expect(isBookmarked('anything')).toBe(false);
  });

  it('never treats an absent session id as bookmarked', () => {
    expect(isBookmarked(undefined)).toBe(false);
    expect(isBookmarked('')).toBe(false);
  });
});
