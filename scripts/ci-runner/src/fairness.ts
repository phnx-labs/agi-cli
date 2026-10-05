import {
  DEFAULT_CAPACITY,
  RESOURCE_WEIGHT,
  repoKey,
  type Capacity,
  type ResourceClass,
  type RunRecord,
} from './types';

export interface AdmissionDecision {
  admit: boolean;
  reason: 'capacity' | 'per-repo' | 'admitted';
}

/** Fair CPU/memory admission: short-lived slot admission, not a machine lease; the box is never
 * exclusively assigned to a run. */
export class FairScheduler {
  constructor(
    readonly capacity: Capacity = DEFAULT_CAPACITY,
    private readonly running: RunRecord[] = [],
    private readonly queued: RunRecord[] = [],
  ) {}

  runningSlots(): number {
    return this.running.reduce((sum, run) => sum + RESOURCE_WEIGHT[run.request.resourceClass], 0);
  }

  runningFor(owner: string, repo: string): number {
    const key = repoKey(owner, repo);
    return this.running.filter((run) => repoKey(run.request.owner, run.request.repo) === key).length;
  }

  canAdmit(owner: string, repo: string, resourceClass: ResourceClass): AdmissionDecision {
    const weight = RESOURCE_WEIGHT[resourceClass];
    if (this.runningFor(owner, repo) >= this.capacity.maxPerRepo) {
      return { admit: false, reason: 'per-repo' };
    }
    if (this.runningSlots() + weight > this.capacity.maxSlots) {
      return { admit: false, reason: 'capacity' };
    }
    return { admit: true, reason: 'admitted' };
  }

  markRunning(run: RunRecord): void {
    const queuedAt = this.queued.findIndex((item) => item.runId === run.runId);
    if (queuedAt >= 0) this.queued.splice(queuedAt, 1);
    if (!this.running.some((item) => item.runId === run.runId)) this.running.push(run);
  }

  enqueue(run: RunRecord): void {
    if (!this.queued.some((item) => item.runId === run.runId)) this.queued.push(run);
  }

  complete(runId: string): void {
    const idx = this.running.findIndex((item) => item.runId === runId);
    if (idx >= 0) this.running.splice(idx, 1);
  }

  /** Next queued job that fits: among eligible jobs pick the repo with the fewest running jobs, then
   * the oldest enqueue time, so one repo cannot starve others. */
  nextEligible(): RunRecord | null {
    const eligible = this.queued.filter((run) =>
      this.canAdmit(run.request.owner, run.request.repo, run.request.resourceClass).admit,
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => {
      const aRun = this.runningFor(a.request.owner, a.request.repo);
      const bRun = this.runningFor(b.request.owner, b.request.repo);
      if (aRun !== bRun) return aRun - bRun;
      return a.timings.enqueuedAtMs - b.timings.enqueuedAtMs;
    });
    return eligible[0]!;
  }

  snapshot(): { running: string[]; queued: string[] } {
    return {
      running: this.running.map((run) => run.runId),
      queued: this.queued.map((run) => run.runId),
    };
  }
}
