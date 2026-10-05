/** Migration ledger (RUSH-1977): append-only JSONL under the synced `~/.agents/.history` recording
 * every `agents sessions migrate`. An event log, not a mutable field, so an A->B->C hop sequence
 * keeps its lineage. */
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { homeDir } from '../platform/paths.js';

export type MigrationMode = 'resume' | 'rehydrate';

export interface MigrationEndpoint {
  host: string;
  cwd?: string;
  /** tmux pane on the source; ephemeral box slug on the target. */
  pane?: string;
  box?: string;
}

export interface MigrationRecord {
  sessionId: string;
  shortId: string;
  agent: string;
  mode: MigrationMode;
  /** true = move (the source was stopped); false = copy (--keep). */
  move: boolean;
  from: MigrationEndpoint;
  to: MigrationEndpoint;
  /** WIP branch the working tree was committed to before the move, if any. */
  branch?: string;
  /** Draft PR opened for that branch, if any. */
  wipPr?: string;
  /** ISO timestamp — passed in by the caller (the CLI has a real clock). */
  at: string;
  status: 'completed' | 'failed';
  error?: string;
}

function migrationsLedgerPath(): string {
  return path.join(homeDir(), '.agents', '.history', 'migrations.jsonl');
}

/** Append one migration event. A write failure warns instead of throwing so it never breaks a
 * successful migration. `file` is injectable for tests. */
export function recordMigration(rec: MigrationRecord, file: string = migrationsLedgerPath()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch (err) {
    console.error(chalk.yellow(`  Could not write the migration ledger (${(err as Error).message}).`));
  }
}

/** Read the whole ledger, oldest first. Blank/corrupt JSONL lines are skipped. */
export function readMigrations(file: string = migrationsLedgerPath()): MigrationRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no ledger yet
  }
  const out: MigrationRecord[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as MigrationRecord);
    } catch {
      // A single partial line (interrupted append) must not sink the whole read.
    }
  }
  return out;
}

/** The most recent completed migration for a session id, or undefined. */
export function latestForSession(sessionId: string, file: string = migrationsLedgerPath()): MigrationRecord | undefined {
  const recs = readMigrations(file).filter((r) => r.sessionId === sessionId && r.status === 'completed');
  return recs.length ? recs[recs.length - 1] : undefined;
}
