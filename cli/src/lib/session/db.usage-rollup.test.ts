import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-rollup-test-'));
process.env.HOME = TEST_HOME;

const { upsertSession, queryUsageRollup, closeDB } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FILES = path.join(TEST_HOME, 'rollup-files');
fs.mkdirSync(FILES, { recursive: true });

function seed(id: string, meta: Partial<SessionMeta>): void {
  const filePath = path.join(FILES, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  upsertSession(
    {
      id,
      shortId: id.slice(0, 8),
      agent: 'claude',
      timestamp: '2026-05-20T10:00:00.000Z',
      cwd: FILES,
      filePath,
      ...meta,
    } as SessionMeta,
    '',
  );
}

describe('queryUsageRollup — burn split + no-cache (RUSH-2287)', () => {
  beforeAll(() => {
    seed('a', {
      agent: 'claude',
      costUsd: 30, costUsdNoCache: 90,
      outputTokens: 1_000_000, tokenCount: 50_000_000,
      inputTokens: 2_000_000, cacheReadTokens: 46_000_000, cacheWriteTokens: 1_000_000,
    });
    seed('b', {
      agent: 'claude',
      costUsd: 10, costUsdNoCache: 25,
      outputTokens: 400_000, tokenCount: 12_000_000,
      inputTokens: 1_000_000, cacheReadTokens: 10_500_000, cacheWriteTokens: 100_000,
    });
    seed('c', { agent: 'codex', costUsd: 5, outputTokens: 100_000, tokenCount: 3_000_000 });
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('sums the split columns across the window', () => {
    const rows = queryUsageRollup({ sinceMs: 0, groupBy: 'agent' });
    const total = rows.reduce(
      (acc, r) => {
        acc.inputTokens += r.inputTokens;
        acc.cacheReadTokens += r.cacheReadTokens;
        acc.cacheWriteTokens += r.cacheWriteTokens;
        acc.costUsd += r.costUsd;
        acc.costUsdNoCache += r.costUsdNoCache;
        return acc;
      },
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costUsdNoCache: 0 },
    );
    expect(total.inputTokens).toBe(3_000_000);
    expect(total.cacheReadTokens).toBe(56_500_000);
    expect(total.cacheWriteTokens).toBe(1_100_000);
    expect(total.costUsd).toBeCloseTo(45, 5);
    expect(total.costUsdNoCache).toBeCloseTo(120, 5);
  });

  it('the un-split row contributes its actual cost to the no-cache total', () => {
    const rows = queryUsageRollup({ sinceMs: 0, groupBy: 'agent' });
    const codex = rows.find(r => r.key === 'codex');
    expect(codex).toBeDefined();
    expect(codex!.costUsd).toBeCloseTo(5, 5);
    expect(codex!.costUsdNoCache).toBeCloseTo(5, 5);
    expect(codex!.inputTokens).toBe(0);
  });
});
