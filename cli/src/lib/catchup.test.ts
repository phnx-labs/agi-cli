import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';

let home: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeRoutine(job: Record<string, unknown>): void {
  const dir = path.join(home, '.agents', 'routines');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${job.name}.yml`), yaml.stringify(job));
}

function writeRun(jobName: string, startedAt: string): void {
  const runId = startedAt.replace(/[:.]/g, '-');
  const dir = path.join(home, '.agents', '.history', 'runs', jobName, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      jobName, runId, agent: 'claude', pid: null, status: 'completed',
      startedAt, completedAt: startedAt, exitCode: 0,
    }),
  );
}

function readRuns(jobName: string): Record<string, unknown>[] {
  const dir = path.join(home, '.agents', '.history', 'runs', jobName);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((runId) =>
    JSON.parse(fs.readFileSync(path.join(dir, runId, 'meta.json'), 'utf-8')));
}

beforeEach(() => {
  vi.resetModules();
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-catchup-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('claimMissedFire', () => {
  it('writes a missed run stamped at the time the fire was due', async () => {
    const { claimMissedFire } = await import('./catchup.js');
    const job = {
      name: 'weekly-fleet-retro', schedule: '0 21 * * 0', agent: 'claude' as const,
      mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
    };
    writeRoutine(job);

    const expectedAt = new Date('2026-08-03T04:00:00.000Z');
    const meta = claimMissedFire(job, expectedAt)!;

    expect(meta.status).toBe('missed');
    expect(meta.startedAt).toBe('2026-08-03T04:00:00.000Z');
    expect(meta.pid).toBeNull();
    expect(meta.exitCode).toBeNull();

    const runs = readRuns('weekly-fleet-retro');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('missed');
  });

  it('grants the claim exactly once for the same missed fire', async () => {
    const { claimMissedFire } = await import('./catchup.js');
    const job = {
      name: 'nightly', schedule: '0 2 * * *', agent: 'claude' as const,
      mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
    };
    writeRoutine(job);
    const expectedAt = new Date('2026-08-02T09:00:00.000Z');

    const first = claimMissedFire(job, expectedAt);
    const second = claimMissedFire(job, expectedAt);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(readRuns('nightly')).toHaveLength(1);
  });
});

describe('runCatchup', () => {
  const nightly = {
    name: 'nightly', schedule: '0 2 * * *', timezone: 'UTC', agent: 'claude' as const,
    mode: 'auto' as const, effort: 'auto' as const, timeout: '10m', enabled: true, prompt: 'noop',
    createdAt: '2026-07-25T00:00:00.000Z',
  };
  const now = new Date('2026-08-03T09:00:00.000Z');

  it('records the miss and does not re-run when catchup is false', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine({ ...nightly, catchup: false });
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    const outcomes = await runCatchup({ now });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].name).toBe('nightly');
    expect(outcomes[0].result).toBe('recorded');

    const runs = readRuns('nightly');
    expect(runs.map((r) => r.status)).toEqual(['completed', 'missed']);
  });

  it('stops reporting the same missed fire on a second pass', async () => {
    const { runCatchup } = await import('./catchup.js');
    const { detectOverdueJobs } = await import('./overdue.js');
    writeRoutine({ ...nightly, catchup: false });
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    expect(detectOverdueJobs(now)).toHaveLength(1);
    await runCatchup({ now });

    expect(detectOverdueJobs(now)).toHaveLength(0);
    const second = await runCatchup({ now });
    expect(second).toHaveLength(0);
    expect(readRuns('nightly')).toHaveLength(2);
  });

  it('a concurrent pass over the same overdue set does not double-run', async () => {
    const { runCatchup } = await import('./catchup.js');
    const { detectOverdueJobs } = await import('./overdue.js');
    writeRoutine(nightly);
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    const shared = detectOverdueJobs(now);
    expect(shared).toHaveLength(1);

    const first = await runCatchup({ now, overdue: shared, dryRun: true });
    const second = await runCatchup({ now, overdue: shared, dryRun: true });

    expect(first[0].result).toBe('recorded');
    expect(second[0].result).toBe('claimed-elsewhere');
    expect(readRuns('nightly').map((r) => r.status)).toEqual(['completed', 'missed']);
  });

  it('dry run records the miss without starting a late run', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine(nightly);
    writeRun('nightly', '2026-08-01T02:00:00.000Z');

    const outcomes = await runCatchup({ now, dryRun: true });

    expect(outcomes[0].result).toBe('recorded');
    expect(outcomes[0].runId).toBeUndefined();
    expect(readRuns('nightly').map((r) => r.status)).toEqual(['completed', 'missed']);
  });

  it('leaves a routine that ran on schedule alone', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine(nightly);
    writeRun('nightly', '2026-08-03T02:00:00.000Z');

    expect(await runCatchup({ now })).toHaveLength(0);
    expect(readRuns('nightly').map((r) => r.status)).toEqual(['completed']);
  });
});

describe('a routine is never judged against fires that predate it', () => {
  const now = new Date('2026-08-03T09:00:00.000Z');

  it('a routine created after its last slot is not overdue and is not caught up', async () => {
    const { runCatchup } = await import('./catchup.js');
    const { detectOverdueJobs } = await import('./overdue.js');
    writeRoutine({
      name: 'just-added', schedule: '0 2 * * *', timezone: 'UTC', agent: 'claude',
      mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'noop',
      createdAt: '2026-08-03T08:00:00.000Z',
    });

    expect(detectOverdueJobs(now)).toHaveLength(0);
    expect(await runCatchup({ now })).toHaveLength(0);
    expect(readRuns('just-added')).toHaveLength(0);
  });

  it('still catches up a slot that falls after the routine was created', async () => {
    const { runCatchup } = await import('./catchup.js');
    writeRoutine({
      name: 'older', schedule: '0 2 * * *', timezone: 'UTC', agent: 'claude',
      mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'noop',
      createdAt: '2026-07-30T00:00:00.000Z',
    });

    const outcomes = await runCatchup({ now, dryRun: true });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].name).toBe('older');
    expect(readRuns('older').map((r) => r.status)).toEqual(['missed']);
  });

  it('falls back to the file mtime for a routine written before createdAt existed', async () => {
    const { detectOverdueJobs } = await import('./overdue.js');
    writeRoutine({
      name: 'legacy', schedule: '0 2 * * *', timezone: 'UTC', agent: 'claude',
      mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'noop',
    });
    expect(detectOverdueJobs(now)).toHaveLength(0);
  });
});

describe('shouldCatchUp', () => {
  it('defaults to true so a scheduled routine is never silently skipped', async () => {
    const { shouldCatchUp } = await import('./catchup.js');
    expect(shouldCatchUp({})).toBe(true);
    expect(shouldCatchUp({ catchup: undefined })).toBe(true);
    expect(shouldCatchUp({ catchup: true })).toBe(true);
    expect(shouldCatchUp({ catchup: false })).toBe(false);
  });
});
