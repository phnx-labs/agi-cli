/** Append-only spend ledger (issue #346): each run with token usage records a JSONL line under
 * `<history>/spend/ledger.jsonl`, which `agents insights cost` (#323) can read. `costUsd` is
 * computed at write time via lib/pricing, so readers need no pricing table. */
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir } from '../state.js';
import { actualCost } from '../pricing/index.js';

export interface SpendEntry {
  runId: string;
  agent: string;
  project: string;
  day: string;
  model: string;
  inputTok: number;
  outputTok: number;
  cacheTok: number;
  costUsd: number;
  source: 'run' | 'teams' | 'cloud';
  ts: string;
}

export interface UsageObservation {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

function defaultLedgerPath(): string {
  return path.join(getHistoryDir(), 'spend', 'ledger.jsonl');
}

export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Append one spend observation, computing `costUsd` via the pricing module (unpriced models
 * contribute $0). Returns the entry; creates the spend dir on first write. */
export function recordSpend(
  input: {
    runId: string;
    agent: string;
    project?: string;
    model: string;
    usage: UsageObservation;
    source: SpendEntry['source'];
    ts?: Date;
  },
  ledgerPath: string = defaultLedgerPath(),
): SpendEntry {
  const ts = input.ts ?? new Date();
  const cacheTok = (input.usage.cacheReadTokens ?? 0) + (input.usage.cacheCreationTokens ?? 0);
  const { usd } = actualCost(input.model, {
    inputTokens: input.usage.inputTokens ?? 0,
    outputTokens: input.usage.outputTokens ?? 0,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheCreationTokens: input.usage.cacheCreationTokens,
  });
  const entry: SpendEntry = {
    runId: input.runId,
    agent: input.agent,
    project: input.project ?? '',
    day: localDay(ts),
    model: input.model,
    inputTok: input.usage.inputTokens ?? 0,
    outputTok: input.usage.outputTokens ?? 0,
    cacheTok,
    costUsd: usd,
    source: input.source,
    ts: ts.toISOString(),
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  return entry;
}

export function loadLedger(ledgerPath: string = defaultLedgerPath()): SpendEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const out: SpendEntry[] = [];
  for (const line of fs.readFileSync(ledgerPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SpendEntry;
      if (typeof parsed.costUsd === 'number') out.push(parsed);
    } catch {
    }
  }
  return out;
}

function sum(entries: SpendEntry[], pred: (e: SpendEntry) => boolean): number {
  let total = 0;
  for (const e of entries) if (pred(e)) total += e.costUsd;
  return total;
}

export function spendForDay(day: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.day === day);
}

export function spendForAgentDay(agent: string, day: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.agent === agent && e.day === day);
}

export function spendForAgent(agent: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.agent === agent);
}

export function spendForProject(project: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.project === project);
}

export function spendForRun(runId: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.runId === runId);
}
