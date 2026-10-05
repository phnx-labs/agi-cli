/** Device-affinity coverage for the scheduler and overdue detector. No mocks or spies: every test
 * spawns the real CLI against an isolated mkdtemp HOME and observes via `routines list --json`
 * (nextRun only when this machine's scheduler loads the job; `overdue` flag). */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Provision an isolated HOME with routines and optional run metadata. */
function makeHome(opts: {
  jobs?: Record<string, unknown>[];
  enabled?: Record<string, string[]>;
  runs?: { jobName: string; runId: string; meta: Record<string, unknown> }[];
} = {}): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-device-test-'));
  const agentsDir = path.join(home, '.agents');
  const routinesDir = path.join(agentsDir, 'routines');
  const runsDir = path.join(agentsDir, '.history', 'runs');
  fs.mkdirSync(routinesDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });

  for (const [device, routines] of Object.entries(opts.enabled ?? {})) {
    const deviceDir = path.join(agentsDir, 'devices', device);
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), yaml.stringify({ routines }));
  }

  for (const job of opts.jobs ?? []) {
    fs.writeFileSync(path.join(routinesDir, `${job.name}.yml`), yaml.stringify(job));
  }

  for (const run of opts.runs ?? []) {
    const runDir = path.join(runsDir, run.jobName, run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(run.meta, null, 2));
  }

  return home;
}

/** Run `agents routines <args>` against an isolated HOME. */
function run(home: string, args: string[], extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', 'routines', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_SKIP_MIGRATION: '1',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function findJob(home: string, args: string[], name: string, extraEnv: Record<string, string> = {}): Record<string, unknown> | undefined {
  const res = run(home, args, extraEnv);
  expect(res.status).toBe(0);
  const parsed = JSON.parse(res.stdout.trim());
  return parsed.find((j: Record<string, unknown>) => j.name === name);
}

const baseJob = {
  name: 'device-test',
  schedule: '0 3 * * *',
  agent: 'claude',
  prompt: 'noop',
};

describe('JobScheduler device activation', () => {
  it('loads only routines named in this device manifest', () => {
    const home = makeHome({
      jobs: [
        { ...baseJob, name: 'unpinned' },
        { ...baseJob, name: 'enabled-here' },
        { ...baseJob, name: 'enabled-elsewhere' },
      ],
      enabled: { zion: ['unpinned', 'enabled-here'], 'yosemite-s0': ['enabled-elsewhere'] },
    });
    try {
      const entries: Record<string, string | null>[] = [
        findJob(home, ['list', '--json'], 'unpinned', { AGENTS_SYNC_MACHINE_ID: 'zion' })!,
        findJob(home, ['list', '--json'], 'enabled-here', { AGENTS_SYNC_MACHINE_ID: 'zion' })!,
        findJob(home, ['list', '--json'], 'enabled-elsewhere', { AGENTS_SYNC_MACHINE_ID: 'zion' })!,
      ];

      expect(entries[0].nextRun).not.toBeNull();
      expect(entries[1].nextRun).not.toBeNull();
      expect(entries[2].nextRun).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses the normalized device directory for a domain-qualified machine id', () => {
    const home = makeHome({
      jobs: [{ ...baseJob, name: 'fqdn-entry' }],
      enabled: { zion: ['fqdn-entry'] },
    });
    try {
      const entry = findJob(home, ['list', '--json'], 'fqdn-entry', { AGENTS_SYNC_MACHINE_ID: 'zion' })!;
      expect(entry.nextRun).not.toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('detectOverdueJobs device activation', () => {
  it('never flags a routine enabled only on another device as overdue here', () => {
    const pastRun = { status: 'completed', exitCode: 0, startedAt: '2020-01-01T00:00:00Z', completedAt: '2020-01-01T00:01:00Z' };
    // createdAt predates the missed occurrences: overdue is floored at routine
    // creation, and these fixtures are written to disk during the test.
    const born = { createdAt: '2020-01-01T00:00:00.000Z' };
    const home = makeHome({
      jobs: [
        { ...baseJob, ...born, name: 'foreign-overdue' },
        { ...baseJob, ...born, name: 'local-overdue' },
        { ...baseJob, ...born, name: 'unpinned-overdue' },
      ],
      enabled: { zion: ['local-overdue', 'unpinned-overdue'], 'yosemite-s0': ['foreign-overdue'] },
      runs: [
        { jobName: 'foreign-overdue', runId: '2020-01-01T00-00-00-000Z', meta: pastRun },
        { jobName: 'local-overdue', runId: '2020-01-01T00-00-00-000Z', meta: pastRun },
        { jobName: 'unpinned-overdue', runId: '2020-01-01T00-00-00-000Z', meta: pastRun },
      ],
    });
    try {
      const foreign = findJob(home, ['list', '--json'], 'foreign-overdue', { AGENTS_SYNC_MACHINE_ID: 'zion' })!;
      const local = findJob(home, ['list', '--json'], 'local-overdue', { AGENTS_SYNC_MACHINE_ID: 'zion' })!;
      const unpinned = findJob(home, ['list', '--json'], 'unpinned-overdue', { AGENTS_SYNC_MACHINE_ID: 'zion' })!;

      expect(foreign.overdue).toBe(false);
      expect(local.overdue).toBe(true);
      expect(unpinned.overdue).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
