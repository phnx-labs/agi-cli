import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ESM namespaces are non-configurable, so `vi.spyOn(fs, 'statSync')` throws. Replace the module
// with a wrapper delegating to `node:fs` and hooking `statSync`, to count the per-file stats
// dir_ledger should elide. Top-level const state, since Bun's runner does not hoist vi.mock.
const statCounter: { watchPath: string | null; count: number } = { watchPath: null, count: 0 };

vi.mock('fs', () => {
  const actual = require('node:fs') as typeof import('fs');
  return {
    ...actual,
    default: actual,
    statSync: ((p: fs.PathLike, ...rest: any[]) => {
      if (statCounter.watchPath !== null && typeof p === 'string' && p === statCounter.watchPath) {
        statCounter.count++;
      }
      return (actual.statSync as any)(p, ...rest);
    }) as typeof actual.statSync,
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// db.ts + state.ts resolve paths from HOME at import. Point HOME at a throwaway dir BEFORE
// importing so the suite runs against an isolated sqlite DB and session tree.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dirledger-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('./discover.js');
type DB = typeof import('./db.js');

let discover: Discover;
let db: DB;

// The live Claude root (the only tree Claude appends to in place) and an
// immutable "backup-style" root under ~/.agents/.history/backups/claude/<ts>.
const LIVE_PROJECTS = path.join(tmpHome, '.claude', 'projects');
const BACKUP_PROJECTS = path.join(tmpHome, '.agents', '.history', 'backups', 'claude', '2026-01-01', 'projects');

function claudeLine(ts: string, cwd: string, text: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { content: text } });
}

/** Write a Claude .jsonl transcript with one user turn. */
function writeSession(dir: string, id: string, ts: string, cwd: string, text: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(fp, claudeLine(ts, cwd, text) + '\n', 'utf-8');
  return fp;
}

async function discoverIds(): Promise<Set<string>> {
  const sessions = await discover.discoverSessions({ agent: 'claude', all: true });
  return new Set(sessions.map(s => s.id));
}

/** All Claude sessions (cwd-unfiltered) as SessionMeta. */
async function discoverAll() {
  return discover.discoverSessions({ agent: 'claude', all: true });
}

/** Bump a file's mtime a whole second into the future (deterministic ordering). */
function bumpMtime(fp: string, seconds: number): void {
  fs.utimesSync(fp, seconds, seconds);
}

beforeAll(async () => {
  db = await import('./db.js');
  discover = await import('./discover.js');
  db.getDB(); // create schema
});

afterEach(() => {
  statCounter.watchPath = null;
  statCounter.count = 0;
});

afterAll(() => {
  // Close before removing the tree: Windows refuses to unlink an open file, so
  // a leaked connection (plus its WAL sidecars) fails the whole suite there.
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('dir_ledger short-circuit (A-2)', () => {
  it('T2: an unchanged backup dir does ZERO per-file stats on the second run', async () => {
    // Two sessions in the live root, one in an immutable backup dir.
    writeSession(path.join(LIVE_PROJECTS, '-proj-a'), 'live-1', '2026-07-01T00:00:00Z', '/proj/a', 'live one');
    writeSession(path.join(LIVE_PROJECTS, '-proj-b'), 'live-2', '2026-07-01T00:01:00Z', '/proj/b', 'live two');
    const backupFile = writeSession(path.join(BACKUP_PROJECTS, '-proj-c'), 'bkup-1', '2026-06-01T00:00:00Z', '/proj/c', 'backup one');

    const run1 = await discoverIds();
    expect(run1.has('live-1')).toBe(true);
    expect(run1.has('live-2')).toBe(true);
    expect(run1.has('bkup-1')).toBe(true);

    // Age the backup file's ledger stamp past the 10-minute hot window so it is cold (a real
    // backup was scanned long ago). A file scanned within HOT_FILE_WINDOW_MS is re-stat'd even in
    // an unchanged dir (T9); live-root files stay hot.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ? WHERE file_path = ?')
      .run(Date.now() - 20 * 60_000, fs.realpathSync(backupFile));

    // Count per-file stats of the backup file on the second run.
    statCounter.watchPath = backupFile;
    statCounter.count = 0;

    const run2 = await discoverIds();

    // (a) the SAME session set surfaces both runs
    expect(run2).toEqual(run1);
    // (b) the unchanged backup dir's file is NEVER stat'd on the 2nd run — the
    //     dir_ledger match collapses it to a single dir stat, zero per-file stats.
    expect(statCounter.count).toBe(0);
  });

  it('T3: an in-place append under the live root is still caught (dir mtime unchanged)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-append');
    const fp = writeSession(dir, 'append-1', '2026-07-02T00:00:00Z', '/proj/app', 'first turn');

    const before = (await discoverAll()).find(s => s.id === 'append-1');
    expect(before).toBeDefined();
    const countBefore = before!.messageCount;

    // Append a second user turn WITHOUT touching the parent dir (an in-place
    // append does not bump the dir's mtime). Advance the FILE mtime forward.
    fs.appendFileSync(fp, claudeLine('2026-07-02T00:05:00Z', '/proj/app', 'second turn') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 10);

    // Advance the clock past the 5s active-append debounce so the grown file is
    // parsed, not deferred.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = 0').run();

    const after = (await discoverAll()).find(s => s.id === 'append-1');
    expect(after).toBeDefined();
    // The append was caught: message_count grew from 1 to 2.
    expect((after!.messageCount ?? 0)).toBeGreaterThan(countBefore ?? 0);
  });

  it('T4: the append debounce is preserved (grown live file NOT re-parsed within 5s)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-debounce');
    const fp = writeSession(dir, 'debounce-1', '2026-07-03T00:00:00Z', '/proj/deb', 'only turn');

    const before = (await discoverAll()).find(s => s.id === 'debounce-1');
    const countBefore = before!.messageCount;

    // Append + bump the file mtime, but LEAVE scanned_at = now (fresh) so the
    // append lands inside the debounce window.
    fs.appendFileSync(fp, claudeLine('2026-07-03T00:01:00Z', '/proj/deb', 'sneaky turn') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 1);
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now());

    const after = (await discoverAll()).find(s => s.id === 'debounce-1');
    // Within the debounce, the cached row is served — message_count unchanged.
    expect(after!.messageCount).toBe(countBefore);
  });

  it('T5: a NEW file dropped into a previously-unchanged dir surfaces (dir mtime+count bump)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-newfile');
    writeSession(dir, 'new-a', '2026-07-04T00:00:00Z', '/proj/new', 'existing');
    let ids = await discoverIds();
    expect(ids.has('new-a')).toBe(true);
    expect(ids.has('new-b')).toBe(false);

    // Dropping a new file bumps the dir mtime + entry_count → dir treated as
    // changed → full re-walk → the new session surfaces.
    writeSession(dir, 'new-b', '2026-07-04T00:02:00Z', '/proj/new', 'brand new');
    ids = await discoverIds();
    expect(ids.has('new-b')).toBe(true);
  });

  it('T6: deleting a file ARCHIVES the session — its user turns survive in the DB (RUSH-2436, no crash)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-delete');
    const fp = writeSession(dir, 'del-a', '2026-07-05T00:00:00Z', '/proj/del', 'to be deleted');
    let all = await discoverAll();
    expect(all.find(s => s.id === 'del-a')?.archived).toBeUndefined();

    fs.rmSync(fp);
    all = await discoverAll();
    // Pre-RUSH-2436 the row was dropped and vanished. Now a file-gone session
    // whose user turns still live in session_text is kept, flagged archived, so
    // `agents sessions` still lists it instead of losing it.
    const archived = all.find(s => s.id === 'del-a');
    expect(archived, 'deleted-file session must still list, flagged archived').toBeDefined();
    expect(archived!.archived).toBe(true);
  });

  it('T7: renaming a file surfaces the new id and ARCHIVES the old one (RUSH-2436)', async () => {
    const dir = path.join(LIVE_PROJECTS, '-rename');
    const oldFp = writeSession(dir, 'ren-old', '2026-07-06T00:00:00Z', '/proj/ren', 'renamed');
    let ids = await discoverIds();
    expect(ids.has('ren-old')).toBe(true);

    // The synthetic test derives the session id from the filename, so a rename makes a new id
    // while ren-old keeps a missing file_path; with durable content it is archived (kept). Real
    // harnesses derive the id from content, so no such pair arises in production.
    fs.renameSync(oldFp, path.join(dir, 'ren-new.jsonl'));
    const all = await discoverAll();
    expect(all.find(s => s.id === 'ren-new'), 'renamed file surfaces under its new id').toBeDefined();
    const old = all.find(s => s.id === 'ren-old');
    expect(old, 'the old id is archived (content survives), not dropped').toBeDefined();
    expect(old!.archived).toBe(true);
  });

  it('T8: a cold/wiped ledger yields the identical session set', async () => {
    const before = await discoverIds();
    expect(before.size).toBeGreaterThan(0);

    db.getDB().prepare('DELETE FROM dir_ledger').run();
    db.getDB().prepare('DELETE FROM scan_ledger').run();

    const after = await discoverIds();
    expect(after).toEqual(before);
  });

  it('T9: a hot-window file OUTSIDE the live root, appended with dir mtime unchanged, is still re-stat\'d + updated', async () => {
    // Seed a session in the immutable backup root and scan it.
    const dir = path.join(BACKUP_PROJECTS, '-hot');
    const fp = writeSession(dir, 'hot-1', '2026-06-02T00:00:00Z', '/proj/hot', 'first');
    const before = (await discoverAll()).find(s => s.id === 'hot-1');
    expect(before).toBeDefined();
    const countBefore = before!.messageCount;

    // Append in place (dir mtime unchanged), bump the file mtime, and make the ledger's scanned_at
    // recent (inside HOT_FILE_WINDOW_MS, since it is not a live-root file) but past the 5s append
    // debounce.
    fs.appendFileSync(fp, claudeLine('2026-06-02T00:05:00Z', '/proj/hot', 'grown') + '\n', 'utf-8');
    bumpMtime(fp, Math.floor(Date.now() / 1000) + 20);
    // scanned_at within the 10min hot window but older than the 5s debounce.
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);

    const after = (await discoverAll()).find(s => s.id === 'hot-1');
    expect((after!.messageCount ?? 0)).toBeGreaterThan(countBefore ?? 0);
  });

  it('kill-switch: AGENTS_SESSIONS_NO_DIR_LEDGER=1 forces the full walk (dir_ledger not consulted), identical results', async () => {
    // Fresh isolated backup file so we can watch its per-file stats.
    const dir = path.join(BACKUP_PROJECTS, '-killswitch');
    const backupFile = writeSession(dir, 'ks-1', '2026-06-03T00:00:00Z', '/proj/ks', 'kill switch');

    // Warm both ledgers.
    const warm = await discoverIds();
    expect(warm.has('ks-1')).toBe(true);

    const prevEnv = process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
    process.env.AGENTS_SESSIONS_NO_DIR_LEDGER = '1';
    statCounter.watchPath = backupFile;
    statCounter.count = 0;

    const withKill = await discoverIds();

    if (prevEnv === undefined) delete process.env.AGENTS_SESSIONS_NO_DIR_LEDGER;
    else process.env.AGENTS_SESSIONS_NO_DIR_LEDGER = prevEnv;

    // Full-walk path ran: the backup file WAS stat'd even though its dir was
    // unchanged (the dir_ledger short-circuit was skipped)...
    expect(statCounter.count).toBeGreaterThan(0);
    // ...and the results are identical to the short-circuited run.
    expect(withKill).toEqual(warm);
  });

  it('cross-root precedence: a NEW backup snapshot of a COLD live session never flips file_path off the live copy', async () => {
    // The live copy of a session is indexed and then goes cold (unchanged).
    const liveDir = path.join(LIVE_PROJECTS, '-xroot');
    const liveFp = writeSession(liveDir, 'xroot-1', '2026-07-08T00:00:00Z', '/proj/xr', 'the live session');

    let sessions = await discoverAll();
    let row = sessions.find(s => s.id === 'xroot-1');
    expect(row).toBeDefined();
    expect(row!.filePath).toBe(liveFp);

    // A backup snapshot of the same session id goes in a fresh dir (new leaf dir, full walk, so
    // the backup is "changed"); the live copy is cold and unchanged. Before the fix the backup won
    // the dedup and overwrote file_path with the frozen backup path.
    const backupDir = path.join(BACKUP_PROJECTS, '-xroot');
    const backupFp = writeSession(backupDir, 'xroot-1', '2026-07-08T00:00:00Z', '/proj/xr', 'the live session');
    expect(backupFp).not.toBe(liveFp);

    sessions = await discoverAll();
    row = sessions.find(s => s.id === 'xroot-1');
    // (a) still surfaces, (b) file_path is the LIVE path (never the backup),
    // (c) not dropped.
    expect(row).toBeDefined();
    expect(row!.filePath).toBe(liveFp);
    expect(fs.existsSync(row!.filePath)).toBe(true);
  });

  it('cross-root precedence: when BOTH the live and backup copies change, the live path still wins', async () => {
    const liveDir = path.join(LIVE_PROJECTS, '-xroot2');
    const backupDir = path.join(BACKUP_PROJECTS, '-xroot2');
    const liveFp = writeSession(liveDir, 'xroot-2', '2026-07-09T00:00:00Z', '/proj/xr2', 'live v1');
    const backupFp = writeSession(backupDir, 'xroot-2', '2026-07-09T00:00:00Z', '/proj/xr2', 'backup v1');

    let sessions = await discoverAll();
    expect(sessions.find(s => s.id === 'xroot-2')?.filePath).toBe(liveFp);

    // Both copies grow (dir mtime + count unchanged, but the files change) and
    // both fall outside the append debounce.
    fs.appendFileSync(liveFp, claudeLine('2026-07-09T00:05:00Z', '/proj/xr2', 'live v2') + '\n', 'utf-8');
    fs.appendFileSync(backupFp, claudeLine('2026-07-09T00:05:00Z', '/proj/xr2', 'backup v2') + '\n', 'utf-8');
    const future = Math.floor(Date.now() / 1000) + 30;
    bumpMtime(liveFp, future);
    bumpMtime(backupFp, future);
    db.getDB().prepare('UPDATE scan_ledger SET scanned_at = 0').run();

    sessions = await discoverAll();
    const row = sessions.find(s => s.id === 'xroot-2');
    // Even with both copies in the changed set, the live path wins (winner is the
    // first occurrence in live-first order).
    expect(row?.filePath).toBe(liveFp);
  });
});
