/** Shared perf sample shape (spool NDJSON + SQLite rows). */

export type PerfKind = 'hook.fire' | 'perf.timing' | 'command.end' | string;

export interface PerfSample {
  tsMs?: number;
  kind: PerfKind;
  label: string;
  durationMs: number;
  /** Full session id — same string as sessions.id when known. */
  sessionId?: string;
  /** First 8 chars of sessionId (sessions.short_id shape). */
  sessionShort?: string;
  agent?: string;
  agentVersion?: string;
  /** Fleet registry name (sessions.machine), preferred over raw hostname. */
  machine?: string;
  hostname?: string;
  actor?: string;
  cwd?: string;
  cache?: string;
  exitCode?: number;
  status?: string;
  metaJson?: string;
}

/** Percentiles for one sub-phase (e.g. agent.run's `startup`) across a bucket. */
export interface PerfPhaseStat {
  /** Samples that carried this phase (may be < the row's `n`). */
  n: number;
  p50Ms: number;
  p90Ms: number;
}

export interface PerfAggregateRow {
  kind: string;
  label: string;
  n: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  maxMs: number;
  minMs: number;
  /** Per-sub-phase percentiles from each sample's meta_json `phases`, present only when a sample
   * recorded one (agent.run records `startup`, spawnAgent entry to child spawn, so boot cost is
   * trackable separately, PHNX-3468). */
  phases?: Record<string, PerfPhaseStat>;
  cacheHitPct?: number;
  cacheStalePct?: number;
  cacheMissPct?: number;
  errorCount?: number;
  /** Fraction (0-1) of samples with a real crash exit (exit 1 / other nonzero except the
   * intentional PreToolUse deny code 2). Exit 2 is blockRate. */
  errorRate?: number;
  /** Count of intentional deny/block exits (PreToolUse exit 2). Not an error: deny-by-design guards
   * (ask-user-question-guard, git-guard, plan-html-reminder) exit 2 when they block. */
  blockCount?: number;
  /** Fraction (0-1) of samples with exit code 2 (intentional deny/block). */
  blockRate?: number;
  /** Fraction (0-1) of samples with status:'timeout'. */
  timeoutRate?: number;
  /** Project key (see project-key.ts) the row is scoped to — set only when
   *  the `project` filter narrowed the query to one project. */
  project?: string;
}

export interface AggregateOptions {
  days?: number;
  kinds?: string[];
  label?: string;
  machine?: string;
  agent?: string;
  minN?: number;
  /** Scope results to samples whose cwd resolves to this project key. */
  project?: string;
}
