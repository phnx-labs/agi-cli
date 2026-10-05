import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobConfig, RunMeta } from '../src/lib/scheduling/routines.js';

// Keep mock state on globalThis for Vitest hoisting and Bun; local routines reject uncommandable agents while host-placed routines remain allowed.
interface JobsHoistedState { TEST_DIR: string; META: Record<string, unknown> }
const JOBS_HOISTED_KEY = '__agents_cli_jobs_test_state__';
const hoistedState: JobsHoistedState =
  ((globalThis as Record<string, unknown>)[JOBS_HOISTED_KEY] as JobsHoistedState | undefined)
  ?? (((globalThis as Record<string, unknown>)[JOBS_HOISTED_KEY] = { TEST_DIR: '', META: {} }) as JobsHoistedState);

vi.mock('../src/lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/state.js')>();
  const nodePath = require('node:path') as typeof import('path');
  const gt = globalThis as Record<string, unknown>;
  if (!gt.__agents_cli_jobs_test_state__) {
    gt.__agents_cli_jobs_test_state__ = { TEST_DIR: '', META: {} };
  }
  const state = () => gt.__agents_cli_jobs_test_state__ as JobsHoistedState;
  return {
    ...actual,
    getRoutinesDir: () => nodePath.join(state().TEST_DIR, 'routines'),
    getSystemRoutinesDir: () => nodePath.join(state().TEST_DIR, '.system', 'routines'),
    getRunsDir: () => nodePath.join(state().TEST_DIR, 'runs'),
    getUserAgentsDir: () => state().TEST_DIR,
    getCliVersionCachePath: () => nodePath.join(state().TEST_DIR, '.cli-version-cache.json'),
    ensureAgentsDir: () => {},
    readMeta: () => state().META,
    updateMeta: (mutate: (meta: Record<string, unknown>) => Record<string, unknown>) => {
      state().META = mutate(state().META);
    },
  };
});

import {
  validateJob,
  parseTimeout,
  resolveJobPrompt,
  writeJob,
  readJob,
  listJobs,
  deleteJob,
  setJobEnabled,
  writeRunMeta,
  readRunMeta,
  listRuns,
  getLatestRun,
  discoverJobsFromRepo,
  jobExists,
  getRunDir,
} from '../src/lib/scheduling/routines.js';
import { getRoutinesDir, getRunsDir } from '../src/lib/state.js';
import { ROUTINE_AGENT_IDS } from '../src/lib/agents.js';

const PREFIX = '_test_jobs_';

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: `${PREFIX}default`,
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'medium',
    timeout: '30m',
    enabled: true,
    prompt: 'do something',
    ...overrides,
  };
}

beforeEach(() => {
  hoistedState.TEST_DIR = mkdtempSync(join(tmpdir(), 'agents-cli-jobs-'));
  hoistedState.META = {};
  mkdirSync(join(hoistedState.TEST_DIR, 'routines'), { recursive: true });
  mkdirSync(join(hoistedState.TEST_DIR, 'runs'), { recursive: true });
});

afterEach(() => {
  rmSync(hoistedState.TEST_DIR, { recursive: true, force: true });
});

