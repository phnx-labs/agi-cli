import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-affinity-'));
process.env.HOME = TEST_HOME;

const { getDB, closeDB, upsertSession, queryAffinityRollup } = await import('../db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FILES = path.join(TEST_HOME, 'files');
fs.mkdirSync(FILES, { recursive: true });

function seed(partial: {
  id: string;
  agent?: SessionMeta['agent'];
  machine?: string;
  timestamp: string;
  isTeamOrigin?: boolean;
  origin?: 'cli' | 'routine';
  tokenCount?: number;
}): void {
  const filePath = path.join(FILES, `${partial.id}.jsonl`);
  fs.writeFileSync(filePath, '');
  upsertSession(
    {
      id: partial.id,
      shortId: partial.id.slice(0, 8),
      agent: partial.agent ?? 'claude',
      timestamp: partial.timestamp,
      filePath,
      machine: partial.machine,
      isTeamOrigin: partial.isTeamOrigin,
      origin: partial.origin,
      tokenCount: partial.tokenCount,
    },
    '',
  );
}

describe('queryAffinityRollup + machine persistence', () => {
  beforeAll(() => {
    // Touch DB so schema v17 migrates on a fresh home.
    getDB();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    seed({
      id: 'a1',
      machine: 'yosemite-s1',
      agent: 'claude',
      timestamp: new Date(now - 1 * day).toISOString(),
      tokenCount: 100,
    });
    seed({
      id: 'a2',
      machine: 'yosemite-s1',
      agent: 'claude',
      timestamp: new Date(now - 2 * day).toISOString(),
      tokenCount: 50,
    });
    seed({
      id: 'a3',
      machine: 'yosemite-s0',
      agent: 'codex',
      timestamp: new Date(now - 3 * day).toISOString(),
      tokenCount: 200,
    });
    seed({
      id: 'team1',
      machine: 'yosemite-s1',
      agent: 'claude',
      timestamp: new Date(now - 1 * day).toISOString(),
      isTeamOrigin: true,
    });
    seed({
      id: 'old',
      machine: 'ancient-box',
      agent: 'claude',
      timestamp: new Date(now - 40 * day).toISOString(),
    });
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('persists machine on upsert and groups by machine', () => {
    const rows = queryAffinityRollup({ groupBy: 'machine', sinceMs: Date.now() - 14 * 24 * 60 * 60 * 1000 });
    const s1 = rows.find((r) => r.key === 'yosemite-s1');
    const s0 = rows.find((r) => r.key === 'yosemite-s0');
    expect(s1?.launches).toBe(2); // team excluded
    expect(s0?.launches).toBe(1);
    expect(s1!.launches).toBeGreaterThan(s0!.launches);
  });

  it('groups by agent with allowlist', () => {
    const rows = queryAffinityRollup({
      groupBy: 'agent',
      agents: ['claude', 'codex'],
      sinceMs: Date.now() - 14 * 24 * 60 * 60 * 1000,
    });
    expect(rows.find((r) => r.key === 'claude')?.launches).toBe(2);
    expect(rows.find((r) => r.key === 'codex')?.launches).toBe(1);
  });

  it('stores machine column on the row', () => {
    const db = getDB();
    const row = db.prepare(`SELECT machine FROM sessions WHERE id = ?`).get('a1') as { machine: string };
    expect(row.machine).toBe('yosemite-s1');
  });
});
