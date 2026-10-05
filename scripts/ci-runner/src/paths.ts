import { join } from 'node:path';
import type { ExecutorRequest } from './types';

export const DEFAULT_CI_ROOT = '/srv/ci';

export interface CiLayout {
  root: string;
  mirrors: string;
  runs: string;
  results: string;
  cache: string;
  snapshots: string;
  state: string;
}

export function ciLayout(root = process.env.CI_ROOT || DEFAULT_CI_ROOT): CiLayout {
  return {
    root,
    mirrors: join(root, 'mirrors'),
    runs: join(root, 'runs'),
    results: join(root, 'results'),
    cache: join(root, 'cache'),
    snapshots: join(root, 'snapshots'),
    state: join(root, 'state'),
  };
}

export function mirrorPath(layout: CiLayout, owner: string, repo: string): string {
  return join(layout.mirrors, owner, `${repo}.git`);
}

export function runDir(layout: CiLayout, req: Pick<ExecutorRequest, 'owner' | 'repo' | 'candidateTreeSha' | 'checkRunId'>): string {
  return join(layout.runs, req.owner, req.repo, req.candidateTreeSha, req.checkRunId);
}

export function worktreePath(layout: CiLayout, req: Pick<ExecutorRequest, 'owner' | 'repo' | 'candidateTreeSha' | 'checkRunId'>): string {
  return join(runDir(layout, req), 'worktree');
}

export function resultPath(layout: CiLayout, owner: string, repo: string, runId: string): string {
  return join(layout.results, owner, repo, runId);
}

export function bunCachePath(layout: CiLayout, lockfileDigest: string): string {
  return join(layout.cache, 'bun', lockfileDigest);
}

export function warmSnapshotPath(layout: CiLayout): string {
  return join(layout.snapshots, 'warm');
}

export function assertSafeSegment(value: string, label: string): string {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} is not a safe path segment: ${JSON.stringify(value)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} is not a safe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}
