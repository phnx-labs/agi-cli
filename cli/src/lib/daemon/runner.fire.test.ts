import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Cron } from 'croner';
import { executeJob, executeJobDetached } from './runner.js';
import { slotRunId, claimRunSlot, getRunDir, getJobRunsDir, readRunMeta } from '../scheduling/routines.js';
import type { JobConfig, RunMeta } from '../scheduling/routines.js';
import { fireSlot } from '../scheduler.js';
import { missedRunId } from '../catchup.js';
import * as activation from '../routine-activation.js';

const describeSpawn = process.platform === 'win32' ? describe.skip : describe;

// Exercise definition eligibility directly rather than inheriting this host's
// real device manifest (same seam as runner.test.ts).
beforeEach(() => {
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function cleanupJobRuns(name: string): void {
  fs.rmSync(getJobRunsDir(name), { recursive: true, force: true });
}

describe('slot claim primitives', () => {
  afterEach(() => cleanupJobRuns('slot-prim'));

  it('slotRunId derives a stable, path-safe id from a UTC time', () => {
    const id = slotRunId('2026-08-07T08:00:00.000Z');
    expect(id).toBe('2026-08-07T08-00-00-000Z');
    expect(slotRunId(new Date('2026-08-07T08:00:00.000Z'))).toBe(id);
  });

  it('claimRunSlot is an atomic test-and-set — the second claim of a slot loses', () => {
    const id = slotRunId('2026-08-07T09:00:00.000Z');
    expect(claimRunSlot('slot-prim', id)).toBe(true);
    expect(claimRunSlot('slot-prim', id)).toBe(false);
    expect(fs.existsSync(getRunDir('slot-prim', id))).toBe(true);
  });
});

describeSpawn('single-fire + overlap + blocked (executeJobDetached)', () => {
  const jobs: string[] = [];
  afterEach(() => { for (const j of jobs.splice(0)) cleanupJobRuns(j); });

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitTerminal(name: string, runId: string, ms = 4000): Promise<RunMeta> {
    const metaPath = path.join(getRunDir(name, runId), 'meta.json');
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
        if (m.status !== 'running') return m;
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 40));
    }
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RunMeta;
  }

  it('two deliveries of the same UTC slot produce ONE launch (duplicate links the original)', async () => {
    const cfg = commandConfig('slot-dupe', 'exit 0');
    const scheduledFor = new Date('2026-08-07T10:00:00.000Z');
    const first = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor });
    await waitTerminal(cfg.name, first.runId);
    // Same slot again — resolves to the SAME run, launches nothing new.
    const second = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor });
    expect(second.runId).toBe(first.runId);
    expect(first.runId).toBe(slotRunId(scheduledFor));
    expect(first.scheduledFor).toBe(scheduledFor.toISOString());
    expect(first.triggerKind).toBe('schedule');
    // Exactly one run directory exists for this routine.
    const dirs = fs.readdirSync(getJobRunsDir(cfg.name)).filter((d) => !d.startsWith('.'));
    expect(dirs).toEqual([first.runId]);
  });

  it('a scheduler-derived aligned slot dispatches once and dedups a duplicate delivery (SING-15)', async () => {
    const cfg = commandConfig('slot-derived', 'exit 0');
    // Drive the slot through the real forward-timer derivation: fireSlot floors croner's jittered
    // currentRun() to the aligned boundary. A prior bug keyed on the jittered instant, so two
    // deliveries of one occurrence minted distinct ids and both launched.
    const cron = new Cron(cfg.schedule, { paused: true });
    const boundary = new Date('2026-08-07T03:00:00.000Z');
    vi.spyOn(cron, 'currentRun').mockReturnValue(new Date(boundary.getTime() + 7));
    const slot = fireSlot(cron);
    expect(slot.getMilliseconds()).toBe(0);
    expect(slotRunId(slot)).toBe(missedRunId(boundary)); // collides with catch-up

    const first = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor: slot });
    await waitTerminal(cfg.name, first.runId);
    const second = await executeJobDetached(cfg, undefined, { kind: 'schedule', scheduledFor: slot });
    expect(second.runId).toBe(first.runId);
    expect(first.runId).toBe(slotRunId(slot));
    const dirs = fs.readdirSync(getJobRunsDir(cfg.name)).filter((d) => !d.startsWith('.'));
    expect(dirs).toEqual([first.runId]);
  });

  it('a later slot while the first run is still active is skipped, linking the active run', async () => {
    const sleep = `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},4000)"`;
    const cfg = commandConfig('slot-overlap', sleep);
    const first = await executeJobDetached(cfg, undefined, {
      kind: 'schedule', scheduledFor: new Date('2026-08-07T11:00:00.000Z'),
    });
    expect(first.status).toBe('running');
    // A different slot fires while the first is live.
    const later = await executeJobDetached(cfg, undefined, {
      kind: 'schedule', scheduledFor: new Date('2026-08-07T11:05:00.000Z'),
    });
    expect(later.status).toBe('skipped');
    expect(later.skipReason).toBe('active_run');
    expect(later.activeRunId).toBe(first.runId);
    expect(later.pid).toBeNull();
    await waitTerminal(cfg.name, first.runId, 8000);
  });

  it('a concurrent foreground request skips immediately instead of queueing behind the active run', async () => {
    const cfg = commandConfig('foreground-overlap', 'sleep 2');
    const firstPromise = executeJob(cfg, undefined, { kind: 'manual' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(second.meta.status).toBe('skipped');
    expect(second.meta.skipReason).toBe('active_run');
    expect(second.meta.activeRunId).toBeDefined();
    expect(second.meta.pid).toBeNull();
    const first = await firstPromise;
    expect(first.meta.status).toBe('completed');
    expect(second.meta.activeRunId).toBe(first.meta.runId);
  });

  it('reclaims a provisional active claim whose launcher process is dead', async () => {
    const cfg = commandConfig('dead-launcher-claim', 'exit 0');
    const staleRunId = 'dead-launcher';
    fs.mkdirSync(getRunDir(cfg.name, staleRunId), { recursive: true });
    fs.writeFileSync(path.join(getRunDir(cfg.name, staleRunId), 'meta.json'), JSON.stringify({
      jobName: cfg.name,
      runId: staleRunId,
      pid: 2_147_483_647,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      timeoutMs: 60_000,
    } satisfies RunMeta));

    const result = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(result.meta.status).toBe('completed');
    expect(result.meta.runId).not.toBe(staleRunId);
  });

  it('ages out a running record past its own timeout even when its pid is still live (RUSH-2640)', async () => {
    const cfg = commandConfig('old-live-launcher', 'exit 0');
    const activeRunId = 'old-live-launcher-run';
    fs.mkdirSync(getRunDir(cfg.name, activeRunId), { recursive: true });
    fs.writeFileSync(path.join(getRunDir(cfg.name, activeRunId), 'meta.json'), JSON.stringify({
      jobName: cfg.name,
      runId: activeRunId,
      pid: process.pid,
      spawnedAt: Date.now() - process.uptime() * 1000,
      status: 'running',
      // Started well past the 60s timeout: a run can't legitimately outlive its deadline, so it no
      // longer holds the slot though its pid is alive. Month-old `running` records wedged
      // sandbox-tests this way (RUSH-2640). A live launcher within its window still holds it.
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
      timeoutMs: 60_000,
    } satisfies RunMeta));

    const result = await executeJob(cfg, undefined, { kind: 'manual' });
    expect(result.meta.status).toBe('completed');
    expect(result.meta.runId).not.toBe(activeRunId);
  });

  it('an agent routine with no project/cwd is BLOCKED (execution_context_missing), no spawn', async () => {
    jobs.push('ctxless-agent');
    const cfg: JobConfig = {
      name: 'ctxless-agent', schedule: '0 3 * * *', agent: 'claude',
      mode: 'plan', effort: 'auto', timeout: '1m', enabled: true, prompt: 'hi',
    } as JobConfig;
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('blocked');
    expect(meta.pid).toBeNull();
    expect(meta.readiness?.code).toBe('execution_context_missing');
    // The blocked attempt is a persisted, visible record.
    const persisted = readRunMeta(cfg.name, meta.runId);
    expect(persisted?.status).toBe('blocked');
  });

  it('a command routine with neither field runs (home fallback) and stamps resolvedCwd', async () => {
    const cfg = commandConfig('cmd-home', 'exit 0');
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    const final = await waitTerminal(cfg.name, meta.runId);
    expect(final.status).toBe('completed');
    expect(final.resolvedCwd).toBe('~');
    expect(final.triggerKind).toBe('manual');
  });

  it('a wrong-device request persists a skipped attempt before returning', async () => {
    const cfg = commandConfig('wrong-owner-attempt', 'exit 0');
    cfg.devices = ['definitely-another-device'];
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('skipped');
    expect(meta.skipReason).toBe('wrong_owner');
    expect(meta.pid).toBeNull();
    expect(readRunMeta(cfg.name, meta.runId)?.skipReason).toBe('wrong_owner');
  });

  it('an unsupported placement persists a blocked attempt before returning', async () => {
    const cfg = commandConfig('unsupported-placement-attempt', 'exit 0');
    cfg.host = 'some-host';
    const meta = await executeJobDetached(cfg, undefined, { kind: 'manual' });
    expect(meta.status).toBe('blocked');
    expect(meta.readiness?.code).toBe('placement_unsupported');
    expect(meta.pid).toBeNull();
    expect(readRunMeta(cfg.name, meta.runId)?.status).toBe('blocked');
  });
});
