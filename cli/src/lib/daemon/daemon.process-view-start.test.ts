import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DAEMON_SERVICES } from '../daemon-services.js';

function exerciseStartup(legacy?: 'absent' | 'old-boot'): void {
  const home = fs.mkdtempSync('/tmp/agd-start-pv-');
  const config = path.join(home, '.agents', 'daemon');
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'services.yaml'), `services:\n${DAEMON_SERVICES.map(({ id }) => `  ${id}: ${id === 'browser-ipc'}`).join('\n')}\n`);
  const daemon = fileURLToPath(new URL('./testdata/process-view-daemon.ts', import.meta.url));
  const starter = fileURLToPath(new URL('./testdata/process-view-start.ts', import.meta.url));
  const launcher = path.join(home, 'test-agents');
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  fs.writeFileSync(launcher, `#!/bin/sh\nexec bun ${quote(daemon)} "$@"\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENTS_REAL_HOME: home, AGENTS_DAEMON_TEST_HOME: home, AGENTS_SECRETS_NO_AGENT: '1', AGENTS_CLI_DISABLE_AUTO_UPDATE: '1' };
  delete env.AGENTS_DAEMON_DIR;
  delete env.AGENTS_SERVICE_MANAGER_ALLOW_REDIRECTED_HOME;
  if (legacy) {
    const cache = path.join(home, '.agents', '.cache');
    const daemonDir = path.join(cache, 'helpers', 'daemon');
    const terminals = path.join(cache, 'terminals');
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.mkdirSync(path.join(terminals, 'by-pid'), { recursive: true });
    // Use a real, already-exited process, rather than assuming an arbitrary
    // numeric PID is unused on the execution machine.
    const exited = spawnSync('bun', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    expect(exited.status).toBe(0);
    const deadPid = Number(exited.stdout.trim());
    expect(() => process.kill(deadPid, 0)).toThrow();
    fs.writeFileSync(path.join(daemonDir, 'daemon.pid'), String(deadPid));
    fs.writeFileSync(path.join(daemonDir, 'daemon.lifetime'), `${deadPid}:1`);
    fs.writeFileSync(path.join(terminals, 'by-pid', `${deadPid}.json`), JSON.stringify({ pid: deadPid, sessionId: 'prior-boot-session' }));
    if (legacy === 'old-boot') fs.writeFileSync(path.join(terminals, 'process-view.json'), JSON.stringify({ bootId: 'prior-kernel-boot', pidNamespace: 'pid:[4026531836]' }));
    expect(fs.existsSync(path.join(cache, 'helpers', 'browser', 'browser.sock'))).toBe(false);
  }
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', starter, launcher, legacy ? 'cold' : 'fresh', daemon], { env, encoding: 'utf8', timeout: 15000 });
    const logs = path.join(home, '.agents', '.cache', 'helpers', 'daemon', 'logs.jsonl');
    const diagnostic = result.stderr + (fs.existsSync(logs) ? fs.readFileSync(logs, 'utf8') : '');
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    expect(result.stdout).toContain(`${legacy ? 'cold runDaemon' : 'ordinary startDaemon: health published'}; canonical socket ready; namespace owner verified`);
  } finally {
    // The helper normally uses the real private-home stop path. This bounded
    // backstop covers assertion failure and timeout before normal teardown.
    const pidFile = path.join(home, 'test-child.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(daemon)) {
          process.kill(pid, 'SIGKILL');
          for (let i = 0; i < 100; i++) {
            try {
              const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
              if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) break;
            } catch { break; }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          }
        }
      } catch { /* already terminated */ }
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

it.skipIf(process.platform !== 'linux')('ordinary startDaemon accepts its own pre-spawn health files in a fresh HOME', () => {
  exerciseStartup();
}, 20000);

const nativeInitialNamespace = process.platform === 'linux' && fs.statSync('/proc/self/ns/pid').ino === 0xEFFFFFFC;
for (const legacy of ['absent', 'old-boot'] as const) {
  it.skipIf(!nativeInitialNamespace)(`native cold startup migrates ${legacy} ownership with a dead legacy daemon and no live socket`, () => {
    exerciseStartup(legacy);
  }, 20000);
}
