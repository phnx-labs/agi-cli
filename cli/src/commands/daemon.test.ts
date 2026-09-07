/**
 * agents daemon — command surface, status, enable/disable.
 *
 * The command group itself: that it resolves, that Funnel nests under it, and
 * that status/enable/disable agree about whether this device runs a daemon.
 *
 * Split out of a single 35-test `daemon.test.ts` that ran 159s — the slowest
 * file in the repo, and therefore the whole suite's floor: vitest parallelises
 * across FILES and runs one file's tests sequentially in a single worker. The
 * shared spawn harness lives in `daemon-test-harness.ts`.
 */
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
    // No `jobs` subcommand — scheduled work is `agents routines`, always.
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

    // Persisted to disk, not just in-process — the status call above is a fresh
    // CLI invocation that read it back. It lands in THIS machine's own doc, not
    // the fleet-shared agents.yaml: the kill switch is machine-local, so syncing
    // it would disable the daemon on every box that pulls.
    // The doc is keyed by this machine's id, which the test does not pin — read
    // whichever device dir the CLI created rather than hardcoding a name.
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
    // Seed a supervisor record claiming session-index is "running", but no daemon
    // is actually up in this HOME (kill -9 / crash / never relaunched).
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
    // The daemon is down, so the stale 'running' record must render as 'stopped' —
    // trusting it would contradict the live-probed hosted-socket rows in the same output.
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
        // A real __daemon-run process registered in `home`'s OWN registry — a
        // genuine duplicate (e.g. a predecessor that crashed without cleanup).
        ownDuplicate = await spawnFakeRegisteredDaemon(home);
        // A real __daemon-run process registered in a COMPLETELY SEPARATE
        // registry (`otherHome`) — standing in for the leaked vitest fixture
        // this ticket was filed over: same box, different HOME, therefore a
        // different getDaemonDir() and a different registry. A raw `ps` scan
        // sees both processes identically; the registry does not.
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
  /**
   * RUSH-2493: a daemon whose entry file has been deleted answers every probe
   * and reads healthy, but cannot restart and runs whatever was loaded before
   * the delete. Observed live: one ran 4h14m from a removed worktree while
   * `systemctl is-active` said `active`.
   *
   * Real process launched from a real file that is then unlinked — no mocks.
   */
  // 90s, not the default 30s: several real `agents` CLI boots (cold `node
  // --import tsx`), measured over the 30s cap under 16 CPU-bound background
  // processes on a 20-core box (RUSH-2839).
  it('status flags a daemon whose entry file was deleted from disk', async () => {
    const home = makeHome();
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-stale-entry-'));
    const script = path.join(scriptDir, 'index.js');
    fs.writeFileSync(script, 'setInterval(() => {}, 1e9);\n');
    const child = spawn(process.execPath, [script, '__daemon-run'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    try {
      // Still on disk -> not stale.
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

      // And it is a health problem, not just a display row.
      const health = JSON.parse(run(home, ['doctor', '--json']).stdout);
      expect(health.problems.some((p: string) => p.includes('deleted from disk'))).toBe(true);
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(scriptDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
  it('does not flag a non-path entry as deleted code', async () => {
    const home = makeHome();
    // `node -e '<code>' __daemon-run` — the second-to-last token is a code blob,
    // not a file. It "does not exist on disk" and must NOT be reported.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 200));
    registerInstance(home, child.pid!);
    try {
      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
  it('does not accuse a live daemon whose entry path contains spaces', async () => {
    const home = makeHome();
    // `ps` renders the path unquoted, so the tokenizer splits it and the
    // second-to-last token is a relative fragment. The absolute-path guard is
    // what keeps a HEALTHY daemon on such a path from being reported.
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
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
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
    // Deliberately NOT registered -- this is the INCIDENT shape. The 4h14m ghost
    // ran from a deleted worktree under an ephemeral /tmp cwd, so it was neither
    // status.pid nor in this install's registry. Gating the DISPLAY on the
    // registry would leave this command silent on the case it exists for.
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(
        payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid),
        'must be VISIBLE',
      ).toBe(true);

      // ...but never actionable: no doctor problem, so no kill instruction and
      // no exit 1 for every other user on this box (RUSH-2368's actual harm).
      // The tier must ride the machine surface too — a routine reading
      // staleBinaries has to tell a ghost it may act on from one it may not.
      const row = payload.staleBinaries.find((s: { pid: number }) => s.pid === child.pid);
      expect(row.actionable, 'json row must be marked non-actionable').toBe(false);

      const health = JSON.parse(run(home, ['doctor', '--json']).stdout);
      expect(
        health.problems.some((p: string) => p.includes(String(child.pid))),
        'must NOT be a doctor problem',
      ).toBe(false);

      // And the text footer must not offer `kill` under a section whose only
      // rows are visibility-tier — the same harm via the render layer.
      const text = run(home, ['status']).stdout;
      expect(text).toContain('Stale code');
      expect(text).toContain('nothing for you to stop here');
      expect(text).not.toContain('kill <pid>');
    } finally {
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });


  // root ignores mode bits, so the EACCES condition cannot be produced there and
  // the test would pass without exercising anything. Not flake suppression.
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
    // The file is present the whole time; only its parent becomes untraversable.
    // fs.existsSync cannot tell this from deletion, which is the bug this pins:
    // reporting it would tell the user to kill a healthy daemon they cannot stat.
    fs.chmodSync(inner, 0o000);
    try {
      const stillThere = (() => { try { fs.chmodSync(inner, 0o700); const ok = fs.existsSync(script); fs.chmodSync(inner, 0o000); return ok; } catch { return false; } })();
      expect(stillThere, 'entry must really still exist').toBe(true);

      const payload = JSON.parse(run(home, ['status', '--json']).stdout);
      expect(payload.staleBinaries.some((s: { pid: number }) => s.pid === child.pid)).toBe(false);
    } finally {
      try { fs.chmodSync(inner, 0o700); } catch { /* ignore */ }
      try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(outer, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  );
});
