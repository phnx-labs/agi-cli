import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DAEMON_SERVICES } from '../daemon-services.js';

const fixture = fileURLToPath(new URL('./testdata/process-view-daemon.ts', import.meta.url));
const flags = ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc'];
const probe = process.platform === 'linux' ? spawnSync('unshare', [...flags, 'true'], { encoding: 'utf8' }) : undefined;
const namespaceAvailable = probe?.status === 0;

async function accepting(socket: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = net.createConnection(socket);
    const finish = (value: boolean) => { client.destroy(); resolve(value); };
    client.setTimeout(100, () => finish(false));
    client.once('connect', () => finish(true));
    client.once('error', () => finish(false));
  });
}
async function until(check: () => boolean | Promise<boolean>, diagnostic: () => string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(diagnostic());
}
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
}

describe.skipIf(process.platform !== 'linux')('daemon process-view startup with real singleton socket', () => {
  for (const legacy of ['absent', 'old-boot'] as const) {
    it.skipIf(!namespaceAvailable && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1')(
      `refuses a nested ${legacy} migration before lifecycle mutation, then permits the native replacement`, async () => {
        if (!namespaceAvailable) throw new Error(probe?.stderr || String(probe?.error));
        const home = fs.mkdtempSync('/tmp/agd-pv-');
        const cache = path.join(home, '.agents', '.cache');
        const daemonDir = path.join(cache, 'helpers', 'daemon');
        const socket = path.join(cache, 'helpers', 'browser', 'browser.sock');
        const marker = path.join(cache, 'terminals', 'process-view.json');
        const config = path.join(home, '.agents', 'daemon');
        fs.mkdirSync(config, { recursive: true });
        fs.writeFileSync(path.join(config, 'services.yaml'), `services:\n${DAEMON_SERVICES.map(({ id }) => `  ${id}: ${id === 'browser-ipc'}`).join('\n')}\n`);
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENTS_REAL_HOME: home, AGENTS_DAEMON_TEST_HOME: home, AGENTS_SECRETS_NO_AGENT: '1', AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' };
        delete env.AGENTS_DAEMON_DIR;
        const children: ChildProcess[] = [];
        let output = '';
        const launch = () => {
          const child = spawn('bun', [fixture, '__daemon-run'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout!.on('data', data => { output += data; });
          child.stderr!.on('data', data => { output += data; });
          children.push(child);
          return child;
        };
        try {
          const original = launch();
          await until(() => accepting(socket), () => `original daemon failed: ${output}`);
          expect(fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim()).toBe(String(original.pid));
          if (legacy === 'absent') fs.unlinkSync(marker);
          else fs.writeFileSync(marker, JSON.stringify({ bootId: 'previous-kernel-boot', pidNamespace: 'previous-namespace' }));
          // Cross-repository seam: opt in to the canonical system worktree
          // hook, never an installed mirror or an absolute developer path.
          const identityHook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK;
          if (identityHook) {
            const registry = path.join(cache, 'terminals', 'by-pid');
            const metadata = path.join(cache, 'state', 'sessions');
            fs.mkdirSync(registry, { recursive: true });
            fs.mkdirSync(metadata, { recursive: true });
            const collision = [path.join(registry, '1.json'), path.join(metadata, '1.json')];
            const sentinel = JSON.stringify({ pid: 1, sessionId: 'host-session', session_id: 'host-session', terminalId: 'host-terminal' });
            for (const file of collision) fs.writeFileSync(file, sentinel);
            const hookRunner = `import subprocess,sys; sys.exit(subprocess.run(["bash",sys.argv[1]],input='{"session_id":"nested-hook"}',text=True).returncode)`;
            const nestedHook = spawnSync('unshare', [...flags, 'python3', '-c', hookRunner, identityHook], { env, encoding: 'utf8', timeout: 5000 });
            expect(nestedHook.status, nestedHook.stderr).toBe(0);
            expect(collision.map(file => fs.readFileSync(file, 'utf8'))).toEqual([sentinel, sentinel]);
            if (legacy === 'absent') {
              const nativeRecord = path.join(registry, `${process.pid}.json`);
              fs.writeFileSync(nativeRecord, JSON.stringify({ pid: process.pid, sessionId: 'launcher-id', terminalId: 'native-terminal', launchId: 'native-launch' }));
              const nativeHook = spawnSync('bash', [identityHook], { env, input: JSON.stringify({ session_id: 'native-hook' }), encoding: 'utf8', timeout: 5000 });
              expect(nativeHook.status, nativeHook.stderr).toBe(0);
              expect(JSON.parse(fs.readFileSync(nativeRecord, 'utf8'))).toMatchObject({ sessionId: 'native-hook', terminalId: 'native-terminal', launchId: 'native-launch' });
              expect(JSON.parse(fs.readFileSync(path.join(metadata, `${process.pid}.json`), 'utf8')).session_id).toBe('native-hook');
              // The initial host can enroll before its daemon starts; a
              // noninitial namespace needs the live socket and does not enroll.
              expect(fs.existsSync(marker)).toBe(fs.readlinkSync('/proc/self/ns/pid') === 'pid:[4026531836]');
            }
          }
          // Sentinels catch the old lock's PID-based stale cleanup and registry
          // mutations, independently of whether the nested daemon exits cleanly.
          const lock = path.join(daemonDir, 'daemon.lock');
          fs.writeFileSync(lock, '2147483646');
          const record = path.join(cache, 'terminals', 'by-pid', `${original.pid}.json`);
          fs.mkdirSync(path.dirname(record), { recursive: true });
          fs.writeFileSync(record, JSON.stringify({ pid: original.pid, sessionId: 'host-session', terminalId: 'launcher-terminal' }));
          const watched = [marker, lock, record, path.join(daemonDir, 'daemon.pid'), path.join(daemonDir, 'daemon.lifetime')];
          const before = watched.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
          const nested = spawnSync('unshare', [...flags, 'bun', fixture, '__daemon-run'], { env, encoding: 'utf8', timeout: 15000 });
          expect(nested.error, nested.stderr).toBeUndefined();
          expect(nested.status, nested.stderr).toBe(0);
          expect(nested.stderr).toContain('Daemon startup requires the owning process namespace');
          expect(watched.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)).toEqual(before);
          const nestedLauncher = spawnSync('unshare', [...flags, 'bun', fixture, '__start-daemon'], { env, encoding: 'utf8', timeout: 15000 });
          expect(nestedLauncher.status, nestedLauncher.stderr).toBe(2);
          expect(nestedLauncher.stdout).toContain('Daemon startup requires the owning process namespace');
          expect(watched.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)).toEqual(before);
          expect(await accepting(socket)).toBe(true);
          expect(original.exitCode).toBeNull();
          // The native namespace authenticates the actual browser socket owner
          // and performs the normal last-wins singleton handover.
          fs.unlinkSync(lock);
          const replacement = launch();
          await until(() => fs.existsSync(path.join(daemonDir, 'daemon.pid')) && fs.readFileSync(path.join(daemonDir, 'daemon.pid'), 'utf8').trim() === String(replacement.pid) && accepting(socket), () => `native migration failed: ${output}`);
          const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
          expect(owner.bootId).toBe(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
          expect(owner.pidNamespace).toBe(fs.readlinkSync('/proc/self/ns/pid'));
          await until(() => original.exitCode !== null || original.signalCode !== null, () => `incumbent survived: ${output}`);
          expect(fs.readFileSync(record, 'utf8')).toBe(before[2]);
        } finally {
          await Promise.all(children.map(terminate));
          fs.rmSync(home, { recursive: true, force: true });
        }
      }, 40000);
  }
});
