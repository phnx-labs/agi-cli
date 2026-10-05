import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordMigration,
  readMigrations,
  latestForSession,
  type MigrationRecord,
} from './migrations.js';

let dir: string;
let ledger: string;

function rec(over: Partial<MigrationRecord>): MigrationRecord {
  return {
    sessionId: 'sess-a',
    shortId: 'sessa',
    agent: 'claude',
    mode: 'rehydrate',
    move: true,
    from: { host: 'src', cwd: '/w' },
    to: { host: 'dst' },
    at: '2026-08-01T00:00:00.000Z',
    status: 'completed',
    ...over,
  };
}

describe('migration ledger', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migledger-'));
    ledger = path.join(dir, 'migrations.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips and creates the ledger under a missing dir', () => {
    expect(readMigrations(ledger)).toEqual([]);
    recordMigration(rec({ at: '2026-08-01T00:00:01.000Z' }), ledger);
    const all = readMigrations(ledger);
    expect(all.length).toBe(1);
    expect(all[0].sessionId).toBe('sess-a');
  });

  it('latestForSession returns the most recent COMPLETED hop for that id', () => {
    recordMigration(rec({ sessionId: 'sess-a', to: { host: 'box-1' }, at: '2026-08-01T00:00:01.000Z' }), ledger);
    recordMigration(rec({ sessionId: 'sess-b', to: { host: 'box-x' }, at: '2026-08-01T00:00:02.000Z' }), ledger);
    recordMigration(rec({ sessionId: 'sess-a', to: { host: 'box-2' }, at: '2026-08-01T00:00:03.000Z' }), ledger);
    recordMigration(rec({ sessionId: 'sess-a', to: { host: 'box-3' }, status: 'failed', at: '2026-08-01T00:00:04.000Z' }), ledger);

    expect(latestForSession('sess-a', ledger)?.to.host).toBe('box-2');
    expect(latestForSession('sess-b', ledger)?.to.host).toBe('box-x');
    expect(latestForSession('nope', ledger)).toBeUndefined();
  });

  it('skips a corrupt/partial line instead of throwing', () => {
    recordMigration(rec({ sessionId: 'good-1', at: '2026-08-01T00:00:01.000Z' }), ledger);
    fs.appendFileSync(ledger, '{ this is not json\n');
    recordMigration(rec({ sessionId: 'good-2', at: '2026-08-01T00:00:02.000Z' }), ledger);
    expect(readMigrations(ledger).map((r) => r.sessionId)).toEqual(['good-1', 'good-2']);
  });
});
