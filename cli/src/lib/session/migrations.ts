/**
 * Migration ledger (RUSH-1977) — an append-only record of every
 * `agents sessions migrate`, so a session handed off to another machine stays
 * trackable: where it went, when, in which mode, move vs copy, and the WIP
 * branch/PR its working tree was parked on.
 *
 * Append-only JSONL under the already-synced `~/.agents/.history`, so the source
 * and target machines converge on the same trail. One line per event; a session
 * that hops A→B→C leaves three lines — that ordered history IS the lineage, which
 * is why this is an event log, not a mutable field on the session.
 */
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

/**
 * Append one migration event. A ledger write must never break a migration that
 * otherwise succeeded, so a write failure is a visible warning, not a throw.
 * `file` is injectable for tests; production uses the default ledger path.
 */
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
