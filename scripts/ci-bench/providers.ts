import { gatedPercentile } from './percentile';
import type { BenchJob, Phase, PhaseTimes, Provider, ProviderComparison } from './types';
import { PHASES } from './types';

const PHASE_KEY = {
  queue: 'queueMs',
  setup: 'setupMs',
  execution: 'executionMs',
  report: 'reportMs',
  e2e: 'e2eMs',
} as const;

export function classifyProvider(job: BenchJob): Provider {
  const labels = (job.labels ?? []).map((l) => l.toLowerCase());
  const name = (job.name ?? '').toLowerCase();
  const runner = `${job.runner_name ?? ''} ${job.runner_group_name ?? ''}`.toLowerCase();
  const blob = [...labels, name, runner].join(' ');

  if (blob.includes('windows')) return 'windows';
  if (blob.includes('macos') || blob.includes('osx')) return 'macos';
  if (
    blob.includes('crabbox')
    || blob.includes('self-hosted')
    || blob.includes('phnx-')
    || blob.includes('firecracker')
  ) {
    return 'crabbox';
  }
  if (
    labels.some((l) => l === 'ubuntu-latest' || l === 'ubuntu-24.04' || l === 'ubuntu-22.04')
    || runner.includes('github actions')
  ) {
    return 'github-hosted';
  }
  return 'unknown';
}

export function groupByProvider(times: readonly PhaseTimes[]): Map<Provider, PhaseTimes[]> {
  const groups = new Map<Provider, PhaseTimes[]>();
  for (const row of times) {
    const list = groups.get(row.provider) ?? [];
    list.push(row);
    groups.set(row.provider, list);
  }
  return groups;
}

/** Compare two providers on one phase/percentile. Both sides must clear the sample-count gate or the
 * result is `insufficient-sample` with no delta; a thin sample must not claim a winner. */
export function compareProviders(
  leftTimes: readonly PhaseTimes[],
  rightTimes: readonly PhaseTimes[],
  left: Provider,
  right: Provider,
  phase: Phase,
  p: number,
): ProviderComparison {
  const key = PHASE_KEY[phase];
  const leftSample = gatedPercentile(leftTimes.map((t) => t[key]), p);
  const rightSample = gatedPercentile(rightTimes.map((t) => t[key]), p);
  if (leftSample.status !== 'ok' || rightSample.status !== 'ok') {
    return {
      phase,
      p,
      left: { provider: left, sample: leftSample },
      right: { provider: right, sample: rightSample },
      status: 'insufficient-sample',
      deltaMs: null,
      faster: null,
    };
  }
  const deltaMs = leftSample.valueMs! - rightSample.valueMs!;
  let faster: Provider | 'tie' = 'tie';
  if (deltaMs > 0) faster = right;
  else if (deltaMs < 0) faster = left;
  return {
    phase,
    p,
    left: { provider: left, sample: leftSample },
    right: { provider: right, sample: rightSample },
    status: 'ok',
    deltaMs,
    faster,
  };
}

export function compareAllProviders(
  times: readonly PhaseTimes[],
  pair: readonly [Provider, Provider] = ['github-hosted', 'crabbox'],
  percentiles: readonly number[] = [99, 99.9, 99.99],
): ProviderComparison[] {
  const groups = groupByProvider(times);
  const [left, right] = pair;
  const leftTimes = groups.get(left) ?? [];
  const rightTimes = groups.get(right) ?? [];
  const out: ProviderComparison[] = [];
  for (const phase of PHASES) {
    for (const p of percentiles) {
      out.push(compareProviders(leftTimes, rightTimes, left, right, phase, p));
    }
  }
  return out;
}
