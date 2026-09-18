import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before any module that captures
// the DB path at import time loads.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-cost-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
// Build the FULL `insights` parent (which owns --json/--since/--by) so the
// parent↔leaf option-name collision this command hit in production is exercised,
// not a bare stand-in parent that never collides (the gap that let the bug ship).
const { registerInsightsCommand } = await import('../commands/insights.js');
const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { costOfUsage } = await import('../lib/pricing/index.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FILES_DIR = path.join(TEST_HOME, 'cost-cmd-files');
fs.mkdirSync(FILES_DIR, { recursive: true });

function seed(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number,
  durationMs: number,
  project: string,
  topic: string,
  model?: string,
  outputTokens?: number,
): void {
  const filePath = path.join(FILES_DIR, `${id}.jsonl`);
  fs.writeFileSync(filePath, '');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent,
    timestamp,
    project,
    cwd: FILES_DIR,
    filePath,
    topic,
    costUsd,
    durationMs,
    model,
    outputTokens,
  };
  upsertSession(meta, '');
}

/** Run `agents insights cost <args>` capturing stdout (JSON path) and console.log (TTY path). */
async function runCost(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerInsightsCommand(program);

  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    chunks.push(a.join(' '));
  });
  try {
    await program.parseAsync(['node', 'agents', 'insights', 'cost', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return chunks.join('\n');
}

describe('agents insights cost', () => {
  beforeAll(() => {
    // Two priced opus sessions and one haiku, spread over two days / projects.
    const big = costOfUsage({ model: 'claude-opus-4', inputTokens: 2_000_000, outputTokens: 1_000_000 });   // ~$35
    const mid = costOfUsage({ model: 'claude-opus-4', inputTokens: 1_000_000, outputTokens: 200_000 });      // ~$10
    const small = costOfUsage({ model: 'claude-haiku-4', inputTokens: 500_000, outputTokens: 100_000 });     // ~$1
    seed('big0001', 'claude', '2026-05-20T10:00:00.000Z', big, 3_600_000, 'rush', 'expensive refactor with a long topic that used to push narrow terminals past eighty columns', 'claude-opus-4-20250514', 1_000_000);
    seed('mid0002', 'claude', '2026-05-21T10:00:00.000Z', mid, 1_800_000, 'agents-cli', 'mid task', 'claude-opus-4', 200_000);
    seed('sml0003', 'codex', '2026-05-21T12:00:00.000Z', small, 300_000, 'agents-cli', 'small fix', 'claude-haiku-4', 100_000);
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('--json reports totals, daily, breakdown, and topSessions', async () => {
    const out = await runCost(['--json']);
    const data = JSON.parse(out);
    expect(data.pricingVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.totals.sessionCount).toBe(3);
    expect(data.totals.costUsd).toBeGreaterThan(0);
    // top sessions ordered by cost desc, priciest first
    expect(data.topSessions[0].id).toBe('big0001');
    expect(data.topSessions[0].costUsd).toBeGreaterThan(data.topSessions[1].costUsd);
    // daily has the two seeded days
    const dailyKeys = data.daily.map((d: any) => d.key);
    expect(dailyKeys).toContain('2026-05-20');
    expect(dailyKeys).toContain('2026-05-21');
  });

  it('renders a histogram, top-sessions, and per-agent breakdown in TTY mode', async () => {
    const out = await runCost([]);
    expect(out).toContain('Daily');
    expect(out).toContain('Top sessions by cost');
    expect(out).toContain('By agent');
    // sparkline block char present
    expect(out).toMatch(/[▁▂▃▄▅▆▇█]/);
    // priciest session topic surfaces
    expect(out).toContain('expensive refactor');
    // dollar figure rendered cents-precise
    expect(out).toMatch(/\$\d+\.\d{2}/);
  });

  it('keeps human output within an 80-column terminal', async () => {
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      const out = await runCost([]);
      const lines = out.split('\n');
      expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
      const topRows = lines.filter((line) => line.includes('big0001'));
      expect(topRows).toHaveLength(1);
      expect(topRows[0]).not.toContain(' rush ');
    } finally {
      if (prev === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = prev;
    }
  });

  it('--by project groups the breakdown by project', async () => {
    const out = await runCost(['--by', 'project', '--json']);
    const data = JSON.parse(out);
    expect(data.breakdown.by).toBe('project');
    const keys = data.breakdown.rows.map((r: any) => r.key);
    expect(keys).toContain('rush');
    expect(keys).toContain('agents-cli');
  });

  it('--by model returns shortened per-model output-token and cost rows', async () => {
    const out = await runCost(['--by', 'model', '--json']);
    const data = JSON.parse(out);
    expect(data.breakdown.by).toBe('model');

    const opus = data.breakdown.rows.find((r: any) => r.key === 'opus-4');
    expect(opus.outputTokens).toBe(1_200_000);
    expect(opus.costUsd).toBeCloseTo(
      costOfUsage({ model: 'claude-opus-4', inputTokens: 2_000_000, outputTokens: 1_000_000 })
      + costOfUsage({ model: 'claude-opus-4', inputTokens: 1_000_000, outputTokens: 200_000 }),
      5,
    );

    const haiku = data.breakdown.rows.find((r: any) => r.key === 'haiku-4');
    expect(haiku.outputTokens).toBe(100_000);
    expect(haiku.costUsd).toBeGreaterThan(0);
  });
});
