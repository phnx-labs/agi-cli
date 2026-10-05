import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordSpend,
  loadLedger,
  spendForDay,
  spendForAgent,
  spendForAgentDay,
  spendForProject,
  spendForRun,
  localDay,
} from './ledger.js';

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-ledger-'));
  ledgerPath = path.join(tmpDir, 'spend', 'ledger.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('recordSpend', () => {
  it('computes costUsd from token usage via the pricing module (claude-opus-4)', () => {
    const entry = recordSpend(
      {
        runId: 'r1',
        agent: 'claude',
        project: '/proj',
        model: 'claude-opus-4',
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        source: 'run',
      },
      ledgerPath,
    );
    expect(entry.costUsd).toBeCloseTo(30, 6);
    expect(entry.day).toBe(localDay());
    expect(fs.existsSync(ledgerPath)).toBe(true);
  });

  it('appends (never overwrites) across calls', () => {
    recordSpend({ runId: 'r1', agent: 'claude', model: 'claude-opus-4', usage: { inputTokens: 100 }, source: 'run' }, ledgerPath);
    recordSpend({ runId: 'r2', agent: 'codex', model: 'gpt-5', usage: { inputTokens: 100 }, source: 'run' }, ledgerPath);
    expect(loadLedger(ledgerPath)).toHaveLength(2);
  });

  it('records unpriced models as $0 (additive, never NaN)', () => {
    const entry = recordSpend({ runId: 'r1', agent: 'claude', model: 'nope-9000', usage: { inputTokens: 1_000_000 }, source: 'run' }, ledgerPath);
    expect(entry.costUsd).toBe(0);
  });
});

describe('rollups', () => {
  beforeEach(() => {
    const today = new Date();
    recordSpend({ runId: 'rA', agent: 'claude', project: '/proj', model: 'claude-opus-4', usage: { inputTokens: 1_000_000 }, source: 'run', ts: today }, ledgerPath);
    recordSpend({ runId: 'rA', agent: 'claude', project: '/proj', model: 'claude-opus-4', usage: { outputTokens: 1_000_000 }, source: 'run', ts: today }, ledgerPath);
    recordSpend({ runId: 'rB', agent: 'codex', project: '/proj', model: 'gpt-5', usage: { inputTokens: 1_000_000 }, source: 'run', ts: today }, ledgerPath);
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    recordSpend({ runId: 'rC', agent: 'claude', project: '/other', model: 'claude-opus-4', usage: { inputTokens: 1_000_000 }, source: 'run', ts: yesterday }, ledgerPath);
  });

  it('spendForRun sums all observations of one run', () => {
    expect(spendForRun('rA', loadLedger(ledgerPath))).toBeCloseTo(30, 6);
  });

  it('spendForDay aggregates ACROSS vendors (cross-vendor cap)', () => {
    expect(spendForDay(localDay(), loadLedger(ledgerPath))).toBeCloseTo(31.25, 6);
  });

  it('spendForAgentDay isolates one agent on one day', () => {
    expect(spendForAgentDay('claude', localDay(), loadLedger(ledgerPath))).toBeCloseTo(30, 6);
    expect(spendForAgentDay('codex', localDay(), loadLedger(ledgerPath))).toBeCloseTo(1.25, 6);
  });

  it('spendForAgent sums all-time across days', () => {
    expect(spendForAgent('claude', loadLedger(ledgerPath))).toBeCloseTo(35, 6);
  });

  it('spendForProject sums all-time for one project', () => {
    expect(spendForProject('/proj', loadLedger(ledgerPath))).toBeCloseTo(31.25, 6);
    expect(spendForProject('/other', loadLedger(ledgerPath))).toBeCloseTo(5, 6);
  });
});

describe('loadLedger resilience', () => {
  it('skips a torn final line rather than throwing', () => {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({ runId: 'r1', agent: 'claude', project: '', day: localDay(), model: 'claude-opus-4', inputTok: 0, outputTok: 0, cacheTok: 0, costUsd: 1, source: 'run', ts: new Date().toISOString() }) + '\n{ partial');
    const entries = loadLedger(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].costUsd).toBe(1);
  });
});
