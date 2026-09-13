/**
 * Append-only spend ledger (issue #346).
 *
 * Every dispatched run that produces token usage records one JSONL line under
 * `<history>/spend/ledger.jsonl`. The ledger is the shared artifact #323's
 * `agents insights cost` can later read for $ rollups, so the entry shape stays clean
 * and stable: one record = one usage observation attributed to a run.
 *
 * `costUsd` is computed at write time via the canonical pricing module
 * (lib/pricing) so the ledger is self-contained — a reader never needs the
 * pricing table to sum spend. Rollups (`spendForDay`/`spendForAgent`/...) are
 * pure folds over the file; for the modest line counts a developer accrues this
 * is plenty fast, and there's no index to corrupt.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir } from '../state.js';
import { actualCost } from '../pricing/index.js';

/** A single spend observation. Append-only; never mutated in place. */
export interface SpendEntry {
  /** Run identifier — groups multiple usage observations from one dispatch. */
  runId: string;
  /** Agent id (claude, codex, ...). The cross-vendor attribution key. */
  agent: string;
  /** Project key (absolute path or repo slug). Empty string when unknown. */
  project: string;
  /** Local calendar day, YYYY-MM-DD. */
  day: string;
  /** Model id as reported by the stream (may carry vendor prefix / date suffix). */
  model: string;
  inputTok: number;
  outputTok: number;
  /** Combined cache read + creation tokens (kept as one field for the ledger). */
  cacheTok: number;
  /** USD cost of THIS observation, via actualCost() at write time. */
  costUsd: number;
  /** Where the spend came from: local run, teams teammate, or cloud dispatch. */
  source: 'run' | 'teams' | 'cloud';
  /** ISO timestamp of the observation. */
  ts: string;
}

/** Token bundle for a single observation (matches session/parse usage fields). */
export interface UsageObservation {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Default ledger path: <history>/spend/ledger.jsonl. */
function defaultLedgerPath(): string {
  return path.join(getHistoryDir(), 'spend', 'ledger.jsonl');
}

/** Local YYYY-MM-DD for a Date (defaults to now). Local, not UTC — caps are a human-day notion. */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Append one spend observation. Computes `costUsd` from the usage via the
 * canonical pricing module (unpriced models contribute $0). Returns the written
 * entry. Creates the spend dir on first write.
 */
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

/** Load every entry. Skips malformed lines (a half-written final line never breaks a rollup). */
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
      // Tolerate a torn final line; everything before it is intact.
    }
  }
  return out;
}

function sum(entries: SpendEntry[], pred: (e: SpendEntry) => boolean): number {
  let total = 0;
  for (const e of entries) if (pred(e)) total += e.costUsd;
  return total;
}

/** Total USD spend on a given local day across ALL agents (cross-vendor). */
export function spendForDay(day: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.day === day);
}

/** Total USD spend on a given day for ONE agent (per-agent cap accounting). */
export function spendForAgentDay(agent: string, day: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.agent === agent && e.day === day);
}

/** Total USD spend attributed to an agent across all time. */
export function spendForAgent(agent: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.agent === agent);
}

/** Total USD spend attributed to a project across all time (cross-vendor). */
export function spendForProject(project: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.project === project);
}

/** Total USD spend for a single run id (all of its usage observations). */
export function spendForRun(runId: string, ledger: SpendEntry[] = loadLedger()): number {
  return sum(ledger, (e) => e.runId === runId);
}
