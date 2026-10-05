import { assertSafeSegment } from './paths';
import {
  FORBIDDEN_REQUEST_FIELDS,
  RESOURCE_CLASSES,
  type ExecutorRequest,
  type ForbiddenRequestField,
} from './types';

export const FORBIDDEN_WORKER_ENV = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HCLOUD_TOKEN',
  'TAILSCALE_AUTHKEY',
  'AGENTS_CONTROLLER_KEY',
] as const;

export const FORBIDDEN_MOUNTS = [
  '/var/run/docker.sock',
  '/var/run/tailscale',
  '/var/run/tailscale.socket',
  '/home',
  '/root',
  '/etc/ssh',
] as const;

export interface IsolationViolation {
  kind: 'request-field' | 'env' | 'mount' | 'fork-on-persistent';
  detail: string;
}

export function findForbiddenRequestFields(input: Record<string, unknown>): ForbiddenRequestField[] {
  return FORBIDDEN_REQUEST_FIELDS.filter((field) => field in input && input[field] != null);
}

export function validateRequestShape(input: Record<string, unknown>): ExecutorRequest {
  const forbidden = findForbiddenRequestFields(input);
  if (forbidden.length > 0) {
    throw new Error(
      `executor request must not carry a lease or checkout path (got ${forbidden.join(', ')}); the broker derives the worktree`,
    );
  }

  const required: Array<keyof ExecutorRequest> = [
    'owner',
    'repo',
    'candidateTreeSha',
    'candidateCommitSha',
    'selectionBaseSha',
    'prHeadSha',
    'baseSha',
    'impactPlanDigest',
    'resourceClass',
    'checkRunId',
    'isFork',
    'policyVersion',
  ];
  for (const key of required) {
    if (!(key in input)) {
      throw new Error(`executor request missing ${key}`);
    }
  }

  const req = input as unknown as ExecutorRequest;
  if (req.isFork) {
    throw new Error(
      'fork pull requests are never scheduled on the persistent executor; use the GitHub-hosted isolated lane',
    );
  }
  if (!RESOURCE_CLASSES.includes(req.resourceClass)) {
    throw new Error(`unknown resourceClass ${JSON.stringify(req.resourceClass)}`);
  }
  assertSafeSegment(req.owner, 'owner');
  assertSafeSegment(req.repo, 'repo');
  assertSafeSegment(req.candidateTreeSha, 'candidateTreeSha');
  assertSafeSegment(req.checkRunId, 'checkRunId');
  for (const [label, value] of [
    ['candidateCommitSha', req.candidateCommitSha],
    ['selectionBaseSha', req.selectionBaseSha],
    ['prHeadSha', req.prHeadSha],
    ['baseSha', req.baseSha],
  ] as const) {
    if (!/^[0-9a-f]{40,64}$/.test(value)) {
      throw new Error(`${label} is not a hex git object: ${JSON.stringify(value)}`);
    }
  }
  if (!/^[0-9a-f]{8,128}$/.test(req.impactPlanDigest)) {
    throw new Error(`impactPlanDigest is not a hex digest: ${JSON.stringify(req.impactPlanDigest)}`);
  }
  return req;
}

export function assertWorkerEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  const leaked = FORBIDDEN_WORKER_ENV.filter((name) => env[name]);
  if (leaked.length > 0) {
    throw new Error(`worker env leaked secrets or host credentials: ${leaked.join(', ')}`);
  }
}

export function assertMounts(mounts: readonly string[]): void {
  for (const mount of mounts) {
    for (const forbidden of FORBIDDEN_MOUNTS) {
      if (mount === forbidden || mount.startsWith(`${forbidden}/`)) {
        throw new Error(`worker mount is forbidden: ${mount}`);
      }
    }
  }
}

export function workerEnv(home: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    CI: '1',
    // Explicitly not inherited: tokens, SSH agent, fleet secrets.
  };
}
