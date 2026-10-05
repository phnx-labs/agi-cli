import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, bench } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { getSessionsDbPath } from '../state.js';

const REAL_DB = path.join(os.homedir(), '.agents', '.history', 'sessions', 'sessions.db');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-dbbench-'));
const SNAPSHOT = path.join(TMP, 'sessions.db');
const haveRealDb = fs.existsSync(REAL_DB) && fs.statSync(REAL_DB).size > 0;
if (haveRealDb) {
  const src = new DatabaseSync(REAL_DB, { readOnly: true });
  src.exec(`VACUUM INTO '${SNAPSHOT.replace(/'/g, "''")}'`);
  src.close();
  process.env.AGENTS_SESSIONS_DB = SNAPSHOT;
}

const dbmod = await import('./db.js');
const { querySessions, countSessions, getSessionById, findSessionsById, findSessionsByShortIds, ftsSearch, closeDB } = dbmod;

const sample = haveRealDb ? querySessions({ limit: 40, skipExistenceCheck: true }) : [];
const realId = sample[0]?.id ?? '';
const realShortIds = sample.map((s) => s.shortId).filter((s): s is string => !!s).slice(0, 20);
const realIdPrefix = realId ? realId.slice(0, 8) : '';

afterAll(() => {
  try { closeDB(); } catch {  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
});

describe.skipIf(!haveRealDb)('querySessions — session listing (agents sessions)', () => {
  bench('full listing, cached existence check ON', () => {
    querySessions({});
  });

  bench('full listing, skipExistenceCheck (SQL + rowToMeta only, no fs)', () => {
    querySessions({ skipExistenceCheck: true });
  });

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
