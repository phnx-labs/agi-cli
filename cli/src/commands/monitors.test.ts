import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-monitors-test-'));
  const agentsDir = path.join(home, '.agents');
  fs.mkdirSync(path.join(agentsDir, 'monitors'), { recursive: true });
  fs.mkdirSync(path.join(agentsDir, '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'agents.yaml'), 'agents: {}\n');
  return home;
}

function writeMonitor(home: string, monitor: Record<string, unknown>): void {
  const monitorsDir = path.join(home, '.agents', 'monitors');
  fs.writeFileSync(path.join(monitorsDir, `${monitor.name}.yml`), yaml.stringify(monitor));
}

function writeState(home: string, name: string): void {
  const dir = path.join(home, '.agents', '.history', 'monitors', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      monitorName: name,
      lastHash: 'hash',
      lastValue: 'previous build output',
      lastSeenAt: '2026-07-21T12:00:00.000Z',
      lastFiredAt: '2026-07-21T12:01:00.000Z',
    }),
  );
}

function writeFire(home: string, name: string): void {
  const dir = path.join(home, '.agents', '.history', 'monitors', name, 'fires', '2026-07-21T12-01-00-000Z');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'event.json'),
    JSON.stringify({
      monitorName: name,
      firedAt: '2026-07-21T12:01:00.000Z',
      summary: 'build failed',
      payload: { exitCode: 1 },
      action: 'notify',
      ok: true,
    }),
  );
}

function statePath(home: string, name: string): string {
  return path.join(home, '.agents', '.history', 'monitors', name, 'state.json');
}

