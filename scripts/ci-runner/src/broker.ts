import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FairScheduler } from './fairness';
import { validateRequestShape } from './isolation';
import { ciLayout, resultPath, worktreePath, type CiLayout } from './paths';
import {
  DEFAULT_CAPACITY,
  emptyTimings,
  type Capacity,
  type ExecutorRequest,
  type RunRecord,
} from './types';

export interface BrokerOptions {
  layout?: CiLayout;
  capacity?: Capacity;
  now?: () => number;
}

function sleep(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

/** Shared no-lease broker: a submit requests admission to a standing Crabbox, never a box lease or
 * caller-chosen checkout. Scheduler membership is rebuilt from disk so sequential CLI submits share
 * the same caps. */
export class Broker {
  readonly layout: CiLayout;
  scheduler: FairScheduler;
  private readonly now: () => number;
  private readonly capacity: Capacity;

  constructor(opts: BrokerOptions = {}) {
    this.layout = opts.layout ?? ciLayout();
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.now = opts.now ?? Date.now;
    mkdirSync(join(this.layout.state, 'runs'), { recursive: true });
    this.scheduler = this.loadScheduler();
  }

  submit(raw: Record<string, unknown>): RunRecord {
    return this.withLock(() => {
      this.reload();
      const request = validateRequestShape(raw);
      const runId = request.checkRunId;
      const existing = this.tryRead(runId);
      if (existing) {
        throw new Error(`run ${runId} already exists with status ${existing.status}`);
      }

      const record: RunRecord = {
        runId,
        request,
        status: 'queued',
        worktreePath: worktreePath(this.layout, request),
        resultPath: resultPath(this.layout, request.owner, request.repo, runId),
        timings: emptyTimings(this.now()),
      };

      const decision = this.scheduler.canAdmit(request.owner, request.repo, request.resourceClass);
      if (decision.admit) {
        record.status = 'admitted';
        record.timings.admittedAtMs = this.now();
        this.scheduler.markRunning(record);
      } else {
        this.scheduler.enqueue(record);
      }

      this.write(record);
      return record;
    });
  }

  drain(): RunRecord[] {
    return this.withLock(() => this.drainLocked());
  }

  complete(runId: string, status: 'succeeded' | 'failed', extra: Partial<RunRecord> = {}): RunRecord {
    return this.withLock(() => {
      this.reload();
      const record = this.read(runId);
      record.status = status;
      Object.assign(record, extra);
      this.scheduler.complete(runId);
      this.write(record);
      this.drainLocked();
      return record;
    });
  }

  read(runId: string): RunRecord {
    const record = this.tryRead(runId);
    if (!record) throw new Error(`unknown run ${runId}`);
    return record;
  }

  tryRead(runId: string): RunRecord | null {
    const file = this.recordPath(runId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
  }

  private drainLocked(): RunRecord[] {
    const admitted: RunRecord[] = [];
    let next = this.scheduler.nextEligible();
    while (next) {
      const record = this.read(next.runId);
      record.status = 'admitted';
      record.timings.admittedAtMs = this.now();
      this.scheduler.markRunning(record);
      this.write(record);
      admitted.push(record);
      next = this.scheduler.nextEligible();
    }
    return admitted;
  }

  private loadScheduler(): FairScheduler {
    const sched = new FairScheduler(this.capacity);
    for (const record of this.allRecords()) {
      if (record.status === 'admitted' || record.status === 'running') sched.markRunning(record);
      else if (record.status === 'queued') sched.enqueue(record);
    }
    return sched;
  }

  private reload(): void {
    this.scheduler = this.loadScheduler();
  }

  private allRecords(): RunRecord[] {
    const dir = join(this.layout.state, 'runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as RunRecord);
  }

  private recordPath(runId: string): string {
    return join(this.layout.state, 'runs', `${runId}.json`);
  }

  private write(record: RunRecord): void {
    writeFileSync(this.recordPath(record.runId), JSON.stringify(record, null, 2));
  }

  private withLock<T>(fn: () => T): T {
    const lock = join(this.layout.state, '.lock');
    for (let i = 0; i < 100; i++) {
      try {
        mkdirSync(lock);
        try {
          return fn();
        } finally {
          rmdirSync(lock);
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'EEXIST') throw err;
        sleep(10);
      }
    }
    throw new Error('broker lock timeout');
  }
}

export function requestFromUnknown(input: unknown): ExecutorRequest {
  if (!input || typeof input !== 'object') throw new Error('executor request must be an object');
  return validateRequestShape(input as Record<string, unknown>);
}
