import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-budget-test-'));
process.env.HOME = TEST_HOME;

const { Command } = await import('commander');
const { registerBudgetCommand } = await import('./budget.js');
const { recordSpend, localDay } = await import('../lib/budget/ledger.js');
const { getHistoryDir } = await import('../lib/state.js');

const PROJECT = TEST_HOME;
const userYaml = path.join(TEST_HOME, '.agents', 'agents.yaml');

function writeBudget(yamlBody: string): void {
  fs.mkdirSync(path.dirname(userYaml), { recursive: true });
  fs.writeFileSync(userYaml, yamlBody);
}

async function runBudget(args: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  const config = program.command('config');
  registerBudgetCommand(config);

  const chunks: string[] = [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: any) => {
    chunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    chunks.push(a.join(' '));
  });
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(PROJECT);
  try {
    await program.parseAsync(['node', 'agents', 'config', 'budget', ...args]);
  } finally {
    writeSpy.mockRestore();
    logSpy.mockRestore();
    cwdSpy.mockRestore();
  }
  return chunks.join('\n');
}

const ledgerPath = () => path.join(getHistoryDir(), 'spend', 'ledger.jsonl');

describe('agents config budget', () => {
  beforeAll(() => {
    writeBudget('budget:\n  per_run: 5\n  per_day: 50\n  per_project: 100\n  on_exceed: block\n');
    recordSpend({ runId: 'rA', agent: 'claude', project: PROJECT, model: 'claude-opus-4', usage: { inputTokens: 1_000_000 }, source: 'run', ts: new Date() }, ledgerPath());
    recordSpend({ runId: 'rB', agent: 'codex', project: PROJECT, model: 'gpt-5', usage: { inputTokens: 1_000_000 }, source: 'run', ts: new Date() }, ledgerPath());
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('renders caps and spend-to-cap (cross-vendor day total)', async () => {
    const out = await runBudget([]);
    expect(out).toContain('per_run');
    expect(out).toContain('per_day');
    expect(out).toContain('per_project');
    expect(out).toContain('$6.25');
    expect(out).toContain('$50.00');
  });

  it('--json emits the full snapshot with cross-vendor spend', async () => {
    const out = await runBudget(['--json']);
    const parsed = JSON.parse(out);
    expect(parsed.caps.per_run).toBe(5);
    expect(parsed.caps.per_day).toBe(50);
    expect(parsed.on_exceed).toBe('block');
    expect(parsed.spend.day).toBeCloseTo(6.25, 6);
    expect(parsed.spend.project).toBeCloseTo(6.25, 6);
    expect(parsed.configured).toBe(true);
    expect(parsed.day).toBe(localDay());
  });

  it('shows "no caps configured" when budget is empty', async () => {
    writeBudget('');
    const out = await runBudget(['--json']);
    const parsed = JSON.parse(out);
    expect(parsed.configured).toBe(false);
  });
});
