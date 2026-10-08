import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile, withFileLockAsync } from '../fs-atomic.js';
import type { RecordingCandidate, RecordingLedgerRow } from './model.js';
import { recordingsLedgerPath } from './config.js';

interface LedgerFile {
  version: 1;
  rows: RecordingLedgerRow[];
  attention?: { reason: string; postedAt: string };
}

const EMPTY_LEDGER: LedgerFile = { version: 1, rows: [] };

export class RecordingLedger {
  constructor(readonly filePath = recordingsLedgerPath()) {}

  private async ensure(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(this.filePath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(EMPTY_LEDGER, null, 2)}\n`);
      await handle.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  private async readUnlocked(): Promise<LedgerFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<LedgerFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.rows)) throw new Error('unsupported ledger schema');
      return { version: 1, rows: parsed.rows, attention: parsed.attention };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_LEDGER, rows: [] };
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Recording ledger is unreadable at ${this.filePath}: ${detail}`);
    }
  }

  private async transaction<T>(fn: (ledger: LedgerFile) => T | Promise<T>): Promise<T> {
    await this.ensure();
    return withFileLockAsync(this.filePath, async () => {
      const ledger = await this.readUnlocked();
      const result = await fn(ledger);
      await atomicWriteFile(this.filePath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return result;
    });
  }

  async list(): Promise<RecordingLedgerRow[]> {
    await this.ensure();
    return (await this.readUnlocked()).rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  async queue(candidate: RecordingCandidate): Promise<RecordingLedgerRow> {
    return this.transaction((ledger) => {
      const existing = ledger.rows.find((row) => row.stem === candidate.stem);
      const sameFile = existing
        && existing.path === candidate.path
        && existing.size === candidate.size
        && existing.mtimeMs === candidate.mtimeMs;
      if (sameFile) return existing;
      const row: RecordingLedgerRow = {
        ...candidate,
        url: null,
        status: 'queued',
        error: null,
        updatedAt: new Date().toISOString(),
      };
      if (existing) Object.assign(existing, row, { retryAt: undefined });
      else ledger.rows.push(row);
      return existing ?? row;
    });
  }

  async update(
    stem: string,
    sourcePath: string,
    patch: Partial<RecordingLedgerRow>,
  ): Promise<RecordingLedgerRow | null> {
    return this.transaction((ledger) => {
      const row = ledger.rows.find((entry) => entry.stem === stem && entry.path === sourcePath);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      return row;
    });
  }

  async recoverInterrupted(now = Date.now()): Promise<void> {
    await this.transaction((ledger) => {
      for (const row of ledger.rows) {
        if (row.status !== 'transcoding' && row.status !== 'uploading') continue;
        row.status = 'queued';
        row.error = 'Interrupted before completion; retrying.';
        row.updatedAt = new Date(now).toISOString();
      }
    });
  }

  async pending(now = Date.now()): Promise<RecordingLedgerRow[]> {
    return this.transaction((ledger) => {
      return ledger.rows.filter((row) =>
        row.status === 'queued'
        || (row.status === 'failed' && (!row.retryAt || Date.parse(row.retryAt) <= now)),
      );
    });
  }

  async shouldPostAttention(reason: string): Promise<boolean> {
    return this.transaction((ledger) => {
      if (ledger.attention?.reason === reason) return false;
      ledger.attention = { reason, postedAt: new Date().toISOString() };
      return true;
    });
  }

  async clearAttention(): Promise<void> {
    await this.transaction((ledger) => { delete ledger.attention; });
  }
}
