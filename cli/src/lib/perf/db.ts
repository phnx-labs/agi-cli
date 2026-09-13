/**
 * Disposable performance warehouse — SQLite under ~/.agents/.cache/perf/.
 *
 * Opened only by `agents insights perf` / `hooks profile` (read path). Writers use
 * {@link recordSample} in `./spool.ts` (NDJSON, no SQLite).
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from '../sqlite.js';
import { getPerfDbPath } from '../state.js';
import { localMachineId } from '../origin-machine.js';
import { resolveProjectKey } from '../project-key.js';
import { percentile } from '../percentile.js';
import { resolveSpoolPath, shortSessionId, _resetPerfSpoolForTest } from './spool.js';
import type { AggregateOptions, PerfAggregateRow, PerfPhaseStat } from './types.js';

export type { AggregateOptions, PerfAggregateRow, PerfPhaseStat, PerfSample } from './types.js';

/**
 * Parse the `phases` map from a sample's meta_json. Fail-soft: a row with no
 * meta_json, malformed JSON, or a non-numeric phase value contributes nothing
 * rather than throwing (the warehouse must survive any writer's shape).
 */
function parsePhases(metaJson: string | null): Record<string, number> | undefined {
  if (!metaJson) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(metaJson); } catch { return undefined; }
  const phases = (parsed as { phases?: unknown } | null)?.phases;
  if (!phases || typeof phases !== 'object') return undefined;
  const out: Record<string, number> = {};
  for (const [name, val] of Object.entries(phases as Record<string, unknown>)) {
    if (typeof val === 'number' && Number.isFinite(val)) out[name] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
export { recordSample, shortSessionId, resolveSpoolPath } from './spool.js';
export { percentile } from '../percentile.js';

const PERF_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 30;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  session_id TEXT,
  session_short TEXT,
  agent TEXT,
  agent_version TEXT,
  machine TEXT,
  hostname TEXT,
  actor TEXT,
  cwd TEXT,
  cache TEXT,
  exit_code INTEGER,
  status TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_perf_ts ON samples(ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_kind_ts ON samples(kind, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_label_ts ON samples(label, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_machine_ts ON samples(machine, ts_ms);
CREATE INDEX IF NOT EXISTS idx_perf_session ON samples(session_id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let _db: Database.Database | null = null;
let _dbPath: string | null = null;
let _disabled = false;

/** Test seam — redirect the warehouse path (like AGENTS_EVENTS_PATH). */
export function _resetPerfDbForTest(overridePath?: string | null): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
  _dbPath = overridePath === undefined ? null : overridePath;
  _disabled = false;
  if (overridePath) {
    _resetPerfSpoolForTest(path.join(path.dirname(overridePath), 'spool.jsonl'));
  } else if (overridePath === null) {
    _resetPerfSpoolForTest(null);
  }
}

function resolveDbPath(): string {
  return process.env.AGENTS_PERF_DB || _dbPath || getPerfDbPath();
}

function isDisabled(): boolean {
  if (_disabled) return true;
  const v = process.env.AGENTS_DISABLE_PERF;
  return v === '1' || v === 'true';
}

function openDb(): Database.Database | null {
  if (isDisabled()) return null;
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    db.exec(SCHEMA);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    if (!row) {
      db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)`).run(String(PERF_SCHEMA_VERSION));
    }
    _db = db;
    _dbPath = dbPath;
    drainSpool(db);
    maybeRetain(db);
    return db;
  } catch {
    _disabled = true;
    return null;
  }
}

/** Drain the NDJSON spool into samples. Idempotent; truncates on success. */
export function drainSpool(db?: Database.Database): number {
  const spool = resolveSpoolPath();
  if (!fs.existsSync(spool)) return 0;
  let raw: string;
  try {
    raw = fs.readFileSync(spool, 'utf-8');
  } catch {
    return 0;
  }
  if (!raw.trim()) {
    try { fs.writeFileSync(spool, ''); } catch { /* ignore */ }
    return 0;
  }
  const target = db ?? openDb();
  if (!target) return 0;

  let n = 0;
  const insert = target.prepare(`
    INSERT INTO samples (
      ts_ms, kind, label, duration_ms,
      session_id, session_short, agent, agent_version,
      machine, hostname, actor, cwd,
      cache, exit_code, status, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = target.transaction((lines: string[]) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      let o: Record<string, unknown>;
      try { o = JSON.parse(line); } catch { continue; }
      const label = String(o.label ?? o.hook ?? '');
      const durationMs = Number(o.duration_ms ?? o.durationMs ?? o.ms);
      if (!label || !Number.isFinite(durationMs)) continue;
      const sessionId = o.session_id != null ? String(o.session_id)
        : o.sessionId != null ? String(o.sessionId) : null;
      const tsMs = Number(o.ts_ms ?? o.tsMs) || (typeof o.ts === 'string' ? Date.parse(o.ts) : Date.now());
      insert.run(
        Number.isFinite(tsMs) ? tsMs : Date.now(),
        String(o.kind ?? 'hook.fire'),
        label,
        durationMs,
        sessionId,
        o.session_short != null ? String(o.session_short) : shortSessionId(sessionId) ?? null,
        o.agent != null ? String(o.agent) : null,
        o.agent_version != null ? String(o.agent_version) : o.agentVersion != null ? String(o.agentVersion) : null,
        o.machine != null ? String(o.machine) : localMachineId(),
        o.hostname != null ? String(o.hostname) : null,
        o.actor != null ? String(o.actor) : null,
        o.cwd != null ? String(o.cwd) : null,
        o.cache != null ? String(o.cache) : null,
        o.exit_code != null ? Number(o.exit_code) : o.exit != null ? Number(o.exit) : null,
        o.status != null ? String(o.status) : null,
        o.meta_json != null ? String(o.meta_json) : null,
      );
      n++;
    }
  });
  try {
    txn(raw.split('\n'));
    fs.writeFileSync(spool, '');
  } catch {
    return 0;
  }
  return n;
}

function maybeRetain(db: Database.Database): void {
  try {
    const last = db.prepare(`SELECT value FROM meta WHERE key = 'last_retain_ms'`).get() as { value: string } | undefined;
    const lastMs = last ? parseInt(last.value, 10) : 0;
    const now = Date.now();
    if (now - lastMs < 3_600_000) return;
    const cutoff = now - DEFAULT_RETENTION_DAYS * 86_400_000;
    db.prepare(`DELETE FROM samples WHERE ts_ms < ?`).run(cutoff);
    db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('last_retain_ms', ?)`).run(String(now));
  } catch {
    // ignore
  }
}

/**
 * Aggregate samples by (kind, label) with p50/p95/p99. Drains the spool first.
 *
 * `opts.project` scopes the query to samples whose recorded `cwd` resolves to
 * that project key (see project-key.ts) — resolution runs per unique cwd
 * (memoized) rather than per row, since `resolveProjectKey` does a filesystem
 * walk and a warehouse query can carry many rows sharing the same cwd.
 */
export function aggregateSamples(opts: AggregateOptions = {}): PerfAggregateRow[] {
  const db = openDb();
  if (!db) return [];
  drainSpool(db);

  const days = opts.days ?? 7;
  const sinceMs = Date.now() - days * 86_400_000;
  const minN = opts.minN ?? 1;

  const clauses = ['ts_ms >= ?'];
  const params: unknown[] = [sinceMs];
  if (opts.kinds && opts.kinds.length > 0) {
    clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    params.push(...opts.kinds);
  }
  if (opts.label) {
    clauses.push('label = ?');
    params.push(opts.label);
  }
  if (opts.machine) {
    clauses.push('machine = ?');
    params.push(opts.machine);
  }
  if (opts.agent) {
    clauses.push('agent = ?');
    params.push(opts.agent);
  }

  const rows = db.prepare(
    `SELECT kind, label, duration_ms, cache, exit_code, status, cwd, meta_json
     FROM samples WHERE ${clauses.join(' AND ')}`
  ).all(...params) as Array<{
    kind: string;
    label: string;
    duration_ms: number;
    cache: string | null;
    exit_code: number | null;
    status: string | null;
    cwd: string | null;
    meta_json: string | null;
  }>;

  // Memoize cwd -> project key: resolveProjectKey walks the filesystem for
  // a repo root, and many rows in one warehouse query share the same cwd.
  const projectCache = new Map<string, string | undefined>();
  const projectForCwd = (cwd: string | null): string | undefined => {
    if (!cwd) return undefined;
    let key = projectCache.get(cwd);
    if (key === undefined && !projectCache.has(cwd)) {
      key = resolveProjectKey(cwd);
      projectCache.set(cwd, key);
    }
    return key;
  };

  type Bucket = {
    kind: string;
    label: string;
    durations: number[];
    hits: number;
    stale: number;
    misses: number;
    errors: number;
    blocks: number;
    timeouts: number;
    /** phase name -> durations across samples that carried it. */
    phases: Map<string, number[]>;
  };
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    if (opts.project && projectForCwd(r.cwd) !== opts.project) continue;
    const key = `${r.kind}\0${r.label}`;
    let b = map.get(key);
    if (!b) {
      b = { kind: r.kind, label: r.label, durations: [], hits: 0, stale: 0, misses: 0, errors: 0, blocks: 0, timeouts: 0, phases: new Map() };
      map.set(key, b);
    }
    b.durations.push(Number(r.duration_ms));
    const phases = parsePhases(r.meta_json);
    if (phases) {
      for (const [name, ms] of Object.entries(phases)) {
        let arr = b.phases.get(name);
        if (!arr) { arr = []; b.phases.set(name, arr); }
        arr.push(ms);
      }
    }
    if (r.cache === 'hit') b.hits++;
    else if (r.cache === 'stale-prefetch') b.stale++;
    else if (r.cache === 'miss' || r.cache === 'none') b.misses++;
    // Exit classes (Claude/Codex PreToolUse convention):
    //   0 → allowed
    //   2 → intentional deny/block (not a crash)
    //   1 / other nonzero → real error
    // Timeouts are recorded via status, not exit_code, so they don't double-count.
    if (r.status === 'timeout') b.timeouts++;
    else if (typeof r.exit_code === 'number') {
      if (r.exit_code === 2) b.blocks++;
      else if (r.exit_code !== 0) b.errors++;
    }
  }

  const out: PerfAggregateRow[] = [];
  for (const b of map.values()) {
    if (b.durations.length < minN) continue;
    const sorted = b.durations.slice().sort((a, c) => a - c);
    const n = sorted.length;
    const sum = sorted.reduce((a, c) => a + c, 0);
    const row: PerfAggregateRow = {
      kind: b.kind,
      label: b.label,
      n,
      p50Ms: Math.round(percentile(sorted, 50)),
      p95Ms: Math.round(percentile(sorted, 95)),
      p99Ms: Math.round(percentile(sorted, 99)),
      meanMs: Math.round(sum / n),
      maxMs: sorted[n - 1],
      minMs: sorted[0],
    };
    if (b.hits + b.stale + b.misses > 0) {
      row.cacheHitPct = Math.round((b.hits / n) * 100);
      row.cacheStalePct = Math.round((b.stale / n) * 100);
      row.cacheMissPct = Math.round((b.misses / n) * 100);
    }
    if (b.errors > 0) {
      row.errorCount = b.errors;
      row.errorRate = Math.round((b.errors / n) * 1000) / 1000;
    }
    if (b.blocks > 0) {
      row.blockCount = b.blocks;
      row.blockRate = Math.round((b.blocks / n) * 1000) / 1000;
    }
    if (b.timeouts > 0) row.timeoutRate = Math.round((b.timeouts / n) * 1000) / 1000;
    if (b.phases.size > 0) {
      const phases: Record<string, PerfPhaseStat> = {};
      for (const [name, durs] of b.phases) {
        if (durs.length === 0) continue;
        const ps = durs.slice().sort((a, c) => a - c);
        phases[name] = {
          n: ps.length,
          p50Ms: Math.round(percentile(ps, 50)),
          p90Ms: Math.round(percentile(ps, 90)),
        };
      }
      if (Object.keys(phases).length > 0) row.phases = phases;
    }
    if (opts.project) row.project = opts.project;
    out.push(row);
  }
  out.sort((a, b) => b.p99Ms - a.p99Ms);
  return out;
}

export function perfDbPath(): string {
  return resolveDbPath();
}

export function perfSpoolPath(): string {
  return resolveSpoolPath();
}

