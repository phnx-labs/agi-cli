import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  describeRoutines,
  makeHome,
  run,
  readRoutineYaml,
  registry,
  readDeviceRoutines,
  isProcessAlive,
  createDaemonHarness,
  writeProject,
  projectsEnv,
} from './routines.test-fixture.js';


const { startIsolatedDaemon, stopIsolatedDaemon, registerLeakDetector, makeDaemonHome } = createDaemonHarness('add');
registerLeakDetector();

describeRoutines('routines add help', () => {
  it('lists exactly the agents backed by the daemon command table', () => {
    const home = makeHome();
    try {
      const result = run(home, ['add', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /Which agent runs this routine: claude, codex,\s+cursor,\s+kimi, droid/,
      );
      expect(result.stdout).not.toMatch(/routine: [^.]*gemini/);
      const agentLine = result.stdout.split('\n').find((line) => line.includes('--agent')) ?? '';
      expect(agentLine).not.toContain('antigravity');
      expect(agentLine).not.toContain('opencode');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --devices unknown is nonzero/no write', () => {
  it('rejects unknown devices and does not create the routine file', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, [
        'add', 'new-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', 'nonexistent-box',
      ]);
      expect(res.status).not.toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'new-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --agent unsupported by the local daemon (RUSH-2102)', () => {
  it('rejects a real agent the daemon cannot fire, at add time, and writes no routine file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'bad-agent-job',
        '--schedule', '0 3 * * *',
        '--agent', 'opencode',
        '--prompt', 'hi',
      ]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("agent 'opencode' is not supported by the local routine daemon");
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'bad-agent-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still accepts a daemon-supported agent for a local routine', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'good-agent-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
      ]);
      expect(res.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'good-agent-job.yml'))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --on aliases', () => {
  it('accepts the pr GitHub alias and writes the canonical trigger event', async () => {
    const home = makeDaemonHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'pr-job',
        '--on', 'pr',
        '--repo', 'phnx-labs/agents-cli',
        '--action', 'labeled',
        '--label', 'ux-approved',
        '--agent', 'claude',
        '--prompt', 'handle pull request',
      ]);
      expect(res.status).toBe(0);

      const doc = readRoutineYaml(home, 'pr-job');
      expect(doc).not.toBeNull();
      expect(doc!.trigger).toEqual({
        type: 'github_event',
        event: 'pull_request',
        repo: 'phnx-labs/agents-cli',
        action: 'labeled',
        label: 'ux-approved',
      });
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --json', () => {
  it('emits only the created routine id and status on stdout', async () => {
    const home = makeDaemonHome({ registry });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'json-job',
        '--schedule', '0 3 * * *',
        '--command', 'printf ok',
        '--json',
      ]);
      expect(res.status).toBe(0);

      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed).toMatchObject({
        jobId: 'json-job',
        name: 'json-job',
        status: 'added',
        enabled: true,
        schedule: '0 3 * * *',
      });
      expect(parsed.trigger).toBeNull();
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
      expect(res.stderr).not.toContain('Scheduler reloaded');

      const doc = readRoutineYaml(home, 'json-job');
      expect(doc).not.toBeNull();
      expect(doc!.command).toBe('printf ok');
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --devices empty/whitespace fails closed', () => {
  it('rejects --devices "" and does not create the routine file', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, [
        'add', 'new-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', '',
      ]);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'new-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --devices "   " and does not create the routine file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'space-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--devices', '   ',
      ]);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'space-job.yml'))).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('successfully persists --devices with valid names against a running daemon', async () => {
    const home = makeDaemonHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    let daemon: ReturnType<typeof startIsolatedDaemon> | undefined;
    let pid: number | null = null;
    try {
      daemon = startIsolatedDaemon(home);
      pid = await daemon.pidPromise;
      expect(pid).not.toBeNull();

      const res = run(home, [
        'add', 'placed-job',
        '--schedule', '0 3 * * *',
        '--agent', 'claude',
        '--prompt', 'hi',
        '--cwd', '~',
        '--devices', 'yosemite-s0',
      ], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);
      const doc = readRoutineYaml(home, 'placed-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toBeUndefined();
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('placed-job');
    } finally {
      if (daemon) await stopIsolatedDaemon(daemon.child);
      if (typeof pid === 'number') expect(isProcessAlive(pid)).toBe(false);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --project persists to YAML', () => {
  it('writes a single project name into the projects field', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes multiple --project values as an array', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    writeProject(home, 'billing');
    try {
      const res = run(home, [
        'add', 'multi-proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
        '--project', 'billing',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'multi-proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp', 'billing']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated project names, preserving first-seen order', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'dedup-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'run tests',
        '--project', 'myapp',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'dedup-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['myapp']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --all-projects', () => {
  it('writes projects: ["*"] to YAML', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'all-proj-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'fleet check',
        '--all-projects',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status, res.stderr).toBe(0);
      const doc = readRoutineYaml(home, 'all-proj-job');
      expect(doc).not.toBeNull();
      expect(doc!.projects).toEqual(['*']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --all-projects combined with --project', () => {
    const home = makeHome({ registry });
    writeProject(home, 'myapp');
    try {
      const res = run(home, [
        'add', 'conflict-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'check',
        '--all-projects',
        '--project', 'myapp',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      expect(readRoutineYaml(home, 'conflict-job')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add --project unknown project rejection', () => {
  it('rejects an unknown project name and does not create the routine file', () => {
    const home = makeHome({ registry });
    try {
      const res = run(home, [
        'add', 'ghost-job',
        '--schedule', '0 9 * * *',
        '--agent', 'claude',
        '--prompt', 'check',
        '--project', 'ghost',
      ], { ...projectsEnv(home), AGENTS_SYNC_MACHINE_ID: 'zion' });
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/Unknown project/i);
      expect(readRoutineYaml(home, 'ghost-job')).toBeNull();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines add — never rewrites the source it was handed', () => {
  const pinned = {
    name: 'release-train',
    schedule: '0 */4 * * *',
    agent: 'claude',
    prompt: 'cut a release',
    cwd: '~',
    devices: ['yosemite-s0'],
  };

  it('leaves a canonical tracked source byte-for-byte identical, devices pin intact', () => {
    const home = makeHome({ jobs: [pinned] });
    const sourcePath = path.join(home, '.agents', 'routines', 'release-train.yml');
    try {
      const before = fs.readFileSync(sourcePath, 'utf-8');
      expect(before).toContain('devices:');

      const added = run(home, ['add', sourcePath]);
      expect(added.status, added.stderr).toBe(0);

      const after = fs.readFileSync(sourcePath, 'utf-8');
      expect(after).toContain('devices:');
      expect(after).toContain('yosemite-s0');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('still copies a definition in when the source lives outside the routines dir', () => {
    const home = makeHome();
    const external = path.join(home, 'authored-elsewhere.yml');
    fs.writeFileSync(external, yaml.stringify({ ...pinned, name: 'imported-train' }));
    try {
      const added = run(home, ['add', external]);
      expect(added.status, added.stderr).toBe(0);
      const canonical = path.join(home, '.agents', 'routines', 'imported-train.yml');
      expect(fs.existsSync(canonical)).toBe(true);
      expect(yaml.parse(fs.readFileSync(external, 'utf-8')).devices).toEqual(['yosemite-s0']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('says a devices: pin is local-only instead of letting it read as fleet-wide', () => {
    const home = makeHome({ jobs: [pinned] });
    try {
      const added = run(home, ['add', path.join(home, '.agents', 'routines', 'release-train.yml')]);
      expect(added.status, added.stderr).toBe(0);
      expect(added.stdout).toContain('not propagated to peers');
      expect(added.stdout).toContain('agents routines devices release-train --set yosemite-s0');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
