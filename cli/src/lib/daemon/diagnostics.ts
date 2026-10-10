import * as os from 'os';
import { monitorEventLoopDelay, performance, type IntervalHistogram } from 'perf_hooks';

export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;
export type DiagnosticLog = (level: LogLevel, message: string, fields?: LogFields) => void;

const LEVEL_RANK: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

export function parseLogLevel(raw: unknown): LogLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(upper) ? upper as LogLevel : undefined;
}

export function levelRank(level: string): number {
  if (level.toUpperCase() === 'FATAL') return LEVEL_RANK.ERROR;
  return LEVEL_RANK[parseLogLevel(level) ?? 'INFO'];
}

export function levelEnabled(level: string, threshold: LogLevel): boolean {
  return levelRank(level) >= LEVEL_RANK[threshold];
}

export interface SpanRecord {
  name: string;
  kind: 'sync' | 'async';
  startMs: number;
  durMs: number;
  fields?: LogFields;
}

export interface SpanAggregate {
  name: string;
  kind: 'sync' | 'async';
  count: number;
  totalMs: number;
  maxMs: number;
}

const SPAN_RING_SIZE = 256;
const SYNC_RING_FLOOR_MS = 5;
const SLOW_SYNC_SPAN_MS = 250;

interface SpanState {
  syncRing: SpanRecord[];
  window: Map<string, SpanAggregate>;
  log: DiagnosticLog | null;
  slowSyncMs: number;
}

const spans: SpanState = { syncRing: [], window: new Map(), log: null, slowSyncMs: SLOW_SYNC_SPAN_MS };

export function installSpanLog(log: DiagnosticLog | null, opts: { slowSyncMs?: number } = {}): void {
  spans.log = log;
  spans.slowSyncMs = opts.slowSyncMs ?? SLOW_SYNC_SPAN_MS;
  spans.syncRing = [];
  spans.window = new Map();
}

function safeLog(level: LogLevel, message: string, fields?: LogFields): void {
  try { spans.log?.(level, message, fields); } catch { }
}

function record(rec: SpanRecord): void {
  if (!spans.log) return;
  if (rec.kind === 'sync' && rec.durMs >= SYNC_RING_FLOOR_MS) {
    spans.syncRing.push(rec);
    if (spans.syncRing.length > SPAN_RING_SIZE) spans.syncRing.splice(0, spans.syncRing.length - SPAN_RING_SIZE);
  }
  const key = `${rec.kind}:${rec.name}`;
  const agg = spans.window.get(key) ?? { name: rec.name, kind: rec.kind, count: 0, totalMs: 0, maxMs: 0 };
  agg.count += 1;
  agg.totalMs += rec.durMs;
  agg.maxMs = Math.max(agg.maxMs, rec.durMs);
  spans.window.set(key, agg);
  const fields = { span: rec.name, kind: rec.kind, durMs: Math.round(rec.durMs), ...rec.fields };
  if (rec.kind === 'sync' && rec.durMs >= spans.slowSyncMs) {
    safeLog('WARN', `slow synchronous section '${rec.name}' blocked the event loop for ${Math.round(rec.durMs)}ms`, { event: 'span.slow', ...fields });
  } else {
    safeLog('DEBUG', `span '${rec.name}' ${Math.round(rec.durMs)}ms`, { event: 'span', ...fields });
  }
}

export function spanSync<T>(name: string, fn: () => T, fields?: () => LogFields | undefined): T {
  if (!spans.log) return fn();
  const startMs = performance.now();
  try {
    return fn();
  } finally {
    record({ name, kind: 'sync', startMs, durMs: performance.now() - startMs, fields: fields?.() });
  }
}

export async function span<T>(name: string, fn: () => Promise<T>, fields?: () => LogFields | undefined): Promise<T> {
  if (!spans.log) return fn();
  const startMs = performance.now();
  try {
    return await fn();
  } finally {
    record({ name, kind: 'async', startMs, durMs: performance.now() - startMs, fields: fields?.() });
  }
}

export function syncSpansBetween(fromMs: number, toMs: number): SpanRecord[] {
  return spans.syncRing.filter((r) => r.startMs + r.durMs >= fromMs && r.startMs <= toMs);
}

export function topSpansSinceReport(limit: number): SpanAggregate[] {
  return [...spans.window.values()]
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit)
    .map((a) => ({ ...a, totalMs: Math.round(a.totalMs), maxMs: Math.round(a.maxMs) }));
}

