import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runAgents, writeUpdateCache } from './commands/sessions.test-fixture.js';



const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function stubSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-fastpath-'));
  temps.push(dir);
  const bin = path.join(dir, 'sessions');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho STUB_SESSIONS_OK\nprintf '%s\\n' "$@" > "${dir}/argv"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function stubSessionsVersioned(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-fastpath-'));
  temps.push(dir);
  const bin = path.join(dir, 'sessions');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho STUB_SESSIONS_OK\nprintf '%s\\n' "$@" > "${dir}/argv"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function stubSessionsHost127(version: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-fastpath-'));
  temps.push(dir);
  const bin = path.join(dir, 'sessions');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nprintf '%s\\n' "$@" > "${dir}/argv"\necho "bash: sessions: STUB_HOST_127_NOTFOUND" >&2\nexit 127\n`,
    { mode: 0o755 },
  );
  return bin;
}

function writeDeviceRegistry(home: string, names: string[]): string {
  const dir = path.join(home, 'devices-reg');
  fs.mkdirSync(dir, { recursive: true });
  const registry: Record<string, unknown> = {};
  for (const name of names) {
    registry[name] = {
      name,
      platform: 'linux',
      shell: 'posix',
      user: 'me',
      address: { via: 'manual', dnsName: `${name}.invalid` },
      auth: { method: 'key' },
    };
  }
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify(registry), 'utf-8');
  return dir;
}

describe('index.ts sessions read fast-path (PHNX-4012)', () => {
  it('execs SESSIONS_BIN for a search without loading the sessions command module', () => {
    const bin = stubSessions();
    const r = spawnSync('bun', [INDEX, 'sessions', 'auth', '--json', '--limit', '5'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SESSIONS_BIN: bin, AGENTS_NO_AUTOPULL: '1' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('STUB_SESSIONS_OK');
    const argv = fs.readFileSync(path.join(path.dirname(bin), 'argv'), 'utf-8').trim().split('\n');
    expect(argv).toEqual(['auth', '--json', '--limit', '5']);
  });

  it('falls through to the in-repo engine when no standalone sessions binary is installed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sessions-fallback-'));
    try {
      writeUpdateCache(home);
      const cleanPath = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir && !fs.existsSync(path.join(dir, 'sessions')))
        .join(path.delimiter);
      const r = runAgents(['sessions', '--json', '--no-interactive'], REPO_ROOT, home, { PATH: cleanPath, SESSIONS_BIN: '', AGENTS_NO_AUTOPULL: '1' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain('using the in-process engine');
      expect(r.stderr).not.toContain('Install it, then re-run');
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('forwards --host to a >=0.2.1 standalone, argv intact (PHNX-4012 remote read)', () => {
    const bin = stubSessionsVersioned('0.2.1');
    const r = spawnSync('bun', [INDEX, 'sessions', 'auth', '--host', 'box', '--json'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SESSIONS_BIN: bin, AGENTS_NO_AUTOPULL: '1' },
      encoding: 'utf-8',
      timeout: 15_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('STUB_SESSIONS_OK');
    const argv = fs.readFileSync(path.join(path.dirname(bin), 'argv'), 'utf-8').trim().split('\n');
    expect(argv).toEqual(['auth', '--host', 'box', '--json']);
  });

  it('routes a read --device query through the standalone --host (>=0.2.1), --device stripped', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-host-'));
    temps.push(home);
    writeUpdateCache(home);
    const devicesDir = writeDeviceRegistry(home, ['box']);
    const bin = stubSessionsVersioned('0.2.1');
    const r = runAgents(['sessions', 'auth', '--device', 'box', '--json'], REPO_ROOT, home, {
      SESSIONS_BIN: bin,
      AGENTS_DEVICES_DIR: devicesDir,
      AGENTS_NO_AUTOPULL: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('STUB_SESSIONS_OK');
    const argv = fs.readFileSync(path.join(path.dirname(bin), 'argv'), 'utf-8').trim().split('\n');
    expect(argv).toEqual(['auth', '--json', '--host', 'ssh://me@box.invalid']);
  });

  it('does NOT route a MULTI-device read to the standalone --host (stays on the in-repo fan-out)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-host-multi-'));
    temps.push(home);
    writeUpdateCache(home);
    const devicesDir = writeDeviceRegistry(home, ['box', 'mac-mini']);
    const bin = stubSessionsVersioned('0.2.1');
    const r = runAgents(['sessions', 'auth', '--device', 'box', 'mac-mini', '--json'], REPO_ROOT, home, {
      SESSIONS_BIN: bin,
      AGENTS_DEVICES_DIR: devicesDir,
      AGENTS_NO_AUTOPULL: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(fs.existsSync(path.join(path.dirname(bin), 'argv'))).toBe(false);
  });

  it('falls through to the in-repo --device path when the peer lacks the standalone (exit 127)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-host-127-'));
    temps.push(home);
    writeUpdateCache(home);
    const devicesDir = writeDeviceRegistry(home, ['box']);
    const bin = stubSessionsHost127('0.2.1');
    const r = runAgents(['sessions', 'auth', '--device', 'box', '--json'], REPO_ROOT, home, {
      SESSIONS_BIN: bin,
      AGENTS_DEVICES_DIR: devicesDir,
      AGENTS_NO_AUTOPULL: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout).not.toContain('STUB_HOST_127_NOTFOUND');
    expect(r.stderr).not.toContain('STUB_HOST_127_NOTFOUND');
  });

  it('leaves a read --device query on the in-repo path when the standalone is below the --host floor (0.2.0)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-host-floor-'));
    temps.push(home);
    writeUpdateCache(home);
    const devicesDir = writeDeviceRegistry(home, ['box']);
    const bin = stubSessionsVersioned('0.2.0');
    const r = runAgents(['sessions', 'auth', '--device', 'box', '--json'], REPO_ROOT, home, {
      SESSIONS_BIN: bin,
      AGENTS_DEVICES_DIR: devicesDir,
      AGENTS_NO_AUTOPULL: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(fs.existsSync(path.join(path.dirname(bin), 'argv'))).toBe(false);
  });

  it('never rewrites a lifecycle --device (resume) to --host, even at >=0.2.1', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-host-life-'));
    temps.push(home);
    writeUpdateCache(home);
    const devicesDir = writeDeviceRegistry(home, ['box']);
    const bin = stubSessionsVersioned('0.2.1');
    const r = runAgents(['sessions', 'resume', '--help', '--device', 'box'], REPO_ROOT, home, {
      SESSIONS_BIN: bin,
      AGENTS_DEVICES_DIR: devicesDir,
      AGENTS_NO_AUTOPULL: '1',
    });
    expect(r.stdout).not.toContain('STUB_SESSIONS_OK');
    expect(fs.existsSync(path.join(path.dirname(bin), 'argv'))).toBe(false);
  });

  it('does not intercept resume — that stays on the in-repo engine', () => {
    const bin = stubSessions();
    const r = spawnSync('bun', [INDEX, 'sessions', 'resume', '--help'], {
      cwd: REPO_ROOT,
      env: { ...process.env, SESSIONS_BIN: bin, AGENTS_NO_AUTOPULL: '1' },
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(r.stdout).not.toContain('STUB_SESSIONS_OK');
  });
});
