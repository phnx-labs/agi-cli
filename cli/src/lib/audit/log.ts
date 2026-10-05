
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../staleness/fingerprint.js';
import { getHistoryDir } from '../state.js';
import { ensureLockTarget, withFileLock } from '../fs-atomic.js';
import { emit } from '../feed/events.js';

export const GENESIS_HASH = 'GENESIS';

export type AuditOutcome = 'ok' | 'fail';

export interface AuditRecord {
  ts:       string;
  agent:    string;
  version:  string;
  repo:     string;
  mode:     string;
  outcome:  AuditOutcome;
  exit:     number;
  prevHash: string;
  hash:     string;
}

export type AuditEntry = Omit<AuditRecord, 'prevHash' | 'hash'>;

export function getAuditLogPath(): string {

  return path.join(getHistoryDir(), 'audit', 'log.jsonl');
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
}

function hashRecord(record: Omit<AuditRecord, 'hash'>): string {
  return sha256(canonicalJSON(record));
}

function readRecords(logPath: string): AuditRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, 'utf-8');
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as AuditRecord);
  }
  return records;
}

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

export function verifyAuditChain(logPath: string = getAuditLogPath()): { ok: boolean; brokenAt?: number } {
  let records: AuditRecord[];
  try {
    records = readRecords(logPath);
  } catch (err) {
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

export function readAuditLog(logPath: string = getAuditLogPath()): AuditRecord[] {
  return readRecords(logPath);
}

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
