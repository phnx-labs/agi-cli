/** Shared untrusted-code executor types (RUSH-2666). */

export const POLICY_VERSION = 'executor-v1';

export const RESOURCE_CLASSES = ['small', 'medium', 'large'] as const;
export type ResourceClass = (typeof RESOURCE_CLASSES)[number];

/** Slot weights for CPU/memory admission. A large job is four small jobs. */
export const RESOURCE_WEIGHT: Record<ResourceClass, number> = {
  small: 1,
  medium: 2,
  large: 4,
};

/** Fields a caller must never send: the executor derives the worktree and never acquires a box. Any
 * of them is a hard reject. */
export const FORBIDDEN_REQUEST_FIELDS = [
  'lease',
  'leaseId',
  'box',
  'boxId',
  'checkout',
  'checkoutPath',
  'workspace',
  'mutablePath',
] as const;

export type ForbiddenRequestField = (typeof FORBIDDEN_REQUEST_FIELDS)[number];

export interface ExecutorRequest {
  owner: string;
  repo: string;
  candidateTreeSha: string;
  candidateCommitSha: string;
  selectionBaseSha: string;
  prHeadSha: string;
  baseSha: string;
  impactPlanDigest: string;
  resourceClass: ResourceClass;
  checkRunId: string;
  isFork: boolean;
  policyVersion: string;
}

export type RunStatus =
  | 'queued'
  | 'admitted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected';

export interface Timings {
  enqueuedAtMs: number;
  admittedAtMs: number | null;
  setupStartedAtMs: number | null;
  setupEndedAtMs: number | null;
  execStartedAtMs: number | null;
  execEndedAtMs: number | null;
  reportedAtMs: number | null;
}

export interface RunRecord {
  runId: string;
  request: ExecutorRequest;
  status: RunStatus;
  rejectReason?: string;
  worktreePath: string;
  resultPath: string;
  vmId?: string;
  timings: Timings;
  exitCode?: number;
  reportDigest?: string;
}

export interface Attestation {
  runId: string;
  candidateTreeSha: string;
  candidateCommitSha: string;
  selectionBaseSha: string;
  prHeadSha: string;
  baseSha: string;
  impactPlanDigest: string;
  policyVersion: string;
  exitCode: number;
  reportDigest: string;
  timings: Timings;
  signature: string;
}

export interface Capacity {
  maxSlots: number;
  maxPerRepo: number;
}

export const DEFAULT_CAPACITY: Capacity = {
  maxSlots: 8,
  maxPerRepo: 2,
};

export function repoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function emptyTimings(now = Date.now()): Timings {
  return {
    enqueuedAtMs: now,
    admittedAtMs: null,
    setupStartedAtMs: null,
    setupEndedAtMs: null,
    execStartedAtMs: null,
    execEndedAtMs: null,
    reportedAtMs: null,
  };
}
