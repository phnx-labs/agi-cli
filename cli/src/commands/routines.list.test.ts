import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  describeRoutines,
  makeHome,
  run,
  baseJob,
  registry,
  writeRunMeta,
  writeProject,
  projectsEnv,
} from './routines.test-fixture.js';

// `routines list`/`runs` output-surface slice of the routines.*.test.ts suite
// (RUSH-2819) — split off the original 2,249-line routines.test.ts (measured
// ~194s of test time) so vitest can parallelize the file across worker
// forks. Shared fixtures: routines.test-fixture.ts.

describeRoutines('routines list --json has devices+runsHere, no device', () => {
  it('includes devices array and runsHere, excludes singular device key', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0']);
      expect(typeof entry.runsHere).toBe('boolean');
      expect(entry.runsHere).toBe(true);
      expect('device' in entry).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('honors user-layer devices when a repo-bound project routine shadows the same name', () => {
    const userJob = {
      ...baseJob,
      repo: 'phnx-labs/agents-cli',
      devices: ['zion'],
      prompt: 'user noop',
    };
    const projectJob = {
      ...baseJob,
      repo: 'phnx-labs/agents-cli',
      prompt: 'project noop',
    };
    const home = makeHome({
      jobs: [userJob],
      projectJobs: [projectJob],
      registry,
      deviceRoutines: { zion: ['test-job'], 'yosemite-s0': [] },
    });
    const projectDir = path.join(home, 'project');
    try {
      const remoteRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' }, projectDir);
      expect(remoteRes.status).toBe(0);
      const remoteParsed = JSON.parse(remoteRes.stdout.trim());
      const remoteEntry = remoteParsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(remoteEntry).toBeDefined();
      expect(remoteEntry.repo).toBe('phnx-labs/agents-cli');
      expect(remoteEntry.devices).toEqual(['zion']);
      expect(remoteEntry.runsHere).toBe(false);
      expect(remoteEntry.nextRun).toBeNull();

      const localRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'zion' }, projectDir);
      expect(localRes.status).toBe(0);
      const localParsed = JSON.parse(localRes.stdout.trim());
      const localEntry = localParsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(localEntry).toBeDefined();
      expect(localEntry.devices).toEqual(['zion']);
      expect(localEntry.runsHere).toBe(true);
      expect(localEntry.nextRun).not.toBeNull();

      const viewRes = run(home, ['view', 'test-job'], { AGENTS_SYNC_MACHINE_ID: 'zion' }, projectDir);
      expect(viewRes.status).toBe(0);
      // Strip ANSI (FORCE_COLOR / chalk.bold on the Job: header) before YAML parse.
      const viewPlain = viewRes.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const viewDoc = yaml.parse(viewPlain.replace(/^Job: test-job\s*/m, ''));
      expect(viewDoc.prompt).toBe('project noop');
      expect(viewDoc.devices).toEqual(['zion']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('shows empty devices array and runsHere=true when unrestricted', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual([]);
      expect(entry.runsHere).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('includes latest run exitCode and failureReason', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:00:05.000Z',
        exitCode: 2,
        errorMessage: 'command exited with code 2',
      });

      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.exitCode).toBe(2);
      expect(entry.failureReason).toBe('command exited with code 2');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('can report overdue independently of a completed zero-exit latest run', () => {
    const home = makeHome({
      // createdAt predates the run below, so the routine is old enough for a
      // missed occurrence to count (overdue is floored at routine creation).
      jobs: [{ ...baseJob, schedule: '* * * * *', createdAt: '2026-07-01T00:00:00.000Z' }],
      registry,
    });
    try {
      writeRunMeta(home, 'test-job', '2026-07-20T03-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-20T03-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-20T03:00:00.000Z',
        completedAt: '2026-07-20T03:00:05.000Z',
        exitCode: 0,
      });

      const res = run(home, ['list', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'test-job');
      expect(entry).toBeDefined();
      expect(entry.overdue).toBe(true);
      expect(entry.lastStatus).toBe('completed');
      expect(entry.exitCode).toBe(0);
      expect(entry.failureReason).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // A routine re-pinned to other devices leaves its old run records behind on
  // the machine that used to fire it. Reporting those as the routine's status
  // painted a peer's healthy routine red in `list` and in the menu bar (which
  // reads this JSON) — the record describes this device, not the owner.
  it('reports no status for a routine pinned away from this device', () => {
    const home = makeHome({
      jobs: [
        { ...baseJob, name: 'pinned-elsewhere', devices: ['yosemite-s0'] },
        { ...baseJob, name: 'pinned-here', devices: ['zion'] },
      ],
      registry,
    });
    try {
      for (const name of ['pinned-elsewhere', 'pinned-here']) {
        writeRunMeta(home, name, '2026-07-25T10-00-00-000Z', {
          jobName: name,
          runId: '2026-07-25T10-00-00-000Z',
          agent: 'claude',
          pid: null,
          status: 'failed',
          startedAt: '2026-07-25T10:00:00.000Z',
          completedAt: '2026-07-25T10:00:05.000Z',
          exitCode: 1,
          errorMessage: 'command exited with code 1',
        });
      }

      const res = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());

      const elsewhere = parsed.find((j: Record<string, unknown>) => j.name === 'pinned-elsewhere');
      expect(elsewhere.runsHere).toBe(false);
      expect(elsewhere.lastStatus).toBeNull();
      expect(elsewhere.exitCode).toBeNull();
      expect(elsewhere.failureReason).toBeNull();
      expect(elsewhere.lastRunStartedAt).toBeNull();
      expect(elsewhere.lastRunCompletedAt).toBeNull();

      // The same record on a routine this device does fire is still reported.
      const here = parsed.find((j: Record<string, unknown>) => j.name === 'pinned-here');
      expect(here.runsHere).toBe(true);
      expect(here.lastStatus).toBe('failed');
      expect(here.exitCode).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines runs --json', () => {
  it('emits run ids and statuses for the requested routine', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      writeRunMeta(home, 'test-job', '2026-07-21T10-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'completed',
        startedAt: '2026-07-21T10:00:00.000Z',
        completedAt: '2026-07-21T10:00:05.000Z',
        exitCode: 0,
      });
      writeRunMeta(home, 'test-job', '2026-07-21T11-00-00-000Z', {
        jobName: 'test-job',
        runId: '2026-07-21T11-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-21T11:00:00.000Z',
        completedAt: '2026-07-21T11:00:05.000Z',
        exitCode: 1,
        errorMessage: 'command exited with code 1',
      });

      const res = run(home, ['runs', 'test-job', '--json']);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.jobId).toBe('test-job');
      expect(parsed.runs).toHaveLength(2);
      expect(parsed.runs[0]).toMatchObject({
        jobId: 'test-job',
        runId: '2026-07-21T10-00-00-000Z',
        status: 'completed',
        exitCode: 0,
      });
      expect(parsed.runs[1]).toMatchObject({
        jobId: 'test-job',
        runId: '2026-07-21T11-00-00-000Z',
        status: 'failed',
        exitCode: 1,
        errorMessage: 'command exited with code 1',
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list table has Devices column with bounded ellipsis', () => {
  it('table header includes Devices', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Devices');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('long device lists are ellipsized in the table', () => {
    const job = { ...baseJob, devices: ['yosemite-s0', 'yosemite-s1', 'mac-mini', 'zion'] };
    const home = makeHome({
      jobs: [job],
      registry,
      deviceRoutines: {
        'yosemite-s0': ['test-job'],
        'yosemite-s1': ['test-job'],
        'mac-mini': ['test-job'],
        zion: ['test-job'],
      },
    });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n').filter((l) => l.includes('test-job'));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toMatch(/…/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('renders unrestricted routines with Devices set to "all"', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n');
      const line = lines.find((l) => l.includes('test-job'));
      expect(line).toBeDefined();
      const headerLine = lines.find((l) => l.includes('Devices') && l.includes('Schedule'));
      expect(headerLine).toBeDefined();
      const deviceStart = headerLine!.indexOf('Devices');
      const scheduleStart = headerLine!.indexOf('Schedule');
      expect(deviceStart).toBeGreaterThan(-1);
      expect(scheduleStart).toBeGreaterThan(deviceStart);
      const deviceField = line!.slice(deviceStart, scheduleStart).trim();
      expect(deviceField).toBe('all');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('marks one-shot routines in the schedule column', () => {
    const job = { ...baseJob, schedule: '0 14 31 12 *', runOnce: true };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list', '--flat']);
      expect(res.status).toBe(0);
      expect(res.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('one-shot');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list grouped by device', () => {
  it('groups by fleet, current device, pinned devices, hosts, cloud, and offline registry state', () => {
    const jobs = [
      { ...baseJob, name: 'all-local' },
      { ...baseJob, name: 'zion-local', devices: ['zion'] },
      { ...baseJob, name: 's0-local', devices: ['yosemite-s0'] },
      { ...baseJob, name: 'fleet-placed', hostStrategy: 'fleet', devices: ['zion'] },
      { ...baseJob, name: 'cloud-placed', hostStrategy: 'cloud', devices: ['zion'] },
      { ...baseJob, name: 'host-placed', hostStrategy: 'host', host: 'mac-mini', devices: ['zion'] },
      { ...baseJob, name: 'offline-local', devices: ['offline-box'] },
    ];
    const groupedRegistry = {
      ...registry,
      'mac-mini': { ...registry['mac-mini'], tailscale: { online: false, direct: false } },
      'offline-box': { name: 'offline-box', platform: 'linux', tailscale: { online: false, direct: false } },
    };
    const home = makeHome({
      jobs,
      registry: groupedRegistry,
      deviceRoutines: {
        zion: ['zion-local', 'fleet-placed', 'cloud-placed', 'host-placed'],
        'yosemite-s0': ['s0-local'],
        'offline-box': ['offline-local'],
      },
    });
    try {
      const res = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('This machine (zion)');
      expect(stripped).toContain('Fleet-wide');
      expect(stripped).toContain('Cloud');
      expect(stripped).toContain('Device: yosemite-s0');
      expect(stripped).toContain('Device: offline-box (offline)');
      expect(stripped).toContain('Host: mac-mini (offline)');
      for (const job of jobs) expect(stripped).toContain(job.name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  // One routine pinned to two devices renders a row under each. Only the row
  // under THIS machine may carry Last Status — the peer's row previously
  // repeated our local record, which is how a green routine showed up red.
  it('shows Last Status only under this machine, not under a peer device', () => {
    const home = makeHome({
      // Deliberately a two-device pin: the point here is that the listing still
      // renders a row under EACH device group, and only the This-machine row
      // carries a status. (Ownership means only zion fires it; the peer row
      // existing is what this test is about.)
      // zion must be the OWNER (lowest normalized name) so its row carries a
      // status, while a second device still renders a peer group — that peer
      // row having no status is what this test asserts.
      jobs: [{ ...baseJob, name: 'two-device-job' }],
      registry: { ...registry, 'zulu-box': { name: 'zulu-box', platform: 'linux' } },
      deviceRoutines: { zion: ['two-device-job'], 'zulu-box': ['two-device-job'] },
    });
    try {
      writeRunMeta(home, 'two-device-job', '2026-07-25T10-00-00-000Z', {
        jobName: 'two-device-job',
        runId: '2026-07-25T10-00-00-000Z',
        agent: 'claude',
        pid: null,
        status: 'failed',
        startedAt: '2026-07-25T10:00:00.000Z',
        completedAt: '2026-07-25T10:00:05.000Z',
        exitCode: 1,
      });

      const res = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      const stripped = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');

      const lines = stripped.split('\n');
      const mineIdx = lines.findIndex((l) => l.includes('This machine (zion)'));
      const peerIdx = lines.findIndex((l) => l.includes('Device: zulu-box'));
      expect(mineIdx).toBeGreaterThanOrEqual(0);
      expect(peerIdx).toBeGreaterThanOrEqual(0);

      const rowAfter = (start: number): string =>
        lines.slice(start).find((l) => l.includes('two-device-job')) ?? '';
      expect(rowAfter(mineIdx)).toContain('failed');
      expect(rowAfter(peerIdx)).not.toContain('failed');
      expect(stripped).toContain('Last Status is per-device');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults to project grouping; --group-by device restores device view; --flat disables grouping', () => {
    const home = makeHome({ jobs: [baseJob], registry, deviceRoutines: { zion: ['test-job'] } });
    try {
      const byProject = run(home, ['list'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      const byDevice = run(home, ['list', '--group-by', 'device'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      const flat = run(home, ['list', '--flat'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(byProject.status).toBe(0);
      expect(byDevice.status).toBe(0);
      expect(flat.status).toBe(0);
      // Default (project): job has no projects, lands in Operations section
      expect(byProject.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('Operations');
      expect(byProject.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('This machine (zion)');
      // Explicit device grouping: shows device sections
      expect(byDevice.stdout.replace(/\x1b\[[0-9;]*m/g, '')).toContain('This machine (zion)');
      // Flat: no section headers
      expect(flat.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('This machine (zion)');
      expect(flat.stdout.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('Operations');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --device self runs locally', () => {
  it('exits 0 and lists when --device matches AGENTS_SYNC_MACHINE_ID', () => {
    const job = { ...baseJob, devices: ['zion'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const res = run(home, ['list', '--device', 'zion'], { AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines --help documents --device', () => {
  it('help output contains --device', () => {
    const home = makeHome();
    try {
      const res = run(home, ['--help']);
      const output = res.stdout + res.stderr;
      expect(output).toContain('--device');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --help documents --device once', () => {
  it('lists the routing flag exactly once', () => {
    const home = makeHome();
    try {
      const res = run(home, ['list', '--help']);
      expect(res.status).toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toContain('--device');
      const deviceMatches = output.match(/^\s+-D, --device /gm) ?? [];
      expect(deviceMatches.length).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines list --json projects and projectGroup fields', () => {
  it('includes projects and projectGroup in the JSON payload', () => {
    const jobWithProject = { ...baseJob, name: 'tagged-job', projects: ['myapp'] };
    const jobNoProject = { ...baseJob, name: 'untagged-job' };
    const home = makeHome({
      jobs: [jobWithProject, jobNoProject],
      registry,
      deviceRoutines: { zion: ['tagged-job', 'untagged-job'] },
    });
    writeProject(home, 'myapp');
    try {
      const res = run(home, ['list', '--json'], {
        ...projectsEnv(home),
        AGENTS_SYNC_MACHINE_ID: 'zion',
      });
      expect(res.status, res.stderr).toBe(0);
      const payload = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
      const tagged = payload.find((j) => j.name === 'tagged-job');
      const untagged = payload.find((j) => j.name === 'untagged-job');
      expect(tagged).toBeDefined();
      expect(tagged!.projects).toEqual(['myapp']);
      expect(tagged!.projectGroup).toBe('myapp');
      expect(untagged).toBeDefined();
      expect(untagged!.projects).toEqual([]);
      expect(untagged!.projectGroup).toBe('Operations');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports projectGroup as "All projects" for projects: ["*"]', () => {
    const jobAllProjects = { ...baseJob, name: 'all-proj-job', projects: ['*'] };
    const home = makeHome({
      jobs: [jobAllProjects],
      registry,
      deviceRoutines: { zion: ['all-proj-job'] },
    });
    try {
      const res = run(home, ['list', '--json'], {
        ...projectsEnv(home),
        AGENTS_SYNC_MACHINE_ID: 'zion',
      });
      expect(res.status, res.stderr).toBe(0);
      const payload = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
      const entry = payload.find((j) => j.name === 'all-proj-job');
      expect(entry).toBeDefined();
      expect(entry!.projects).toEqual(['*']);
      expect(entry!.projectGroup).toBe('All projects');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
