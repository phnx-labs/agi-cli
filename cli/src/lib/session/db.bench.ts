/** Benchmark for the session-index query hot path in db.ts. No mocking: it snapshots this machine's
 * real sessions.db (`VACUUM INTO`) and points db.ts at it via `AGENTS_SESSIONS_DB`. A snapshot
 * avoids WAL contention and writes (RUSH-2436). Run with `npx vitest bench --run`. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getSessionsDbPath } from '../state.js';

// Snapshot the REAL index into a throwaway file and point db.ts at it BEFORE
// importing db.js, so its module-level DB_PATH capture (db.ts:29) resolves here.
const REAL_DB = path.join(os.homedir(), '.agents', '.history', 'sessions', 'sessions.db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbbench-'));
const SNAPSHOT = path.join(TMP, 'sessions.db');
const haveRealDb = fs.existsSync(REAL_DB) && fs.statSync(REAL_DB).size > 0;
if (haveRealDb) {
  const src = new DatabaseSync(REAL_DB, { readOnly: true });
  // A single transactional snapshot of committed + WAL state into one file.
  src.exec(`VACUUM INTO '${SNAPSHOT.replace(/'/g, "''")}'`);
  src.close();
  process.env.AGENTS_SESSIONS_DB = SNAPSHOT;
}

// Dynamic import so the AGENTS_SESSIONS_DB seam above is set first.
const dbmod = await import('./db.js');
const { querySessions, countSessions, getSessionById, findSessionsById, findSessionsByShortIds, ftsSearch, closeDB } = dbmod;

// Real ids / short-ids pulled from the snapshot for the lookup benches — actual
// rows, not synthesized keys. Reads through the warm skip-existence path so this
// setup itself does no fs sweep.
const sample = haveRealDb ? querySessions({ limit: 40, skipExistenceCheck: true }) : [];
const realId = sample[0]?.id ?? '';
const realShortIds = sample.map((s) => s.shortId).filter((s): s is string => !!s).slice(0, 20);
const realIdPrefix = realId ? realId.slice(0, 8) : '';

afterAll(() => {
  try { closeDB(); } catch { /* already closed */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe.skipIf(!haveRealDb)('querySessions — session listing (agents sessions)', () => {
  // The real operational default: the first iteration populates membership;
  // later iterations reuse it while the SQLite index version is unchanged.
  bench('full listing, cached existence check ON', () => {
    querySessions({});
  });

  // Same SELECT + rowToMeta over the same ~6.6k rows, existence check OFF —
  // isolates the SQL + row mapping from the fs sweep above.
  bench('full listing, skipExistenceCheck (SQL + rowToMeta only, no fs)', () => {
    querySessions({ skipExistenceCheck: true });
  });

  // The interactive picker's real path: newest 15 (PICKER_RECENT_COUNT). The
  // LIMIT over-fetches limit+16 rows (db.ts:2603) so only ~31 rows are existence-
  // checked — the cheap, common case.
  bench('recent 15 (interactive picker path, existence check ON)', () => {
    querySessions({ limit: 15 });
  });

  bench('filtered agent=claude, limit 50', () => {
    querySessions({ agent: 'claude', limit: 50 });
  });

  bench('sortBy=cost, limit 50 (priciest-first, unindexed expression sort)', () => {
    querySessions({ sortBy: 'cost', limit: 50 });
  });
});

describe.skipIf(!haveRealDb)('countSessions — paginator count', () => {
  bench('countSessions({}) — COUNT(*) over the whole index', () => {
    countSessions({});
  });
});

describe.skipIf(!haveRealDb)('id / short-id lookup (pid->session context, tmux scan resolution)', () => {
  bench('getSessionById — indexed PK lookup, re-prepares each call (db.ts:3204)', () => {
    getSessionById(realId);
  });

  bench('findSessionsById — exact-first-then-prefix (db.ts:3216)', () => {
    findSessionsById(realIdPrefix);
  });

  bench('findSessionsByShortIds — batch 20 short ids in one IN query (tmux scan, db.ts:3240)', () => {
    findSessionsByShortIds(realShortIds);
  });
});

describe.skipIf(!haveRealDb)('ftsSearch — interactive full-text + label search', () => {
  bench('ftsSearch("rush") — multi-term content + label tiers', () => {
    ftsSearch('rush');
  });

  bench('ftsSearch("a") — single-char label type-ahead (FTS label column)', () => {
    ftsSearch('a');
  });

  bench('ftsSearch("session index perf") — 3-term OR query', () => {
    ftsSearch('session index perf');
  });
});
