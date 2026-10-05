
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from '../sqlite.js';
import type { CloudTask, CloudProviderId, CloudTaskStatus } from './types.js';
import { getCloudDir } from '../state.js';
import { registerCloudSession } from './session-index.js';

const CLOUD_DIR = getCloudDir();
const DB_PATH = path.join(CLOUD_DIR, 'tasks.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  agent TEXT,
  prompt TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  pr_url TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  provider_data TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_provider ON tasks(provider);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
`;

let _db: Database.Database | null = null;

function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(SCHEMA);
  return _db;
}

export function closeStore(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function insertTask(task: CloudTask): void {
  db().prepare(`
    INSERT OR REPLACE INTO tasks (id, provider, status, agent, prompt, repo, branch, pr_url, summary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.provider,
    task.status,
    task.agent ?? null,
    task.prompt,
    task.repo ?? null,
    task.branch ?? null,
    task.prUrl ?? null,
    task.summary ?? null,
    task.createdAt,
    task.updatedAt,
  );
  registerCloudSession(task);
}

export function updateTaskStatus(id: string, status: CloudTaskStatus, extra?: Partial<Pick<CloudTask, 'summary' | 'prUrl' | 'branch'>>): void {
  const now = new Date().toISOString();
  const sets = ['status = ?', 'updated_at = ?'];
  const params: unknown[] = [status, now];

  if (extra?.summary !== undefined) {
    sets.push('summary = ?');
    params.push(extra.summary);
  }
  if (extra?.prUrl !== undefined) {
    sets.push('pr_url = ?');
    params.push(extra.prUrl);
  }
  if (extra?.branch !== undefined) {
    sets.push('branch = ?');
    params.push(extra.branch);
  }
  params.push(id);

  db().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  const updated = getTaskById(id);
  if (updated) registerCloudSession(updated);
}

export function getTaskById(id: string): CloudTask | null {
  const row = db().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(filter?: { provider?: CloudProviderId; status?: CloudTaskStatus; limit?: number }): CloudTask[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.provider) {
    clauses.push('provider = ?');
    params.push(filter.provider);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter?.limit ?? 50;

  const rows = db().prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

export function listActiveTasks(): CloudTask[] {
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const rows = db().prepare(
    `SELECT * FROM tasks WHERE status NOT IN (${placeholders}) ORDER BY created_at DESC`,
  ).all(...TERMINAL_STATUSES) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

function rowToTask(row: Record<string, unknown>): CloudTask {
  return {
    id: row.id as string,
    provider: row.provider as CloudProviderId,
    status: row.status as CloudTaskStatus,
    agent: (row.agent as string) || undefined,
    prompt: row.prompt as string,
    repo: (row.repo as string) || undefined,
    branch: (row.branch as string) || undefined,
    prUrl: (row.pr_url as string) || undefined,
    summary: (row.summary as string) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
