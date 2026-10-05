import { describe, expect, test } from 'bun:test';
import { FairScheduler } from './fairness';
import { requestTemplate } from './execute';
import { emptyTimings, type ExecutorRequest, type RunRecord } from './types';

function run(id: string, repo: string, enqueuedAtMs: number, resourceClass: ExecutorRequest['resourceClass'] = 'small'): RunRecord {
  const request = requestTemplate({
    owner: 'phnx-labs',
    repo,
    checkRunId: id,
    candidateCommitSha: 'a'.repeat(40),
    candidateTreeSha: 'a'.repeat(40),
    resourceClass,
  }) as unknown as ExecutorRequest;
  return {
    runId: id,
    request,
    status: 'queued',
    worktreePath: `/srv/ci/runs/phnx-labs/${repo}/${'a'.repeat(40)}/${id}/worktree`,
    resultPath: `/srv/ci/results/phnx-labs/${repo}/${id}`,
    timings: { ...emptyTimings(enqueuedAtMs) },
  };
}

describe('FairScheduler', () => {
  test('admits concurrent repos up to slot and per-repo caps without a lease', () => {
    const sched = new FairScheduler({ maxSlots: 4, maxPerRepo: 2 });
    expect(sched.canAdmit('phnx-labs', 'alpha', 'small').admit).toBe(true);
    sched.markRunning(run('a1', 'alpha', 1));
    sched.markRunning(run('b1', 'beta', 2));
    sched.markRunning(run('c1', 'gamma', 3));
    expect(sched.runningSlots()).toBe(3);
    expect(sched.canAdmit('phnx-labs', 'alpha', 'small').admit).toBe(true);
    sched.markRunning(run('a2', 'alpha', 4));
    expect(sched.canAdmit('phnx-labs', 'alpha', 'small')).toEqual({ admit: false, reason: 'per-repo' });
    expect(sched.canAdmit('phnx-labs', 'delta', 'small')).toEqual({ admit: false, reason: 'capacity' });
  });

  test('when a slot frees, the least-served repo is admitted first', () => {
    const sched = new FairScheduler({ maxSlots: 2, maxPerRepo: 2 });
    const a1 = run('a1', 'alpha', 10);
    const b1 = run('b1', 'beta', 20);
    const a2 = run('a2', 'alpha', 5);
    sched.markRunning(a1);
    sched.markRunning(b1);
    sched.enqueue(a2);
    const b2 = run('b2', 'beta', 1);
    sched.enqueue(b2);
    sched.complete('a1');
    expect(sched.nextEligible()?.runId).toBe('a2');
  });

  test('a large job waits for enough slots instead of taking the machine', () => {
    const sched = new FairScheduler({ maxSlots: 4, maxPerRepo: 2 });
    sched.markRunning(run('s1', 'alpha', 1));
    expect(sched.canAdmit('phnx-labs', 'beta', 'large')).toEqual({ admit: false, reason: 'capacity' });
    sched.complete('s1');
    expect(sched.canAdmit('phnx-labs', 'beta', 'large').admit).toBe(true);
  });
});
