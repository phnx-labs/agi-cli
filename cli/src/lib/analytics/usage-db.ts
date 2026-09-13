import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import { getUsageDbPath, getSecretsDbPath } from '../state.js';
import { localMachineId } from '../session/origin-machine.js';

export type UsageKind = 'secret' | 'agent' | 'skill' | 'plugin' | 'browser' | 'computer';

export const USAGE_KINDS: readonly UsageKind[] = [
  'secret',
  'agent',
  'skill',
  'plugin',
  'browser',
  'computer',
] as const;

const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface RecordUsageParams {
  kind: UsageKind;
  name: string;
  event: string;
  agent?: string;
  sessionId?: string;
  machine?: string;
  actor?: string;
  source?: string;
  status?: 'success' | 'error' | string;
  meta?: Record<string, unknown>;
  ts?: string;
}

interface UsageEventRow {
  ts: string;
  kind: UsageKind;
  name: string;
  event: string;
  agent: string | null;
  sessionId: string | null;
  machine: string | null;
  actor: string | null;
  source: string | null;
  status: string | null;
  metaJson: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  agent TEXT,
  session_id TEXT,
  machine TEXT,
  actor TEXT,
  source TEXT,
  status TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_ts ON usage_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_kind_ts ON usage_events(kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_kind_name ON usage_events(kind, name);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_kind_event ON usage_events(kind, event);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_machine_ts ON usage_events(machine, ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_usage_session ON usage_events(session_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let cached: { path: string; db: Database.Database } | null = null;

function isDisabled(): boolean {
  const v = process.env.AGENTS_NO_USAGE_TRACK;
  return v === '1' || v === 'true';
}

function open(): Database.Database | null {
  if (isDisabled()) return null;
  const dbPath = getUsageDbPath();
  if (cached && cached.path === dbPath) return cached.db;
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    db.exec(SCHEMA);
    try {
      db.prepare(`DELETE FROM usage_events WHERE ts < ?`).run(
        new Date(Date.now() - EVENT_RETENTION_MS).toISOString(),
      );
    } catch { /* prune best-effort */ }
    migrateSecretsUsageOnce(db);
    cached = { path: dbPath, db };
    return db;
  } catch {
    return null;
  }
}

function migrateSecretsUsageOnce(db: Database.Database): void {
  try {
    const done = db.prepare(`SELECT value FROM meta WHERE key = 'migrate_secrets_v1'`).get() as { value: string } | undefined;
    if (done?.value === '1') return;
    const secretsPath = getSecretsDbPath();
    if (fs.existsSync(secretsPath)) {
      const legacy = new Database(secretsPath);
      try {
        const rows = legacy.prepare(
          `SELECT ts, bundle, event, agent, host, source, status, key_count FROM usage_events`,
        ).all() as Array<{
          ts: string;
          bundle: string;
          event: string;
          agent: string | null;
          host: string | null;
          source: string | null;
          status: string | null;
          key_count: number | null;
        }>;
        const insert = db.prepare(
          `INSERT INTO usage_events (ts, kind, name, event, agent, session_id, machine, actor, source, status, meta_json)
           VALUES (?, 'secret', ?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
        );
        const machine = localMachineId();
        const txn = db.transaction((items: typeof rows) => {
          for (const r of items) {
            if (!r.bundle) continue;
            const meta = r.key_count != null ? JSON.stringify({ keyCount: r.key_count, host: r.host }) : (r.host ? JSON.stringify({ host: r.host }) : null);
            insert.run(r.ts, r.bundle, r.event, r.agent, machine, r.source, r.status, meta);
          }
        });
        txn(rows);
      } finally {
        try { legacy.close(); } catch { /* ignore */ }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('migrate_secrets_v1', '1')`).run();
  } catch {
    /* migrate is best-effort */
  }
}

export function recordUsage(p: RecordUsageParams): void {
  if (isDisabled()) return;
  if (!p.kind || !p.name || !p.event) return;
  const db = open();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO usage_events (ts, kind, name, event, agent, session_id, machine, actor, source, status, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      p.ts ?? new Date().toISOString(),
      p.kind,
      p.name,
      p.event,
      p.agent ?? null,
      p.sessionId ?? null,
      p.machine ?? localMachineId(),
      p.actor ?? null,
      p.source ?? null,
      p.status ?? 'success',
      p.meta != null ? JSON.stringify(p.meta) : null,
    );
  } catch {
    /* telemetry must never break callers */
  }
}

export function usageDbPath(): string {
  return getUsageDbPath();
}

export function listUsageKindsWithData(sinceIso: string): UsageKind[] {
  const db = open();
  if (!db) return [];
  try {
    const rows = db.prepare(
      `SELECT DISTINCT kind FROM usage_events WHERE ts >= ?`,
    ).all(sinceIso) as Array<{ kind: string }>;
    return rows.map((r) => r.kind).filter((k): k is UsageKind => (USAGE_KINDS as readonly string[]).includes(k));
  } catch {
    return [];
  }
}

export function countUsage(opts: { kind?: UsageKind; sinceIso: string; name?: string; event?: string }): number {
  const db = open();
  if (!db) return 0;
  try {
    const clauses = ['ts >= ?'];
    const args: unknown[] = [opts.sinceIso];
    if (opts.kind) { clauses.push('kind = ?'); args.push(opts.kind); }
    if (opts.name) { clauses.push('name = ?'); args.push(opts.name); }
    if (opts.event) { clauses.push('event = ?'); args.push(opts.event); }
    const row = db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ${clauses.join(' AND ')}`).get(...args) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

export function queryUsage(opts: {
  kind?: UsageKind;
  name?: string;
  event?: string;
  sinceIso: string;
  limit?: number;
}): UsageEventRow[] {
  const db = open();
  if (!db) return [];
  try {
    const clauses = ['ts >= ?'];
    const args: unknown[] = [opts.sinceIso];
    if (opts.kind) { clauses.push('kind = ?'); args.push(opts.kind); }
    if (opts.name) { clauses.push('name = ?'); args.push(opts.name); }
    if (opts.event) { clauses.push('event = ?'); args.push(opts.event); }
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
    args.push(limit);
    const rows = db.prepare(
      `SELECT ts, kind, name, event, agent, session_id AS sessionId, machine, actor, source, status, meta_json AS metaJson
         FROM usage_events WHERE ${clauses.join(' AND ')}
         ORDER BY ts DESC, id DESC LIMIT ?`,
    ).all(...args) as UsageEventRow[];
    return rows;
  } catch {
    return [];
  }
}

interface NameCountRow {
  name: string;
  n: number;
  last: string | null;
}

export function topNamesByKind(kind: UsageKind, sinceIso: string, limit = 20): NameCountRow[] {
  const db = open();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT name, COUNT(*) AS n, MAX(ts) AS last
         FROM usage_events WHERE kind = ? AND ts >= ?
         GROUP BY name ORDER BY n DESC LIMIT ?`,
    ).all(kind, sinceIso, limit) as NameCountRow[];
  } catch {
    return [];
  }
}

interface KindCountRow {
  kind: string;
  n: number;
}

export function kindMix(sinceIso: string): KindCountRow[] {
  const db = open();
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT kind, COUNT(*) AS n FROM usage_events WHERE ts >= ? GROUP BY kind ORDER BY n DESC`,
    ).all(sinceIso) as KindCountRow[];
  } catch {
    return [];
  }
}

export function closeUsageDb(): void {
  if (cached) {
    try { cached.db.close(); } catch { /* ignore */ }
    cached = null;
  }
}
