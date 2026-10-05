
export type PerfKind = 'hook.fire' | 'perf.timing' | 'command.end' | string;

export interface PerfSample {
  tsMs?: number;
  kind: PerfKind;
  label: string;
  durationMs: number;
  sessionId?: string;
  sessionShort?: string;
  agent?: string;
  agentVersion?: string;
  machine?: string;
  hostname?: string;
  actor?: string;
  cwd?: string;
  cache?: string;
  exitCode?: number;
  status?: string;
  metaJson?: string;
}

export interface PerfPhaseStat {
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
  phases?: Record<string, PerfPhaseStat>;
  cacheHitPct?: number;
  cacheStalePct?: number;
  cacheMissPct?: number;
  errorCount?: number;
  errorRate?: number;
  blockCount?: number;
  blockRate?: number;
  timeoutRate?: number;
  project?: string;
}

export interface AggregateOptions {
  days?: number;
  kinds?: string[];
  label?: string;
  machine?: string;
  agent?: string;
  minN?: number;
  project?: string;
}
