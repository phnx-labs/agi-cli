import { gatedPercentile } from './percentile';
import type {
  GatedPercentile,
  RunKind,
  TargetEvaluation,
  WindowsRequiredFinding,
} from './types';
import {
  CI_P99_BUDGET_MS,
  CI_TAIL_PERCENTILES,
  RELEASE_P99_BUDGET_MS,
} from './types';

export function evaluateTarget(
  name: string,
  kind: RunKind,
  p: number,
  budgetMs: number,
  values: readonly number[],
): TargetEvaluation {
  const sample = gatedPercentile(values, p);
  if (sample.status === 'insufficient-sample') {
    return {
      name,
      kind,
      p,
      budgetMs,
      sample,
      pass: false,
      reason: `need ${sample.required} samples for P${p}; have ${sample.n}`,
    };
  }
  const valueMs = sample.valueMs!;
  const pass = valueMs <= budgetMs;
  return {
    name,
    kind,
    p,
    budgetMs,
    sample,
    pass,
    reason: pass
      ? `P${p}=${valueMs}ms <= ${budgetMs}ms`
      : `P${p}=${valueMs}ms exceeds ${budgetMs}ms`,
  };
}

/** CI required-path e2e: P99, P99.9, P99.99 each <= 90s. */
export function evaluateCiTargets(e2eMs: readonly number[]): TargetEvaluation[] {
  return CI_TAIL_PERCENTILES.map((p) =>
    evaluateTarget(`required-ci e2e P${p}`, 'required-ci', p, CI_P99_BUDGET_MS, e2eMs),
  );
}

/** Ordinary release e2e: P99 / P99.9 / P99.99 each <= 180s. */
export function evaluateReleaseTargets(e2eMs: readonly number[]): TargetEvaluation[] {
  return CI_TAIL_PERCENTILES.map((p) =>
    evaluateTarget(`release e2e P${p}`, 'release', p, RELEASE_P99_BUDGET_MS, e2eMs),
  );
}

/** The required aggregator must not `need` the windows job: skipped-when-unneeded is not enough,
 * since the aggregator still waits on that identity. */
export function windowsRequiredFromWorkflow(source: string): WindowsRequiredFinding {
  const aggregator = extractJobBlock(source, 'test') ?? extractJobBlock(source, 'required');
  if (!aggregator) {
    return {
      required: false,
      evidence: 'no required aggregator job named test/required',
      pass: true,
    };
  }
  const needsMatch = aggregator.match(/^\s*needs:\s*\[([^\]]*)\]/m);
  if (!needsMatch) {
    return {
      required: false,
      evidence: 'aggregator has no needs list',
      pass: true,
    };
  }
  const needs = needsMatch[1].split(',').map((s) => s.trim().replace(/['"]/g, ''));
  const required = needs.includes('windows');
  return {
    required,
    evidence: `aggregator needs: [${needs.join(', ')}]`,
    pass: !required,
  };
}

function extractJobBlock(source: string, jobId: string): string | null {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

export function allTargetsPass(evals: readonly TargetEvaluation[]): boolean {
  return evals.every((e) => e.pass);
}

export function formatSample(sample: GatedPercentile): string {
  if (sample.status === 'insufficient-sample') {
    return `P${sample.p}=insufficient-sample n=${sample.n} need=${sample.required}`;
  }
  return `P${sample.p}=${sample.valueMs}ms n=${sample.n}`;
}