function writeSystemMonitor(home: string, monitor: Record<string, unknown>): void {
  const dir = path.join(home, '.agents', '.system', 'monitors');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${monitor.name}.yml`), yaml.stringify(monitor));
}

function run(home: string, args: string[], extraEnv: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'monitors', ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      USERPROFILE: home,
      PATH: process.platform === 'win32' ? (process.env.PATH ?? '') : '/usr/local/bin:/usr/bin:/bin',
      AGENTS_SKIP_MIGRATION: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('monitors inspection JSON and stderr', () => {
  it('view --json prints config, state, and recent fires as clean JSON on stdout', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: { type: 'poll', command: 'echo fail', interval: '30s' },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });
    writeState(home, 'ci');
    writeFire(home, 'ci');

    const res = run(home, ['view', 'ci', '--json']);

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).not.toContain('Monitor:');
    const payload = JSON.parse(res.stdout);
    expect(payload.name).toBe('ci');
    expect(payload.monitor.source.command).toBe('echo fail');
    expect(payload.state.lastValue).toBe('previous build output');
    expect(payload.recentFires).toHaveLength(1);
    expect(payload.recentFires[0].summary).toBe('build failed');
  });

  it('list --json reconciles a detached action that failed after the fire was recorded', () => {
    const home = makeHome();
    const name = 'failed-action';
    const runId = '2026-07-21T12-01-00-000Z';
    writeMonitor(home, {
      name,
      enabled: true,
      source: { type: 'poll', command: 'echo fail', interval: '30s' },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'run', agent: 'claude', prompt: 'investigate' },
    });
    writeState(home, name);
    const fireDir = path.join(home, '.agents', '.history', 'monitors', name, 'fires', runId);
    fs.mkdirSync(fireDir, { recursive: true });
    fs.writeFileSync(path.join(fireDir, 'event.json'), JSON.stringify({
      monitorName: name, firedAt: '2026-07-21T12:01:00.000Z', summary: 'fail', action: 'run', ok: true, runId,
    }));
    const runDir = path.join(home, '.agents', '.history', 'runs', name, runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
      jobName: name, runId, agent: 'claude', status: 'failed', exitCode: 1,
      startedAt: '2026-07-21T12:01:00.000Z', completedAt: '2026-07-21T12:01:01.000Z', pid: null,
    }));

    const payload = JSON.parse(run(home, ['list', '--json']).stdout);
    expect(payload[0].lastActionStatus).toBe('failed');
    expect(payload[0].lastActionFailed).toBe(true);
  });

  it('a system built-in is visible, enabled, and tagged (built-in) — PHNX-2506 items 1+2', () => {
    const home = makeHome();
    writeSystemMonitor(home, {
      name: 'pr-merge-on-green',
      source: { type: 'poll', command: 'gh pr list --author @me', interval: '2m' },
      condition: { mode: 'on-change' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    const jsonRes = run(home, ['list', '--json', '--local']);
    expect(jsonRes.status).toBe(0);
    const payload = JSON.parse(jsonRes.stdout);
    const row = payload.find((r: any) => r.name === 'pr-merge-on-green');
    expect(row).toBeDefined();
    expect(row.enabled).toBe(true);
    expect(row.builtin).toBe(true);
    expect(row.scope).toBe('system');

    const textRes = run(home, ['list', '--local']);
    expect(textRes.stdout).toContain('pr-merge-on-green');
    expect(textRes.stdout).toContain('(built-in)');
  });

  it('test --json evaluates once, prints the dry-run decision as JSON, and writes no state', () => {
    const home = makeHome();
    const emitter = path.join(home, 'emit-fixture.cjs');
    fs.writeFileSync(emitter, "process.stdout.write('build fail\\nnext\\n');\n");
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: {
        type: 'command',
        command: process.platform === 'win32' ? `node ${emitter}` : `${process.execPath} ${emitter}`,
      },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    const res = run(home, ['test', 'ci', '--json']);

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout).not.toContain('Dry-run:');
    const payload = JSON.parse(res.stdout);
    expect(payload.name).toBe('ci');
    expect(payload.dryRun).toBe(true);
    expect(payload.observation.raw).toBe('build fail\nnext');
    expect(payload.observation.meta.exitCode).toBe(0);
    expect(payload.wouldFire).toBe(true);
    expect(payload.decision.value).toBe('fail');
    expect(payload.decision.event.summary).toBe('fail');
    expect(fs.existsSync(statePath(home, 'ci'))).toBe(false);
  });

  it('missing monitor errors go to stderr, including in --json mode', () => {
    const home = makeHome();

    for (const cmd of ['view', 'test']) {
      const res = run(home, [cmd, 'missing', '--json']);
      expect(res.status).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain("Monitor 'missing' not found");
    }
  });

  it('add validation errors go to stderr and leave stdout clean', () => {
    const home = makeHome();

    const res = run(home, ['add', 'bad', '--poll', 'echo fail', '30s', '--run', 'claude']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Validation errors:');
    expect(res.stderr).toContain("action.type 'run' requires action.prompt");
  });

  it('add does not auto-start the daemon when daemon.enabled=false (PHNX-2637)', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, ['add', 'ci', '--poll', 'echo fail', '30s', '--match', 'fail', '--notify'], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    const out = `${res.stdout}${res.stderr}`;
    const pidPath = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'daemon.pid');

    try {
      expect(res.status).toBe(0);
      expect(out).toContain("Monitor 'ci' added");
      expect(out).toContain('daemon.enabled=false');
      expect(out).toContain('agents daemon enable');
      expect(out).not.toContain('Daemon started');
      expect(out).not.toContain('waiting for the engine');
      expect(fs.existsSync(path.join(home, '.agents', 'monitors', 'ci.yml'))).toBe(true);
      expect(fs.existsSync(pidPath)).toBe(false);
    } finally {
      if (fs.existsSync(pidPath)) {
        try {
          const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
          if (Number.isFinite(pid) && pid > 0) process.kill(pid, 'SIGTERM');
        } catch {  }
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('--watch-pid refuses to arm on an already-dead pid (PHNX-3023)', () => {
    const home = makeHome();
    const dead = spawnSync('/bin/sh', ['-c', 'sh -c "exit 0" & echo $!; wait'], { encoding: 'utf-8' });
    const deadPid = Number.parseInt(dead.stdout.trim().split('\n')[0], 10);

    const res = run(home, ['add', 'dead-watch', '--watch-pid', String(deadPid), '--notify']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('is not running');
    expect(fs.existsSync(path.join(home, '.agents', 'monitors', 'dead-watch.yml'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('--watch-pid arms a command source that fires on exit, not on-change', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');
    const child = spawn('sleep', ['30']);
    const pid = child.pid!;

    try {
      const res = run(home, ['add', 'live-watch', '--watch-pid', String(pid), '--notify'], {
        AGENTS_SYNC_MACHINE_ID: 'testbox',
        AGENTS_MONITORS_LOCAL: '1',
      });

      expect(res.status).toBe(0);
      expect(`${res.stdout}${res.stderr}`).toContain("Monitor 'live-watch' added");
      const written = yaml.parse(fs.readFileSync(path.join(home, '.agents', 'monitors', 'live-watch.yml'), 'utf-8'));
      expect(written.source.type).toBe('command');
      expect(written.source.command).toContain(`kill -0 ${pid}`);
      expect(written.condition).toEqual({ mode: 'match', match: 'exited' });
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'edit on a system built-in materializes a user copy and never writes the system mirror',
    () => {
      const home = makeHome();
      const sysFile = path.join(home, '.agents', '.system', 'monitors', 'ci-built-in.yml');
      writeSystemMonitor(home, {
        name: 'ci-built-in',
        source: { type: 'poll', command: 'echo hi', interval: '30s' },
        condition: { mode: 'on-change' },
        action: { type: 'notify', notifyChannel: 'telegram' },
      });
      const sysBefore = fs.readFileSync(sysFile, 'utf-8');

      const res = run(home, ['edit', 'ci-built-in'], { EDITOR: 'true' });
      expect(res.status).toBe(0);

      const userFile = path.join(home, '.agents', 'monitors', 'ci-built-in.yml');
      expect(fs.existsSync(userFile)).toBe(true);
      const userBody = fs.readFileSync(userFile, 'utf-8');
      expect(yaml.parse(userBody).source.command).toBe('echo hi');
      expect(userBody).not.toContain('scope:');
      expect(userBody).not.toContain('enabled: true');

      expect(fs.readFileSync(sysFile, 'utf-8')).toBe(sysBefore);
    },
  );

  it('remove deletes the user-layer YAML, keeps fire history, and drops the monitor from list', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: { type: 'poll', command: 'echo fail', interval: '30s' },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });
    writeState(home, 'ci');
    writeFire(home, 'ci');

    const res = run(home, ['remove', 'ci']);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Monitor 'ci' removed");
    expect(fs.existsSync(path.join(home, '.agents', 'monitors', 'ci.yml'))).toBe(false);
    expect(JSON.parse(run(home, ['list', '--json', '--local']).stdout)).toHaveLength(0);
    expect(fs.existsSync(statePath(home, 'ci'))).toBe(true);
    expect(
      fs.existsSync(path.join(home, '.agents', '.history', 'monitors', 'ci', 'fires', '2026-07-21T12-01-00-000Z', 'event.json')),
    ).toBe(true);
  });

  it('rm resolves as the remove alias', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'ci',
      enabled: true,
      source: { type: 'poll', command: 'echo fail', interval: '30s' },
      condition: { mode: 'match', match: 'fail' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    const res = run(home, ['rm', 'ci']);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Monitor 'ci' removed");
    expect(fs.existsSync(path.join(home, '.agents', 'monitors', 'ci.yml'))).toBe(false);
  });

  it('remove refuses a system built-in and points at pause', () => {
    const home = makeHome();
    writeSystemMonitor(home, {
      name: 'pr-merge-on-green',
      source: { type: 'poll', command: 'gh pr list --author @me', interval: '2m' },
      condition: { mode: 'on-change' },
      action: { type: 'notify', notifyChannel: 'telegram' },
    });

    const res = run(home, ['remove', 'pr-merge-on-green']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("can't be removed");
    expect(res.stderr).toContain('agents monitors pause pr-merge-on-green');
    expect(fs.existsSync(path.join(home, '.agents', '.system', 'monitors', 'pr-merge-on-green.yml'))).toBe(true);
  });

  it('remove on a missing name exits 1 on stderr', () => {
    const home = makeHome();

    const res = run(home, ['remove', 'missing']);

    expect(res.status).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain("Monitor 'missing' not found");
  });
});

describe('monitors runs postcondition (PHNX-2842)', () => {
  function writeRun(home: string, name: string, runId: string, status: string): void {
    const dir = path.join(home, '.agents', '.history', 'runs', name, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      jobName: name,
      runId,
      agent: 'claude',
      pid: null,
      status,
      startedAt: '2026-08-20T16:48:18.000Z',
      completedAt: status === 'running' ? null : '2026-08-20T16:50:00.000Z',
      exitCode: status === 'completed' ? 0 : 1,
    }));
  }

  function writeRunFire(home: string, name: string, runId: string, postcondition: string): void {
    const dir = path.join(home, '.agents', '.history', 'monitors', name, 'fires', '2026-08-20T16-48-18-000Z');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({
      monitorName: name,
      firedAt: '2026-08-20T16:48:18.000Z',
      summary: 'phnx-labs/agents-cli#1682',
      payload: {},
      runId,
      action: 'run',
      ok: true,
      runStatusAtFire: 'running',
      postcondition,
    }));
  }

  function failPostcondition(): string {
    return process.platform === 'win32'
      ? `"${process.execPath}" -e "process.exit(1)"`
      : `${JSON.stringify(process.execPath)} -e 'process.exit(1)'`;
  }

  it('runs prints "no effect" when the agent completed but the postcondition failed', () => {
    const home = makeHome();
    writeMonitor(home, {
      name: 'merge-pr-1682',
      enabled: true,
      source: { type: 'poll', command: 'echo x', interval: '5m' },
      condition: { mode: 'every' },
      action: { type: 'run', agent: 'claude', prompt: 'merge {event}', postcondition: failPostcondition() },
    });
    writeRun(home, 'merge-pr-1682', 'run-noop', 'completed');
    writeRunFire(home, 'merge-pr-1682', 'run-noop', failPostcondition());

    const res = run(home, ['runs', 'merge-pr-1682']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('no effect');
    expect(res.stdout).not.toMatch(/\bok\b/);
    expect(res.stdout).toContain('postcondition not met');
  });

  it('add --postcondition persists the command on the run action', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, [
      'add', 'merge-check',
      '--poll', 'echo x', '5m',
      '--every',
      '--run', 'claude',
      '--prompt', 'merge {event}',
      '--postcondition', 'exit 0',
    ], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    const file = path.join(home, '.agents', 'monitors', 'merge-check.yml');
    expect(fs.existsSync(file), `${res.stdout}\n${res.stderr}`).toBe(true);
    const parsed = yaml.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.action.postcondition).toBe('exit 0');
    expect(`${res.stdout}${res.stderr}`).not.toContain('no --postcondition');
  });

  it('add --run without --postcondition warns that completed-exit-0 still records as ok', () => {
    const home = makeHome();
    const deviceDir = path.join(home, '.agents', 'devices', 'testbox');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.writeFileSync(path.join(deviceDir, 'agents.yaml'), 'config:\n  daemonEnabled: false\n');

    const res = run(home, [
      'add', 'investigate',
      '--poll', 'echo fail', '30s',
      '--match', 'fail',
      '--run', 'claude',
      '--prompt', 'diagnose {event}',
    ], {
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      AGENTS_MONITORS_LOCAL: '1',
    });
    expect(res.status).toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('no --postcondition');
  });
});
