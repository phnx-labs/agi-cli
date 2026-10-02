import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from '../sqlite.js';
import {
  recordUsage,
  countUsage,
  kindMix,
  topNamesByKind,
  queryUsage,
  closeUsageDb,
} from './usage-db.js';

const tmpDirs: string[] = [];
let prevNoTrack: string | undefined;
let prevDbPath: string | undefined;
let prevSecretsDb: string | undefined;

function pinDb(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-analytics-usage-'));
  tmpDirs.push(d);
  const dbPath = path.join(d, 'usage.db');
  process.env.AGENTS_USAGE_DB = dbPath;
  process.env.AGENTS_SECRETS_DB = path.join(d, 'secrets-legacy.db');
  return dbPath;
}

beforeEach(() => {
  prevNoTrack = process.env.AGENTS_NO_USAGE_TRACK;
  prevDbPath = process.env.AGENTS_USAGE_DB;
  prevSecretsDb = process.env.AGENTS_SECRETS_DB;
  delete process.env.AGENTS_NO_USAGE_TRACK;
  closeUsageDb();
  pinDb();
});

afterEach(() => {
  closeUsageDb();
  if (prevNoTrack === undefined) delete process.env.AGENTS_NO_USAGE_TRACK;
  else process.env.AGENTS_NO_USAGE_TRACK = prevNoTrack;
  if (prevDbPath === undefined) delete process.env.AGENTS_USAGE_DB;
  else process.env.AGENTS_USAGE_DB = prevDbPath;
  if (prevSecretsDb === undefined) delete process.env.AGENTS_SECRETS_DB;
  else process.env.AGENTS_SECRETS_DB = prevSecretsDb;
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tmpDirs.length = 0;
});

describe('analytics usage warehouse', () => {
  it('records and queries cross-kind events', () => {
    recordUsage({ kind: 'secret', name: 'npm', event: 'access', agent: 'claude' });
    recordUsage({ kind: 'browser', name: 'default', event: 'launch' });
    recordUsage({ kind: 'agent', name: 'claude', event: 'run' });
    recordUsage({ kind: 'browser', name: 'default', event: 'close' });

    const since = new Date(Date.now() - 60_000).toISOString();
    expect(countUsage({ sinceIso: since })).toBe(4);
    expect(countUsage({ kind: 'browser', sinceIso: since })).toBe(2);
    expect(topNamesByKind('browser', since).map((r) => r.name)).toEqual(['default']);
    expect(kindMix(since).map((r) => r.kind).sort()).toEqual(['agent', 'browser', 'secret']);
    const rows = queryUsage({ kind: 'secret', sinceIso: since });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('npm');
    expect(rows[0].agent).toBe('claude');
  });

  it('migrates legacy secrets.db usage_events into kind=secret once', () => {
    const secretsPath = process.env.AGENTS_SECRETS_DB!;
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    const legacy = new Database(secretsPath);
    legacy.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        bundle TEXT NOT NULL,
        event TEXT NOT NULL,
        agent TEXT,
        host TEXT,
        source TEXT,
        status TEXT,
        key_count INTEGER
      );
    `);
    legacy.prepare(
      `INSERT INTO usage_events (ts, bundle, event, agent, host, source, status, key_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), 'legacy-bundle', 'access', 'codex', 'zion', 'cli', 'success', 2);
    legacy.close();

    const since = '2020-01-01T00:00:00.000Z';
    expect(countUsage({ kind: 'secret', sinceIso: since, name: 'legacy-bundle' })).toBe(1);
    closeUsageDb();
    expect(countUsage({ kind: 'secret', sinceIso: since, name: 'legacy-bundle' })).toBe(1);
  });
});
