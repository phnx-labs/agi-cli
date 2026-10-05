import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildUnsigned, digestBytes, signAttestation } from './attestation';
import { Broker } from './broker';
import { ForkSafeCache } from './cache';
import { FirecrackerPool } from './firecracker';
import { assertWorkerEnv, workerEnv } from './isolation';
import { createRunWorktree, removeRunWorktree } from './worktree';
import type { ExecutorRequest, RunRecord } from './types';

export interface ExecuteOptions {
  broker: Broker;
  runId: string;
  sourceGitDir: string;
  command: string[];
  controllerKey: string;
  lockfileDigest?: string;
  cacheMode?: 'read-write' | 'restore-only';
  cacheFiles?: Record<string, string>;
  now?: () => number;
}

export interface ExecuteResult {
  record: RunRecord;
  attestationPath: string;
}

function requireAdmitted(record: RunRecord): void {
  if (record.status !== 'admitted') {
    throw new Error(`run ${record.runId} is ${record.status}, not admitted`);
  }
}

function persist(broker: Broker, record: RunRecord): void {
  const file = join(broker.layout.state, 'runs', `${record.runId}.json`);
  mkdirSync(join(broker.layout.state, 'runs'), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2));
}

/** Controller-side execution: the worker sees only the worktree and a read-only cache, via
 * Firecracker. The controller observes exit status, hashes reports, and signs the attestation with
 * a key never mounted into the worker. */
export function runAdmittedJob(opts: ExecuteOptions): ExecuteResult {
  const now = opts.now ?? Date.now;
  const { broker } = opts;
  const record = broker.read(opts.runId);
  requireAdmitted(record);
  const req = record.request;
  const pool = new FirecrackerPool(broker.layout);
  const vmId = `vm-${req.checkRunId}`;
  let worktree = '';

  record.status = 'running';
  record.timings.setupStartedAtMs = now();
  persist(broker, record);

  try {
    worktree = createRunWorktree(broker.layout, req, opts.sourceGitDir);
    mkdirSync(record.resultPath, { recursive: true });

    let cachePath: string | undefined;
    if (opts.lockfileDigest) {
      const cache = new ForkSafeCache({
        layout: broker.layout,
        lockfileDigest: opts.lockfileDigest,
        mode: opts.cacheMode ?? 'read-write',
      });
      if (opts.cacheFiles && (opts.cacheMode ?? 'read-write') === 'read-write' && !cache.exists()) {
        cache.populate(opts.cacheFiles);
      }
      if (cache.exists()) cachePath = cache.restore();
    }

    pool.restore(vmId, [
      { source: worktree, target: '/work', writable: true },
      ...(cachePath ? [{ source: cachePath, target: '/cache', writable: false }] : []),
    ]);
    record.vmId = vmId;
    record.timings.setupEndedAtMs = now();
    record.timings.execStartedAtMs = now();
    persist(broker, record);

    const workerHome = join(worktree, '.home');
    mkdirSync(workerHome, { recursive: true });
    const env = workerEnv(workerHome);
    assertWorkerEnv(env);

    const vm = pool.start(vmId, { command: opts.command, cwd: worktree, env });
    const logs = pool.logs(vmId);
    writeFileSync(join(record.resultPath, 'stdout.log'), logs.stdout);
    writeFileSync(join(record.resultPath, 'stderr.log'), logs.stderr);

    record.timings.execEndedAtMs = now();
    record.exitCode = vm.exitCode ?? 1;
    record.reportDigest = digestBytes(`${logs.stdout}\n${logs.stderr}`);

    if (existsSync(join(worktree, 'attestation.json'))) {
      throw new Error('worker wrote an attestation; only the controller may conclude a run');
    }

    const attestation = signAttestation(
      buildUnsigned(req, record.runId, record.exitCode, record.reportDigest, record.timings),
      opts.controllerKey,
    );
    const attestationPath = join(record.resultPath, 'attestation.json');
    writeFileSync(attestationPath, JSON.stringify(attestation, null, 2));

    record.timings.reportedAtMs = now();
    const finished = broker.complete(record.runId, record.exitCode === 0 ? 'succeeded' : 'failed', {
      timings: record.timings,
      exitCode: record.exitCode,
      reportDigest: record.reportDigest,
      vmId,
      worktreePath: worktree,
      resultPath: record.resultPath,
    });
    return { record: finished, attestationPath };
  } catch (err) {
    record.timings.reportedAtMs = now();
    broker.complete(record.runId, 'failed', {
      timings: record.timings,
      exitCode: record.exitCode ?? 1,
      vmId,
      worktreePath: worktree || record.worktreePath,
      resultPath: record.resultPath,
    });
    throw err;
  } finally {
    if (pool.exists(vmId)) pool.destroy(vmId);
    if (worktree) removeRunWorktree(broker.layout, req, opts.sourceGitDir);
  }
}

export function requestTemplate(
  partial: Partial<ExecutorRequest> &
    Pick<ExecutorRequest, 'owner' | 'repo' | 'checkRunId' | 'candidateCommitSha' | 'candidateTreeSha'>,
): Record<string, unknown> {
  return {
    selectionBaseSha: 'b'.repeat(40),
    prHeadSha: partial.candidateCommitSha,
    baseSha: 'c'.repeat(40),
    impactPlanDigest: 'd'.repeat(64),
    resourceClass: 'small',
    isFork: false,
    policyVersion: 'executor-v1',
    ...partial,
  };
}

export function loadAttestation(path: string): ReturnType<typeof JSON.parse> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Sweep completed run records. Active admitted/running records stay. */
export function janitorCompletedRuns(broker: Broker, olderThanMs: number, now = Date.now()): string[] {
  const runsDir = join(broker.layout.state, 'runs');
  if (!existsSync(runsDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(runsDir)) {
    if (!name.endsWith('.json')) continue;
    const record = JSON.parse(readFileSync(join(runsDir, name), 'utf8')) as RunRecord;
    const terminal = record.status === 'succeeded' || record.status === 'failed' || record.status === 'rejected';
    if (!terminal) continue;
    const doneAt = record.timings.reportedAtMs ?? record.timings.enqueuedAtMs;
    if (now - doneAt < olderThanMs) continue;
    rmSync(join(runsDir, name));
    if (existsSync(record.resultPath)) rmSync(record.resultPath, { recursive: true, force: true });
    removed.push(record.runId);
  }
  return removed;
}
