import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { homeDir } from '../platform/paths.js';

export type MigrationMode = 'resume' | 'rehydrate';

export interface MigrationEndpoint {
  host: string;
  cwd?: string;
  pane?: string;
  box?: string;
}

export interface MigrationRecord {
  sessionId: string;
  shortId: string;
  agent: string;
  mode: MigrationMode;
  move: boolean;
  from: MigrationEndpoint;
  to: MigrationEndpoint;
  branch?: string;
  wipPr?: string;
  at: string;
  status: 'completed' | 'failed';
  error?: string;
}

function migrationsLedgerPath(): string {
  return path.join(homeDir(), '.agents', '.history', 'migrations.jsonl');
}

export function recordMigration(rec: MigrationRecord, file: string = migrationsLedgerPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (err) {
    console.error(chalk.yellow(`  Could not write the migration ledger (${(err as Error).message}).`));
  }
}

export function readMigrations(file: string = migrationsLedgerPath()): MigrationRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: MigrationRecord[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as MigrationRecord);
    } catch {
    }
  }
  return out;
}

export function latestForSession(sessionId: string, file: string = migrationsLedgerPath()): MigrationRecord | undefined {
  const recs = readMigrations(file).filter((r) => r.sessionId === sessionId && r.status === 'completed');
  return recs.length ? recs[recs.length - 1] : undefined;
}
