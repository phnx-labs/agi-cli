import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from '../sqlite.js';
import type { BrowserTaskSummary } from './sessions-list.js';

export class NativeHistoryWriter {
  private readonly db: Database;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE IF NOT EXISTS tasks (
        profile TEXT NOT NULL, task TEXT NOT NULL, last_activity INTEGER NOT NULL,
        record TEXT NOT NULL, native INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(profile, task));
      CREATE INDEX IF NOT EXISTS tasks_activity ON tasks(last_activity DESC);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);`);
    this.db.exec('PRAGMA user_version=1');
  }

  put(record: Omit<BrowserTaskSummary, 'counts'> & { counts?: BrowserTaskSummary['counts'] }): void {
    this.db.prepare(`INSERT INTO tasks(profile,task,last_activity,record,native) VALUES(?,?,?,?,1)
      ON CONFLICT(profile,task) DO UPDATE SET
        last_activity=MAX(tasks.last_activity,excluded.last_activity), native=excluded.native,
        record=json_set(
          CASE WHEN excluded.last_activity >= tasks.last_activity
            THEN json_patch(tasks.record,excluded.record)
            ELSE json_patch(excluded.record,tasks.record) END,
          '$.lastActivity', MAX(tasks.last_activity,excluded.last_activity),
          '$.startedAt', MIN(json_extract(tasks.record,'$.startedAt'),json_extract(excluded.record,'$.startedAt')))`).run(
      record.profile, record.task, record.lastActivity, JSON.stringify(record),
    );
  }

  rawRecord(profile: string, task: string, record: string, lastActivity: number): void {
    this.db.prepare('INSERT OR REPLACE INTO tasks(profile,task,last_activity,record,native) VALUES(?,?,?,?,1)')
      .run(profile, task, lastActivity, record);
  }

  close(): void {
    this.db.close();
  }
}