function drainSpanWindow(limit: number): SpanAggregate[] {
  const out = topSpansSinceReport(limit);
  spans.window = new Map();
  return out;
}

function summarizeSpan(r: SpanRecord): LogFields {
  return { span: r.name, durMs: Math.round(r.durMs), ...r.fields };
}

export interface VitalsSnapshot {
  uptimeS: number;
  loop: { p50Ms: number; p99Ms: number; maxMs: number };
  cpuPct: number;
  rssMb: number;
  heapUsedMb: number;
  load1: number;
  cores: number;
}

interface VitalsOptions {
  log: DiagnosticLog;
  reportMs?: number;
  probeMs?: number;
  stallMs?: number;
  extra?: () => LogFields;
}

const toMs = (ns: number): number => Math.round(ns / 1e6);

export class DaemonVitals {
  private readonly log: DiagnosticLog;
  private readonly reportMs: number;
  private readonly probeMs: number;
  private readonly stallMs: number;
  private readonly extra?: () => LogFields;
  private histogram: IntervalHistogram | null = null;
  private probeTimer?: ReturnType<typeof setInterval>;
  private reportTimer?: ReturnType<typeof setInterval>;
  private lastProbe = 0;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();
  private readonly startedAt = performance.now();

  constructor(opts: VitalsOptions) {
    this.log = opts.log;
    this.reportMs = opts.reportMs ?? 60_000;
    this.probeMs = opts.probeMs ?? 250;
    this.stallMs = opts.stallMs ?? 1_000;
    this.extra = opts.extra;
  }

  start(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 });
    this.histogram.enable();
    this.lastProbe = performance.now();
    this.probeTimer = setInterval(() => this.probe(), this.probeMs);
    this.reportTimer = setInterval(() => this.report(), this.reportMs);
    this.probeTimer.unref?.();
    this.reportTimer.unref?.();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.histogram?.disable();
    this.histogram = null;
  }

  snapshot(): VitalsSnapshot {
    const now = performance.now();
    const cpu = process.cpuUsage(this.lastCpu);
    const wallUs = Math.max(1, (now - this.lastCpuAt) * 1000);
    const mem = process.memoryUsage();
    const h = this.histogram;
    return {
      uptimeS: Math.round((now - this.startedAt) / 1000),
      loop: h ? { p50Ms: toMs(h.percentile(50)), p99Ms: toMs(h.percentile(99)), maxMs: toMs(h.max) } : { p50Ms: 0, p99Ms: 0, maxMs: 0 },
      cpuPct: Math.round(((cpu.user + cpu.system) / wallUs) * 100),
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      load1: Math.round(os.loadavg()[0] * 10) / 10,
      cores: os.availableParallelism?.() ?? os.cpus().length,
    };
  }

  private safe(level: LogLevel, message: string, fields?: LogFields): void {
    try { this.log(level, message, fields); } catch { }
  }

  private probe(): void {
    const now = performance.now();
    const stalledMs = now - this.lastProbe - this.probeMs;
    const from = this.lastProbe;
    this.lastProbe = now;
    if (stalledMs < this.stallMs) return;
    const blockers = syncSpansBetween(from, now).sort((a, b) => b.durMs - a.durMs).slice(0, 5);
    const named = blockers.length ? blockers.map((b) => `${b.name} ${Math.round(b.durMs)}ms`).join(', ') : 'no instrumented section (uninstrumented code or the process was descheduled)';
    this.safe('WARN', `event loop stalled ${Math.round(stalledMs)}ms; ran: ${named}`, {
      event: 'loop.stall',
      stalledMs: Math.round(stalledMs),
      blockers: blockers.map(summarizeSpan),
      load1: Math.round(os.loadavg()[0] * 10) / 10,
    });
  }

  report(): void {
    const snap = this.snapshot();
    const top = drainSpanWindow(8);
    this.histogram?.reset();
    this.lastCpu = process.cpuUsage();
    this.lastCpuAt = performance.now();
    this.safe('INFO', `vitals: loop p99 ${snap.loop.p99Ms}ms max ${snap.loop.maxMs}ms, cpu ${snap.cpuPct}%, rss ${snap.rssMb}MB, load ${snap.load1}/${snap.cores}`, {
      event: 'vitals',
      ...snap,
      topSpans: top,
      ...this.extra?.(),
    });
  }
}
