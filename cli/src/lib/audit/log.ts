/** Run-dispatch recording (issue #347): a thin write into the unified event stream
 * (`emit('run.dispatched')`). The old hash-chained audit log.jsonl stays readable via
 * readAuditLog/verifyAuditChain; new runs don't append there. See `agents events --include runs`. */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../staleness/fingerprint.js';
import { getHistoryDir } from '../state.js';
import { ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { emit } from '../feed/events.js';

/** First record's `prevHash` — a fixed anchor so the chain has a root. */
export const GENESIS_HASH = 'GENESIS';

/** A run's outcome, derived from its process exit code. */
export type AuditOutcome = 'ok' | 'fail';

/** One immutable audit record. `hash` seals every other field, `prevHash` included. */
export interface AuditRecord {
  ts:       string;        // ISO-8601 UTC timestamp of the append
  agent:    string;        // resolved agent id (claude, codex, ...)
  version:  string;        // resolved version the run executed with
  repo:     string;        // git remote origin url, else the cwd
  mode:     string;        // exec mode (plan/edit/auto/skip/...)
  outcome:  AuditOutcome;  // 'ok' when exit === 0, else 'fail'
  exit:     number;        // raw process exit code
  prevHash: string;        // previous record's hash (or GENESIS_HASH)
  hash:     string;        // sha256(canonicalJSON(this record without `hash`))
}

/** The caller-supplied fields — the chain fields (`prevHash`/`hash`) are computed here. */
export type AuditEntry = Omit<AuditRecord, 'prevHash' | 'hash'>;

/** Absolute path to the append-only audit log, under `.history/` (machine-local, gitignored, never
 * synced by `agents repo push/pull`), so the token-bearing `repo` field can't leak into a tracked
 * repo and no pull can fork the chain. */
export function getAuditLogPath(): string {
  return path.join(getHistoryDir(), 'audit', 'log.jsonl');
}

/** Deterministic JSON: keys sorted recursively so a logical record always hashes to the same bytes
 * across processes and machines. Values are primitives today; the recursion keeps it correct if
 * records nest. */
function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

/** Compute the sealing hash for a record whose `prevHash` is already set. */
function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return sha256(canonicalJSON(record));
}

/** Read + parse every record in the log, oldest-first. Missing file → []. */
function readRecords(logPath: string): AuditRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return []; // no log yet
  }
  const records: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as AuditRecord);
  }
  return records;
}

/** Append one record to the hash chain and return it: link to the previous `hash` (or
 * GENESIS_HASH), seal, write one JSONL line, synchronously. Read-last-hash + append run under
 * `withFileLock`; without it parallel writers fork the chain into a false "tampered" verdict. */
export function appendAuditRecord(entry: AuditEntry, logPath: string = getAuditLogPath()): AuditRecord {
  ensureLockTarget(logPath);
  return withFileLock(logPath, () => {
    const existing = readRecords(logPath);
    const prevHash = existing.length ? existing[existing.length - 1].hash : GENESIS_HASH;
    const unsealed: Omit<AuditRecord, 'hash'> = { ...entry, prevHash };
    const record: AuditRecord = { ...unsealed, hash: hashRecord(unsealed) };
    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
    return record;
  });
}

/** Walk the chain: a record is valid when its `prevHash` matches the prior `hash` (GENESIS for the
 * first) and recomputing its sealing hash reproduces the stored `hash`. `brokenAt` is the first
 * failing index. */
export function verifyAuditChain(logPath: string = getAuditLogPath()): { ok: boolean; brokenAt?: number } {
  let records: AuditRecord[];
  try {
    records = readRecords(logPath);
  } catch (err) {
    // A line that won't even parse is itself tamper evidence — the log is corrupt.
    return { ok: false, brokenAt: 0 };
  }

  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prevHash !== expectedPrev) return { ok: false, brokenAt: i };
    const { hash, ...unsealed } = r;
    if (hashRecord(unsealed) !== hash) return { ok: false, brokenAt: i };
    expectedPrev = r.hash;
  }
  return { ok: true };
}

/** Read the whole chain, oldest-first. Exposed for `agents events audit verify`. */
export function readAuditLog(logPath: string = getAuditLogPath()): AuditRecord[] {
  return readRecords(logPath);
}

/** Resolve a stable repo label for a run: the git remote origin url if the cwd is in a repo with
 * one, else the cwd. Best-effort; any failure falls back to the cwd. */
function repoLabel(cwd: string): string {
  try {
    const res = spawnSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf-8',
      timeout: 2000,
    });
    const url = res.status === 0 ? res.stdout.trim() : '';
    return url || cwd;
  } catch {
    return cwd;
  }
}

/** Record one dispatched run at the single exec chokepoint into the unified event stream.
 * Non-fatal: any failure is caught and warned, since a log hiccup must not crash a run that
 * already finished. */
export function recordDispatchedRun(run: {
  agent:    string;
  version:  string;
  mode:     string;
  cwd:      string;
  exitCode: number;
}): void {
  try {
    const outcome = run.exitCode === 0 ? 'ok' : 'fail';
    emit('run.dispatched', {
      module: 'run',
      agent: run.agent,
      version: run.version,
      mode: run.mode,
      repo: repoLabel(run.cwd),
      cwd: run.cwd,
      outcome,
      exitCode: run.exitCode,
      status: outcome,
    });
  } catch (err) {
    process.stderr.write(`[agents] run.dispatched emit failed: ${(err as Error).message}\n`);
  }
}
