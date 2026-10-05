import type { BenchJob, BenchRun, BenchStep, PhaseTimes, Provider, RunKind } from './types';
import { classifyProvider } from './providers';

const AGGREGATOR_NAMES = new Set(['test', 'required', 'gate']);

export function isAggregatorJob(name: string): boolean {
  const n = name.trim().toLowerCase();
  return AGGREGATOR_NAMES.has(n);
}

export function isWindowsJob(job: BenchJob): boolean {
  if (classifyProvider(job) === 'windows') return true;
  return job.name.trim().toLowerCase() === 'windows';
}

export function isSetupStep(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('set up job')
    || n.includes('checkout')
    || n.includes('setup-bun')
    || n.includes('setup-node')
    || n.includes('use node.js')
    || n.includes('bun install')
    || n.includes('install dependencies')
    || n.startsWith('post ')
    || n.includes('complete job')
  );
}

export function isReportStep(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('gate every affected')
    || n.includes('attestation')
    || n.includes('required check')
    || (n.includes('upload') && n.includes('artifact'))
  );
}

export function stepDurationMs(step: BenchStep): number | null {
  if (!step.started_at || !step.completed_at) return null;
  const ms = Date.parse(step.completed_at) - Date.parse(step.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function jobDurationMs(job: BenchJob): number | null {
  if (!job.started_at || !job.completed_at) return null;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function sumClassified(steps: readonly BenchStep[] | undefined, pred: (name: string) => boolean): number {
  let total = 0;
  for (const step of steps ?? []) {
    if (!pred(step.name)) continue;
    const ms = stepDurationMs(step);
    if (ms !== null) total += ms;
  }
  return total;
}

export function inferRunKind(run: BenchRun): RunKind {
  if (run.kind) return run.kind;
  const name = (run.name ?? '').toLowerCase();
  if (name.includes('release') || name.includes('publish')) return 'release';
  return 'required-ci';
}

export function isUsableRun(run: BenchRun): boolean {
  const conclusion = (run.conclusion ?? '').toLowerCase();
  if (conclusion === 'cancelled' || conclusion === 'skipped') return false;
  return true;
}

export function requiredPathJobs(run: BenchRun): { included: BenchJob[]; excluded: BenchJob[] } {
  const included: BenchJob[] = [];
  const excluded: BenchJob[] = [];
  for (const job of run.jobs) {
    const skipped = (job.conclusion ?? '').toLowerCase() === 'skipped';
    if (skipped || !job.started_at || !job.completed_at) {
      excluded.push(job);
      continue;
    }
    if (isWindowsJob(job)) {
      excluded.push(job);
      continue;
    }
    included.push(job);
  }
  return { included, excluded };
}

function majorityProvider(jobs: readonly BenchJob[]): Provider {
  const counts = new Map<Provider, number>();
  for (const job of jobs) {
    if (isAggregatorJob(job.name)) continue;
    const provider = classifyProvider(job);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  let best: Provider = 'unknown';
  let bestN = -1;
  for (const [provider, n] of counts) {
    if (n > bestN) {
      best = provider;
      bestN = n;
    }
  }
  return best;
}

export function extractPhaseTimes(run: BenchRun): PhaseTimes | null {
  if (!isUsableRun(run)) return null;
  const { included, excluded } = requiredPathJobs(run);
  if (included.length === 0) return null;

  const eventMs = Date.parse(run.created_at);
  if (!Number.isFinite(eventMs)) return null;

  const firstStart = Math.min(...included.map((j) => Date.parse(j.started_at!)));
  const queueMs = Math.max(0, firstStart - eventMs);

  const leaves = included.filter((j) => !isAggregatorJob(j.name));
  const setupMs = leaves.length === 0
    ? Math.max(...included.map((j) => sumClassified(j.steps, isSetupStep)))
    : Math.max(...leaves.map((j) => sumClassified(j.steps, isSetupStep)));
  const executionMs = leaves.length === 0
    ? Math.max(...included.map((j) => sumClassified(j.steps, (n) => !isSetupStep(n) && !isReportStep(n))))
    : Math.max(...leaves.map((j) => sumClassified(j.steps, (n) => !isSetupStep(n) && !isReportStep(n))));

  const aggregator = included.find((j) => isAggregatorJob(j.name));
  const reportMs = aggregator
    ? (jobDurationMs(aggregator) ?? sumClassified(aggregator.steps, isReportStep))
    : Math.max(...included.map((j) => sumClassified(j.steps, isReportStep)));

  const terminal = aggregator ?? included.reduce((latest, job) => {
    return Date.parse(job.completed_at!) > Date.parse(latest.completed_at!) ? job : latest;
  });
  const e2eMs = Math.max(0, Date.parse(terminal.completed_at!) - eventMs);

  return {
    runId: run.id,
    kind: inferRunKind(run),
    provider: majorityProvider(leaves.length > 0 ? leaves : included),
    queueMs,
    setupMs,
    executionMs,
    reportMs,
    e2eMs,
    includedJobNames: included.map((j) => j.name),
    excludedJobNames: excluded.map((j) => j.name),
  };
}

export function extractAllPhaseTimes(runs: readonly BenchRun[]): PhaseTimes[] {
  const out: PhaseTimes[] = [];
  for (const run of runs) {
    const times = extractPhaseTimes(run);
    if (times) out.push(times);
  }
  return out;
}

export function valuesForPhase(times: readonly PhaseTimes[], phase: keyof Pick<PhaseTimes, 'queueMs' | 'setupMs' | 'executionMs' | 'reportMs' | 'e2eMs'>): number[] {
  return times.map((t) => t[phase]);
}
