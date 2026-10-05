export const CI_TAIL_PERCENTILES = [99, 99.9, 99.99] as const;
export const REPORTED_PERCENTILES = [50, 90, 99, 99.9, 99.99] as const;

export const CI_P99_BUDGET_MS = 90_000;
export const CI_CACHE_HIT_BUDGET_MS = 10_000;
export const RELEASE_P99_BUDGET_MS = 180_000;

export const PHASES = ['queue', 'setup', 'execution', 'report', 'e2e'] as const;
export type Phase = (typeof PHASES)[number];

export type RunKind = 'required-ci' | 'release';

export type Provider =
  | 'github-hosted'
  | 'crabbox'
  | 'windows'
  | 'macos'
  | 'unknown';

export type SampleGateStatus = 'ok' | 'insufficient-sample';

export interface GatedPercentile {
  p: number;
  n: number;
  required: number;
  status: SampleGateStatus;
  valueMs: number | null;
  rank: number | null;
}

export interface BenchStep {
  name: string;
  started_at: string | null;
  completed_at: string | null;
  conclusion?: string | null;
}

export interface BenchJob {
  name: string;
  labels?: string[];
  runner_name?: string | null;
  runner_group_name?: string | null;
  started_at: string | null;
  completed_at: string | null;
  conclusion?: string | null;
  steps?: BenchStep[];
}

export interface BenchRun {
  id: number | string;
  name?: string;
  event?: string;
  kind?: RunKind;
  created_at: string;
  run_started_at?: string | null;
  conclusion?: string | null;
  head_sha?: string;
  jobs: BenchJob[];
}

export interface BenchInput {
  runs: BenchRun[];
}

export interface PhaseTimes {
  runId: number | string;
  kind: RunKind;
  provider: Provider;
  queueMs: number;
  setupMs: number;
  executionMs: number;
  reportMs: number;
  e2eMs: number;
  includedJobNames: string[];
  excludedJobNames: string[];
}

export interface PhasePercentiles {
  phase: Phase;
  n: number;
  percentiles: GatedPercentile[];
}

export interface ProviderComparison {
  phase: Phase;
  p: number;
  left: { provider: Provider; sample: GatedPercentile };
  right: { provider: Provider; sample: GatedPercentile };
  status: 'ok' | 'insufficient-sample';
  deltaMs: number | null;
  faster: Provider | 'tie' | null;
}

export interface TargetEvaluation {
  name: string;
  kind: RunKind;
  p: number;
  budgetMs: number;
  sample: GatedPercentile;
  pass: boolean;
  reason: string;
}

export interface WindowsRequiredFinding {
  required: boolean;
  evidence: string;
  pass: boolean;
}
