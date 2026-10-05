import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  DAEMON_TESTS_SUPPORTED,
  REPO_ROOT,
  TSX_IMPORT,
  CLI_ENTRYPOINT,
  makeHome,
  run,
  spawnFakeRegisteredDaemon,
  registerInstance,
  killFakeDaemon,
} from './daemon-test-harness.js';

const describeDaemon = DAEMON_TESTS_SUPPORTED ? describe : describe.skip;

describeDaemon('agents daemon — command surface, status, enable/disable', () => {
  it('resolves as a real command — the group daemon-removal.test.ts used to pin absent', () => {
    const res = run(makeHome(), ['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain("unknown command 'daemon'");
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('services');
    expect(res.stdout).toContain('funnel');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('doctor');
    expect(res.stdout).not.toMatch(/^\s*jobs\b/m);
  });
  it('nests Funnel management under daemon and removes the top-level command', () => {
    const home = makeHome();
    const nested = run(home, ['funnel', '--help']);
    expect(nested.status).toBe(0);
    expect(nested.stdout).toContain('status <host>');
    expect(nested.stdout).toContain('up [options] <host>');
    expect(nested.stdout).toContain('down [options] <host>');

    const topLevel = spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'funnel', '--help'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(topLevel.status).not.toBe(0);
    expect(topLevel.stderr + topLevel.stdout).toContain("unknown command 'funnel'");
  });
  it('bare `agents daemon` (no subcommand) is the same as `status`', () => {
    const home = makeHome();
    const bare = run(home, ['--json']);
    const status = run(home, ['status', '--json']);
    expect(JSON.parse(bare.stdout).state).toBe(JSON.parse(status.stdout).state);
  });
  it('disable persists daemon.enabled: false and status reflects it as "disabled"', () => {
    const home = makeHome();
    const disable = run(home, ['disable']);
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain('daemon.enabled: false');

    const status = run(home, ['status', '--json']);
    const payload = JSON.parse(status.stdout);
    expect(payload.state).toBe('disabled');
    expect(payload.daemonEnabled).toBe(false);

    const devicesDir = path.join(home, '.agents', 'devices');
    const [machineDir] = fs.readdirSync(devicesDir);
    const localDoc = fs.readFileSync(path.join(devicesDir, machineDir, 'agents.yaml'), 'utf-8');
    expect(localDoc).toContain('daemonEnabled: false');
    const central = fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8');
    expect(central).not.toContain('daemonEnabled');
  });
  it('enable clears the kill switch again', () => {
    const home = makeHome();
    run(home, ['disable']);
    const enable = run(home, ['enable']);
    expect(enable.status).toBe(0);
    expect(enable.stdout).toContain('daemon.enabled: true');
    const status = run(home, ['status', '--json']);
    expect(JSON.parse(status.stdout).daemonEnabled).toBe(true);
    expect(JSON.parse(status.stdout).state).toBe('stopped');
  });
  it('a disabled device refuses `agents routines start` with a message naming the fix', () => {
    const home = makeHome();
    run(home, ['disable']);
    const res = spawnSync('node', ['--import', TSX_IMPORT, CLI_ENTRYPOINT, 'routines', 'start'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, AGENTS_SKIP_MIGRATION: '1', AGENTS_NO_AUTOPULL: '1', AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr + res.stdout).toContain('daemon.enabled=false');
    expect(res.stderr + res.stdout).toContain('agents daemon enable');
  });
  it('a stale health.json is not trusted as live when the daemon is not running (RUSH-2368)', () => {
    const home = makeHome();
    const healthPath = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'health.json');
    fs.mkdirSync(path.dirname(healthPath), { recursive: true });
    fs.writeFileSync(healthPath, JSON.stringify({
      'session-index': {
        subsystem: 'session-index', state: 'running',
        lastOkAt: new Date().toISOString(), lastError: null, lastErrorAt: null, consecutiveFailures: 0,
      },
    }), 'utf-8');
    const res = run(home, ['services', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as { services: Array<{ id: string; state: string }> };
    const si = payload.services.find((s) => s.id === 'session-index')!;
    expect(si.state).toBe('stopped');
  });
  it(
    'duplicates come from THIS install\'s instance registry — a fixture daemon under a separate ' +
    'AGENTS_DAEMON_DIR never appears, even though a genuine same-registry duplicate does (RUSH-2368)',
    async () => {
      const home = makeHome();
      const otherHome = makeHome();
      let ownDuplicate: ChildProcess | undefined;
      let foreignFixture: ChildProcess | undefined;
      try {
        ownDuplicate = await spawnFakeRegisteredDaemon(home);
        foreignFixture = await spawnFakeRegisteredDaemon(otherHome);

        const res = run(home, ['status', '--json']);
        expect(res.status).toBe(0);
        const payload = JSON.parse(res.stdout);
        const duplicatePids = payload.duplicates.map((d: { pid: number }) => d.pid);
        expect(duplicatePids).toContain(ownDuplicate.pid);
        expect(duplicatePids).not.toContain(foreignFixture.pid);
      } finally {
        if (ownDuplicate) killFakeDaemon(ownDuplicate);
        if (foreignFixture) killFakeDaemon(foreignFixture);
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(otherHome, { recursive: true, force: true });
      }
    },
    20_000,
  );
  it('status flags a daemon whose entry file was deleted from disk', async () => {
    const home = makeHome();
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stale-entry-'));
    const script = path.join(scriptDir, 'index.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(process.execPath, [script, '__daemon-run'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    try {
      const before = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(before.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);

      fs.rmSync(scriptDir, { recursive: true, force: true });

      const after = JSON.parse(run(home, ['status', '--json']).stdout);
      const hit = after.staleBinaries.find((s: { pid: number }) => s.pid === child.pid);
      expect(hit, 'deleted entry must be reported').toBeTruthy();
      expect(hit.entry).toBe(script);

      const text = run(home, ['status']);
      expect(text.stdout).toContain('Stale code');
      expect(text.stdout).toContain(String(child.pid));

      const health = JSON.parse(run(home, ['doctor', '--json']).stdout);
      expect(health.problems.some((p: string) => p.includes('deleted from disk'))).toBe(true);
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
      fs.rmSync(scriptDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
  it('does not flag a non-path entry as deleted code', async () => {
    const home = makeHome();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    try {
      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('does not accuse a live daemon whose entry path contains spaces', async () => {
    const home = makeHome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents stale space-'));
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const script = path.join(sub, 'index.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(process.execPath, [script, '__daemon-run'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    try {
      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('shows an unregistered same-uid stale daemon but never makes it actionable', async () => {
    const home = makeHome();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-unregistered-'));
    const script = path.join(dir, 'index.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(process.execPath, [script, '__daemon-run'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(
        payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid),
        'must be VISIBLE',
      ).toBe(true);

      const row = payload.staleBinaries.find((s: { pid: number }) => s.pid === child.pid);
      expect(row.actionable, 'json row must be marked non-actionable').toBe(false);

      const health = JSON.parse(run(home, ['doctor', '--json']).stdout);
      expect(
        health.problems.some((p: string) => p.includes(String(child.pid))),
        'must NOT be a doctor problem',
      ).toBe(false);

      const text = run(home, ['status']).stdout;
      expect(text).toContain('Stale code');
      expect(text).toContain('nothing for you to stop here');
      expect(text).not.toContain('kill <pid>');
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });


  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'does not call an unreadable entry deleted (EACCES is not ENOENT)', async () => {
    const home = makeHome();
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-eacces-'));
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner);
    const script = path.join(inner, 'index.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(process.execPath, [script, '__daemon-run'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    fs.chmodSync(inner, 0o000);
    try {
      const stillThere = (() => { try { fs.chmodSync(inner, 0o700); const ok = fs.existsSync(script); fs.chmodSync(inner, 0o000); return ok; } catch { return false; } })();
      expect(stillThere, 'entry must really still exist').toBe(true);

      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);
    } finally {
      try { fs.chmodSync(inner, 0o700); } catch {  }
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch {  }
      fs.rmSync(outer, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  );
});
