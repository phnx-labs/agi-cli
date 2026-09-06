import { describe, it, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = ['--user', '--map-root-user', '--pid', '--fork', '--mount-proc', '--kill-child'];
const probe = process.platform === 'linux' ? spawnSync('unshare', [...flags, 'true'], { encoding: 'utf8' }) : undefined;
const available = probe?.status === 0;
const fixture = fileURLToPath(new URL('./testdata/process-view-namespace.ts', import.meta.url));
function environment(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, AGENTS_REAL_HOME: home, AGENTS_DAEMON_DIR: path.join(home, '.agents/.cache/helpers/daemon') };
}
function marker(home: string): string { return path.join(home, '.agents/.cache/terminals/process-view.json'); }
async function ready(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('namespace owner startup timed out')), 5000);
    child.stdout!.once('data', data => { clearTimeout(timeout); String(data).includes('owned') ? resolve() : reject(new Error(String(data))); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`owner exited ${code}`)); });
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('namespace cleanup timed out')), 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGKILL');
  });
}

describe.skipIf(process.platform !== 'linux')('process namespace ownership', () => {
  it('does not enroll or mutate a fresh HOME from an observer', () => {
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-read-'));
    try {
      const child = spawnSync('bun', [fixture, 'read'], { env: environment(home), encoding: 'utf8', timeout: 5000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe(fs.readlinkSync('/proc/self/ns/pid') === 'pid:[4026531836]' ? 'owned' : 'unowned');
      expect(fs.existsSync(marker(home))).toBe(false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  for (const legacy of [false, true]) it(`bootstraps native cold discovery before daemon enrollment (legacy: ${legacy})`, () => {
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-cold-'));
    try {
      const record = path.join(home, '.agents/.cache/terminals/by-pid/2147483646.json');
      const original = JSON.stringify({ pid: 2147483646, sessionId: 'legacy-session' });
      if (legacy) {
        fs.mkdirSync(path.dirname(record), { recursive: true });
        fs.writeFileSync(record, original);
      }
      const authoritative = !legacy || fs.readlinkSync('/proc/self/ns/pid') === 'pid:[4026531836]';
      const child = spawnSync('bun', [fixture, 'sessions'], { env: environment(home), encoding: 'utf8', timeout: 15000 });
      expect(child.status, child.stderr).toBe(authoritative ? 0 : 2);
      expect(fs.existsSync(marker(home))).toBe(authoritative);
      if (legacy) expect(fs.readFileSync(record, 'utf8')).toBe(original);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it.skipIf(!available && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1')('bootstraps fresh private discovery but leaves legacy foreign state untouched', () => {
    if (!available) throw new Error(probe?.stderr || String(probe?.error));
    for (const legacy of [false, true]) {
      const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-private-cold-'));
      try {
        const record = path.join(home, '.agents/.cache/terminals/by-pid/1.json');
        const original = JSON.stringify({ pid: 1, sessionId: 'host-session' });
        if (legacy) {
          fs.mkdirSync(path.dirname(record), { recursive: true });
          fs.writeFileSync(record, original);
        }
        const observer = spawnSync('unshare', [...flags, 'bun', fixture, 'read'], { env: environment(home), encoding: 'utf8', timeout: 5000 });
        expect(observer.status, observer.stderr).toBe(0);
        expect(observer.stdout.trim()).toBe('unowned');
        expect(fs.existsSync(marker(home))).toBe(false);
        const child = spawnSync('unshare', [...flags, 'bun', fixture, 'sessions'], { env: environment(home), encoding: 'utf8', timeout: 15000 });
        expect(child.status, child.stderr).toBe(legacy ? 2 : 0);
        expect(fs.existsSync(marker(home))).toBe(!legacy);
        if (legacy) expect(fs.readFileSync(record, 'utf8')).toBe(original);
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    }
  });
  it('refuses an old init incarnation even when the boot and namespace inode match', () => {
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-incarnation-'));
    try {
      const first = spawnSync('bun', [fixture, 'once'], { env: environment(home), encoding: 'utf8', timeout: 5000 });
      expect(first.status, first.stderr).toBe(0);
      const owner = JSON.parse(fs.readFileSync(marker(home), 'utf8'));
      expect(owner.initStartTicks).toMatch(/^\d+$/);
      owner.initStartTicks += '1';
      const original = JSON.stringify(owner);
      fs.writeFileSync(marker(home), original);
      for (const mode of ['read', 'daemon', 'once']) {
        const child = spawnSync('bun', [fixture, mode], { env: environment(home), encoding: 'utf8', timeout: 5000 });
        expect(child.status, child.stderr).toBe(mode === 'read' ? 0 : 2);
        if (mode === 'read') expect(child.stdout.trim()).toBe('unowned');
        if (mode !== 'read') expect(child.stderr).toMatch(/private-container HOME across namespaces is unsupported/);
        expect(fs.readFileSync(marker(home), 'utf8')).toBe(original);
      }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it.skipIf(!available && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1')('reads unmarked foreign snapshots without creating host directories or rewriting bytes', () => {
    if (!available) throw new Error(probe?.stderr || String(probe?.error));
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-observer-'));
    try {
      const publisher = spawnSync('bun', [fixture, 'publish'], { env: environment(home), encoding: 'utf8', timeout: 15000 });
      expect(publisher.status, publisher.stderr).toBe(0);
      const terminals = path.dirname(marker(home));
      fs.rmSync(terminals, { recursive: true });
      const snapshot = path.join(home, '.agents/.cache/.active-sessions.json');
      const before = fs.readFileSync(snapshot, 'utf8');
      const observer = spawnSync('unshare', [...flags, 'bun', fixture, 'snapshot'], { env: environment(home), encoding: 'utf8', timeout: 15000 });
      expect(observer.status, observer.stderr).toBe(0);
      expect(observer.stdout.trim()).toBe('observed');
      expect(fs.existsSync(terminals)).toBe(false);
      expect(fs.readFileSync(snapshot, 'utf8')).toBe(before);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  for (const initialWriter of ['hold', 'hook-first', 'separate-init']) it.skipIf(!available && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1')(`protects private HOME ownership before and after its namespace exits (${initialWriter})`, async () => {
    if (!available) throw new Error(probe?.stderr || String(probe?.error));
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-'));
    let first: ChildProcess | undefined;
    try {
      // A real separate init survives its ordinary CLI child. An exited writer
      // is no evidence that the namespace died or that this HOME is available.
      const init = 'import signal,subprocess,sys; child=subprocess.run(["bun",sys.argv[1],"once"],check=True,capture_output=True,text=True); print(child.stdout,end="",flush=True); signal.pause()';
      const command = initialWriter === 'separate-init'
        ? ['python3', '-c', init, fixture] : ['bun', fixture, initialWriter];
      first = spawn('unshare', [...flags, ...command], { env: environment(home), stdio: ['ignore', 'pipe', 'pipe'] });
      await ready(first);
      const original = fs.readFileSync(marker(home), 'utf8');
      if (initialWriter === 'separate-init') expect(JSON.parse(original).ownerPid).toBeGreaterThan(1);
      const denied = () => {
        for (const mode of ['daemon', 'once']) {
          const contender = spawnSync('unshare', [...flags, 'bun', fixture, mode], { env: environment(home), encoding: 'utf8', timeout: 5000 });
          expect(contender.status, contender.stderr).toBe(2);
          expect(contender.stderr).toMatch(/private-container HOME across namespaces is unsupported/);
          expect(fs.readFileSync(marker(home), 'utf8')).toBe(original);
        }
      };
      denied();
      expect(first.exitCode).toBeNull();
      await stop(first);
      denied();
    } finally {
      if (first) await stop(first);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(!available && process.env.AGENTS_REQUIRE_PID_NAMESPACE_TEST !== '1')('never treats an exited ordinary host writer as a dead namespace', () => {
    if (!available) throw new Error(probe?.stderr || String(probe?.error));
    const home = fs.mkdtempSync(path.join(process.env.HOME!, 'process-view-host-'));
    try {
      const host = spawnSync('bun', [fixture, 'once'], { env: environment(home), encoding: 'utf8', timeout: 5000 });
      expect(host.status, host.stderr).toBe(0);
      const original = fs.readFileSync(marker(home), 'utf8');
      const child = spawnSync('unshare', [...flags, 'bun', fixture, 'daemon'], { env: environment(home), encoding: 'utf8', timeout: 5000 });
      expect(child.status).toBe(2);
      expect(fs.readFileSync(marker(home), 'utf8')).toBe(original);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