describe('validateJob', () => {
  it('returns no errors for valid config', () => {
    const config = makeConfig();
    expect(validateJob(config)).toEqual([]);
  });

  it('requires name', () => {
    const errors = validateJob({ schedule: '* * * * *', agent: 'claude', prompt: 'hi' });
    expect(errors).toContain('name is required');
  });

  it('requires schedule', () => {
    const errors = validateJob({ name: 'test', agent: 'claude', prompt: 'hi' });
    expect(errors).toContain('schedule (cron expression) or trigger is required');
  });

  it('requires agent, workflow, or command', () => {
    const errors = validateJob({ name: 'test', schedule: '* * * * *', prompt: 'hi' });
    expect(errors).toContain('exactly one of agent, workflow, or command is required');
  });

  it('requires prompt', () => {
    const errors = validateJob({ name: 'test', schedule: '* * * * *', agent: 'claude' });
    expect(errors).toContain('prompt is required');
  });

  it('rejects invalid agent', () => {
    const errors = validateJob({
      name: 'test',
      schedule: '* * * * *',
      agent: 'invalid' as any,
      prompt: 'hi',
    });
    expect(errors.some((e) => e.includes('agent must be one of'))).toBe(true);
  });

  it('rejects invalid mode', () => {
    const errors = validateJob({ ...makeConfig(), mode: 'yolo' as any });
    expect(errors).toContain("mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
  });

  it("accepts 'skip' (canonical) and 'full' (legacy alias) and 'auto'", () => {
    for (const m of ['plan', 'edit', 'auto', 'skip', 'full'] as const) {
      const errors = validateJob({ ...makeConfig(), mode: m });
      expect(errors).not.toContain("mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
    }
  });

  it('rejects invalid effort', () => {
    const errors = validateJob({ ...makeConfig(), effort: 'ultra' as any });
    expect(errors).toContain('effort must be low, medium, high, xhigh, max, or auto');
  });

  it('rejects invalid timeout', () => {
    const errors = validateJob({ ...makeConfig(), timeout: 'forever' });
    expect(errors).toContain('timeout must be like 10m, 2h, 3d, 1w (max 1w)');
  });

  it('accepts every agent the local routine daemon can fire', () => {
    for (const agent of ROUTINE_AGENT_IDS) {
      const errors = validateJob({ ...makeConfig(), agent: agent as any });
      expect(errors).toEqual([]);
    }
  });

  it('rejects invalid agents', () => {
    const errors = validateJob({ ...makeConfig(), agent: 'invalid-agent' as any });
    expect(errors.some((e) => e.includes('agent must be one of'))).toBe(true);
  });

  it('rejects a real agent the local daemon cannot fire, at add time', () => {
    const errors = validateJob({ ...makeConfig(), agent: 'opencode' as any });
    expect(errors.some((e) => e.includes("agent 'opencode' is not supported by the local routine daemon"))).toBe(true);
  });

  it('does not restrict opencode when the routine is placed on a host', () => {
    const errors = validateJob({ ...makeConfig(), agent: 'opencode' as any, host: 'gpu-box', devices: ['self'] });
    expect(errors.some((e) => e.includes('not supported by the local routine daemon'))).toBe(false);
  });
});

describe('parseTimeout', () => {
  it('parses minutes', () => {
    expect(parseTimeout('30m')).toBe(30 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseTimeout('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('parses hours and minutes', () => {
    expect(parseTimeout('1h30m')).toBe(90 * 60 * 1000);
  });

  it('returns null for invalid format', () => {
    expect(parseTimeout('forever')).toBeNull();
    expect(parseTimeout('30s')).toBeNull();
    expect(parseTimeout('')).toBeNull();
  });

  it('returns null for zero', () => {
    expect(parseTimeout('0m')).toBeNull();
    expect(parseTimeout('0h')).toBeNull();
  });
});

describe('resolveJobPrompt', () => {
  it('replaces {job_name}', () => {
    const config = makeConfig({ prompt: 'Running {job_name}' });
    const result = resolveJobPrompt(config);
    expect(result).toBe(`Running ${PREFIX}default`);
  });

  it('replaces {date} with ISO date', () => {
    const config = makeConfig({ prompt: 'Today is {date}' });
    const result = resolveJobPrompt(config);
    expect(result).toMatch(/Today is \d{4}-\d{2}-\d{2}/);
  });

  it('replaces {day} with weekday name', () => {
    const config = makeConfig({ prompt: 'It is {day}' });
    const result = resolveJobPrompt(config);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = days[new Date().getDay()];
    expect(result).toBe(`It is ${today}`);
  });

  it('replaces {time} with time string', () => {
    const config = makeConfig({ prompt: 'Time: {time}' });
    const result = resolveJobPrompt(config);
    expect(result).toMatch(/Time: \d{2}:\d{2}:\d{2}/);
  });

  it('replaces {last_report} with fallback when no runs exist', () => {
    const config = makeConfig({ prompt: 'Last: {last_report}' });
    const result = resolveJobPrompt(config);
    expect(result).toBe('Last: (no previous report)');
  });

  it('handles multiple replacements', () => {
    const config = makeConfig({ prompt: '{job_name} on {date}' });
    const result = resolveJobPrompt(config);
    expect(result).toMatch(new RegExp(`${PREFIX}default on \\d{4}-\\d{2}-\\d{2}`));
  });
});

describe('job CRUD', () => {
  it('writes and reads a job', () => {
    const config = makeConfig({ name: `${PREFIX}crud-rw` });
    writeJob(config);
    const read = readJob(`${PREFIX}crud-rw`);
    expect(read).not.toBeNull();
    expect(read!.name).toBe(`${PREFIX}crud-rw`);
    expect(read!.agent).toBe('claude');
    expect(read!.prompt).toBe('do something');
  });

  it('lists jobs including test jobs', () => {
    writeJob(makeConfig({ name: `${PREFIX}list-a` }));
    writeJob(makeConfig({ name: `${PREFIX}list-b` }));
    const jobs = listJobs();
    const testJobs = jobs.filter((j) => j.name.startsWith(PREFIX + 'list-'));
    const names = testJobs.map((j) => j.name).sort();
    expect(names).toEqual([`${PREFIX}list-a`, `${PREFIX}list-b`]);
  });

  it('returns null for nonexistent job', () => {
    expect(readJob(`${PREFIX}nonexistent`)).toBeNull();
  });

  it('deletes a job', () => {
    writeJob(makeConfig({ name: `${PREFIX}crud-del` }));
    expect(deleteJob(`${PREFIX}crud-del`)).toBe(true);
    expect(readJob(`${PREFIX}crud-del`)).toBeNull();
  });

  it('returns false deleting nonexistent job', () => {
    expect(deleteJob(`${PREFIX}nope`)).toBe(false);
  });

  it('applies defaults for omitted fields', () => {
    writeJob({
      name: `${PREFIX}crud-defaults`,
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'do something',
    } as JobConfig);
    const job = readJob(`${PREFIX}crud-defaults`)!;
    expect(job.mode).toBe('auto');
    expect(job.effort).toBe('auto');
    expect(job.timeout).toBe('10m');
    expect(job.enabled).toBe(false);
  });

  it('preserves config and version fields', () => {
    writeJob(makeConfig({
      name: `${PREFIX}crud-cfg`,
      config: { model: 'claude-sonnet-4-5' },
      version: '1.0.23',
    }));
    const job = readJob(`${PREFIX}crud-cfg`)!;
    expect(job.config).toEqual({ model: 'claude-sonnet-4-5' });
    expect(job.version).toBe('1.0.23');
  });

  it('preserves allow block', () => {
    const allow = { tools: ['web_search'], sites: ['reddit.com'], dirs: ['~/reports'] };
    writeJob(makeConfig({ name: `${PREFIX}crud-allow`, allow }));
    const job = readJob(`${PREFIX}crud-allow`)!;
    expect(job.allow).toEqual(allow);
  });
});

describe('setJobEnabled', () => {
  it('enables a disabled job', () => {
    writeJob(makeConfig({ name: `${PREFIX}en-dis`, enabled: false }));
    setJobEnabled(`${PREFIX}en-dis`, true);
    expect(readJob(`${PREFIX}en-dis`)!.enabled).toBe(true);
  });

  it('disables an enabled job', () => {
    writeJob(makeConfig({ name: `${PREFIX}dis-en`, enabled: true }));
    setJobEnabled(`${PREFIX}dis-en`, false);
    expect(readJob(`${PREFIX}dis-en`)!.enabled).toBe(false);
  });

  it('throws for nonexistent job', () => {
    expect(() => setJobEnabled(`${PREFIX}nope`, true)).toThrow();
  });
});

describe('run metadata', () => {
  it('writes and reads run meta', () => {
    const meta: RunMeta = {
      jobName: `${PREFIX}meta`,
      runId: 'run-001',
      agent: 'claude',
      pid: 12345,
      status: 'running',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: null,
      exitCode: null,
    };
    writeRunMeta(meta);
    const read = readRunMeta(`${PREFIX}meta`, 'run-001');
    expect(read).toEqual(meta);
  });

  it('returns null for nonexistent run', () => {
    expect(readRunMeta(`${PREFIX}nope`, 'nope')).toBeNull();
  });

  it('lists runs in order', () => {
    for (const id of ['run-001', 'run-002', 'run-003']) {
      writeRunMeta({
        jobName: `${PREFIX}runs-list`,
        runId: id,
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T01:00:00.000Z',
        exitCode: 0,
      });
    }
    const runs = listRuns(`${PREFIX}runs-list`);
    expect(runs.map((r) => r.runId)).toEqual(['run-001', 'run-002', 'run-003']);
  });

  it('getLatestRun returns last run', () => {
    writeRunMeta({
      jobName: `${PREFIX}latest`,
      runId: 'run-001',
      agent: 'claude',
      pid: null,
      status: 'completed',
      startedAt: '2025-01-01T00:00:00.000Z',
      completedAt: null,
      exitCode: 0,
    });
    writeRunMeta({
      jobName: `${PREFIX}latest`,
      runId: 'run-002',
      agent: 'claude',
      pid: null,
      status: 'failed',
      startedAt: '2025-01-02T00:00:00.000Z',
      completedAt: null,
      exitCode: 1,
    });
    const latest = getLatestRun(`${PREFIX}latest`);
    expect(latest!.runId).toBe('run-002');
    expect(latest!.status).toBe('failed');
  });

  it('getLatestRun returns null with no runs', () => {
    expect(getLatestRun(`${PREFIX}no-runs`)).toBeNull();
  });
});

describe('discoverJobsFromRepo', () => {
  const repoDir = join(tmpdir(), 'agents-cli-discover-test');

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('discovers yaml files in routines/ directory', () => {
    const routinesDir = join(repoDir, 'routines');
    mkdirSync(routinesDir, { recursive: true });
    writeFileSync(join(routinesDir, 'my-job.yml'), 'name: my-job\n');
    writeFileSync(join(routinesDir, 'other.yaml'), 'name: other\n');
    writeFileSync(join(routinesDir, 'readme.md'), 'not a job');

    const discovered = discoverJobsFromRepo(repoDir);
    const names = discovered.map((d) => d.name).sort();
    expect(names).toEqual(['my-job', 'other']);
  });

  it('returns empty array for repo without routines/', () => {
    mkdirSync(repoDir, { recursive: true });
    expect(discoverJobsFromRepo(repoDir)).toEqual([]);
  });
});

describe('jobExists', () => {
  it('returns true for existing job', () => {
    writeJob(makeConfig({ name: `${PREFIX}exists` }));
    expect(jobExists(`${PREFIX}exists`)).toBe(true);
  });

  it('returns false for nonexistent job', () => {
    expect(jobExists(`${PREFIX}nope-exists`)).toBe(false);
  });
});
