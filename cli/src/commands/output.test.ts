import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB (and repo scan root) under a temp HOME before any
// module that captures the DB path at import time loads.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-output-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
// Build the FULL `insights` parent (which owns --json/--since/--by) so the
// parent↔leaf option-name collision this command hit in production is exercised,
// not a bare stand-in parent that never collides (the gap that let the bug ship).
const { registerInsightsCommand } = await import('../commands/insights.js');
const { upsertSession, closeDB } = await import('../lib/session/db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

const FILES_DIR = path.join(TEST_HOME, 'output-cmd-files');
fs.mkdirSync(FILES_DIR, { recursive: true });

interface Split {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdNoCache: number;
}

function seed(
  id: string,
  agent: SessionMeta['agent'],
  timestamp: string,
  costUsd: number,
  outputTokens: number,
  tokenCount: number,
  project: string,
  split?: Split,
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
    topic: `${agent} work`,
    costUsd,
    outputTokens,
    tokenCount,
    ...(split ?? {}),
  };
  upsertSession(meta, '');
}

/** Run `agents insights output <args>` capturing stdout (JSON) and console.log (TTY). */
async function runOutput(args: string[]): Promise<string> {
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
    await program.parseAsync(['node', 'agents', 'insights', 'output', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
  }
  return chunks.join('\n');
}

// A wide --since so the fixed-date seeds are always in-window; --no-prs to keep
// tests offline (real gh is not mocked — that path is exercised manually).
const BASE = ['--since', '2020-01-01', '--no-prs'];

describe('agents insights output', () => {
  beforeAll(() => {
    // token_count is deliberately >> outputTokens to model cache-read inflation.
    // The split (input/cache-read/cache-write) and cost_usd_nocache are seeded so
    // the rollup + --pricing no-cache scenario have real numbers (RUSH-2287).
    // Per session: costUsdNoCache > costUsd (caching is a discount).
    seed('big0001', 'claude', '2026-05-20T10:00:00.000Z', 30, 1_000_000, 50_000_000, 'rush',
      { inputTokens: 2_000_000, cacheReadTokens: 46_000_000, cacheWriteTokens: 1_000_000, costUsdNoCache: 90 });
    seed('mid0002', 'claude', '2026-05-21T10:00:00.000Z', 10, 400_000, 12_000_000, 'agents-cli',
      { inputTokens: 1_000_000, cacheReadTokens: 10_500_000, cacheWriteTokens: 100_000, costUsdNoCache: 25 });
    seed('cdx0003', 'codex', '2026-05-21T12:00:00.000Z', 2, 100_000, 3_000_000, 'agents-cli',
      { inputTokens: 500_000, cacheReadTokens: 2_400_000, cacheWriteTokens: 0, costUsdNoCache: 5 });
  });

  afterAll(() => {
    closeDB();
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('--json leads with real output tokens, not the inflated total', async () => {
    const out = await runOutput([...BASE, '--json']);
    const d = JSON.parse(out);
    expect(d.pricingVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.burn.sessionCount).toBe(3);
    expect(d.burn.costUsd).toBeCloseTo(42, 5);
    expect(d.burn.outputTokens).toBe(1_500_000);
    // The honest metric is far below the cache-inflated total.
    expect(d.burn.tokenCount).toBe(65_000_000);
    expect(d.burn.outputTokens).toBeLessThan(d.burn.tokenCount / 10);
  });

  it('computes burn-vs-output ratios', async () => {
    const out = await runOutput([...BASE, '--json']);
    const d = JSON.parse(out);
    // No PRs/commits in the temp HOME, so per-PR/per-commit are null...
    expect(d.ratios.costPerPr).toBeNull();
    expect(d.ratios.costPerCommit).toBeNull();
    // ...but output-tokens-per-dollar is defined: 1.5M / $42.
    expect(d.ratios.outputTokensPerUsd).toBeCloseTo(1_500_000 / 42, 2);
  });

  it('--by agent breakdown carries per-agent output tokens', async () => {
    const out = await runOutput([...BASE, '--by', 'agent', '--json']);
    const d = JSON.parse(out);
    expect(d.breakdown.by).toBe('agent');
    const byKey = Object.fromEntries(d.breakdown.rows.map((r: any) => [r.key, r]));
    expect(byKey.claude.outputTokens).toBe(1_400_000);
    expect(byKey.codex.outputTokens).toBe(100_000);
  });

  it('--by project groups by project', async () => {
    const out = await runOutput([...BASE, '--by', 'project', '--json']);
    const d = JSON.parse(out);
    const keys = d.breakdown.rows.map((r: any) => r.key);
    expect(keys).toContain('rush');
    expect(keys).toContain('agents-cli');
  });

  it('honors flags that collide by name with the insights parent (--json/--since/--by)', async () => {
    // --json, --since and --by all exist on the `insights` PARENT too, so
    // commander binds them there at parse time; the leaf must read them via
    // optsWithGlobals() or every one is silently dropped. Before the fix,
    // `insights output --json` printed the human table (invalid JSON) and
    // `--by project` fell back to the default agent grouping.
    const jsonOut = await runOutput(['--since', '2020-01-01', '--no-prs', '--json']);
    expect(() => JSON.parse(jsonOut)).not.toThrow();
    const byProject = JSON.parse(await runOutput(['--since', '2020-01-01', '--no-prs', '--by', 'project', '--json']));
    expect(byProject.breakdown.by).toBe('project');
    // A narrow --since must actually window the data (parent-captured flag reaches the leaf).
    const narrow = JSON.parse(await runOutput(['--since', '2026-05-21T00:00:00.000Z', '--no-prs', '--json']));
    expect(narrow.burn.sessionCount).toBe(2); // big0001 (2026-05-20) excluded
  });

  it('renders the burn/output table and shipped section in TTY mode', async () => {
    const out = await runOutput([...BASE]);
    expect(out).toContain('Output');
    expect(out).toContain('burned');
    expect(out).toContain('output tokens');
    expect(out).toContain('By agent');
    expect(out).toContain('Shipped');
    // Compact token formatting (1.5M).
    expect(out).toMatch(/\dM|\dK/);
    // Honesty footer present.
    expect(out).toContain('not counted');
  });

  it('--json carries the input / cache-read / cache-write burn split (RUSH-2287)', async () => {
    const out = await runOutput([...BASE, '--json']);
    const d = JSON.parse(out);
    expect(d.burn.inputTokens).toBe(3_500_000);       // 2M + 1M + 0.5M
    expect(d.burn.cacheReadTokens).toBe(58_900_000);  // 46M + 10.5M + 2.4M
    expect(d.burn.cacheWriteTokens).toBe(1_100_000);  // 1M + 0.1M + 0
    // Split fields also ride each breakdown row.
    const byKey = Object.fromEntries(
      (await runOutput([...BASE, '--by', 'agent', '--json']).then(JSON.parse)).breakdown.rows.map(
        (r: any) => [r.key, r],
      ),
    );
    expect(byKey.claude.inputTokens).toBe(3_000_000);      // 2M + 1M
    expect(byKey.claude.cacheReadTokens).toBe(56_500_000); // 46M + 10.5M
    expect(byKey.codex.cacheWriteTokens).toBe(0);
  });

  it('--json carries both actual and no-cache costs regardless of scenario', async () => {
    const d = JSON.parse(await runOutput([...BASE, '--json']));
    expect(d.burn.costUsd).toBeCloseTo(42, 5);         // 30 + 10 + 2
    expect(d.burn.costUsdNoCache).toBeCloseTo(120, 5); // 90 + 25 + 5
    // No-cache is strictly higher — caching is a discount.
    expect(d.burn.costUsdNoCache).toBeGreaterThan(d.burn.costUsd);
    // The scenario flag does not change the JSON payload.
    const d2 = JSON.parse(await runOutput([...BASE, '--pricing', 'no-cache', '--json']));
    expect(d2.burn.costUsd).toBeCloseTo(42, 5);
    expect(d2.burn.costUsdNoCache).toBeCloseTo(120, 5);
  });

  it('TTY shows the burn split line and the caching comparison', async () => {
    const out = await runOutput([...BASE]);
    expect(out).toContain('burn split:');
    expect(out).toContain('input');
    expect(out).toContain('cache-read');
    expect(out).toContain('cache-write');
    // Actual mode still surfaces the saving.
    expect(out).toContain('caching:');
    expect(out).toContain('no-cache');
  });

  it('--pricing no-cache leads the burn with the no-cache figure', async () => {
    const out = await runOutput([...BASE, '--pricing', 'no-cache']);
    expect(out).toContain('(no-cache)');
    // $120.00 no-cache is the headline; $42.00 actual still appears in the comparison.
    expect(out).toContain('$120.00');
    expect(out).toContain('$42.00');
    // Breakdown header switches to the no-cache column label.
    expect(out).toContain('burn(nc)');
  });

  it('rejects an unknown --pricing scenario', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('exit');
    }) as any);
    try {
      await expect(runOutput([...BASE, '--pricing', 'bogus'])).rejects.toThrow();
      expect(errSpy.mock.calls.flat().join(' ')).toContain('--pricing must be one of');
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
