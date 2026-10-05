import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated installs never become normal defaults or credential homes.
describe.skipIf(process.platform === 'win32')('isolated default', () => {
  let home: string;
  const A = '9.9.4';
  const B = '9.9.5';

  const versionDir = (v: string) => path.join(home, '.agents', '.history', 'versions', 'codex', v);
  const devicesDir = () => path.join(home, '.agents', '.history', 'devices');
  const devicePins = () => {
    const dir = devicesDir();
    if (!fs.existsSync(dir)) return '';
    const pins = fs.readdirSync(dir).filter((n) => n.startsWith('pins-') && n.endsWith('.json'));
    return pins.length ? path.join(dir, pins[0]) : '';
  };
  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');

  function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: home,
      AGENTS_REAL_HOME: home,
      AGENTS_DEVICES_DIR: devicesDir(),
      AGENTS_SYNC_MACHINE_ID: 'testbox',
      SHELL: '/bin/bash',
      AGENTS_NO_NUDGE: '1',
      FORCE_COLOR: '0',
      ...extra,
    };
  }

  function plant(v: string, { isolated = true } = {}) {
    const binDir = path.join(versionDir(v), 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'codex'), 0o755);
    fs.mkdirSync(path.join(versionDir(v), 'home', '.codex'), { recursive: true });
    if (isolated) fs.writeFileSync(path.join(versionDir(v), '.isolated'), '2026-07-30T00:00:00.000Z\n');
  }

  function run(...args: string[]): { out: string; status: number } {
    try {
      const out = execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
      return { out, status: 0 };
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
    }
  }

  function resolved(): string | null {
    const script = `
      import { resolveVersion } from ${JSON.stringify(path.resolve(process.cwd(), 'src/lib/installations/versions.ts'))};
      console.log('__R__' + JSON.stringify(resolveVersion('codex')));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString();
    return JSON.parse(out.split('__R__')[1]);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-default-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('a bare agent name resolves to nothing until an isolated default is set', () => {
    plant(A);
    expect(resolved()).toBeNull();

    expect(run('use', `codex@${A}`).status).toBe(0);
    expect(resolved()).toBe(A);
  }, 120_000);

  it('sets the pointer WITHOUT adopting: no global default, no bare shim, no config symlink', () => {
    plant(A);
    expect(run('use', `codex@${A}`).status).toBe(0);

    const pinsPath = devicePins();
    expect(pinsPath).not.toBe('');
    const pins = fs.readFileSync(pinsPath, 'utf-8');
    expect(pins).toContain('isolatedAgents');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8'))
      .not.toContain('isolatedAgents');
    const shims = fs.existsSync(shimsDir()) ? fs.readdirSync(shimsDir()) : [];
    expect(shims).not.toContain('codex');
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    expect(JSON.parse(pins).agents?.codex).toBeUndefined();
  }, 120_000);

  it('a global default still wins — the isolated pointer is only a fallback', () => {
    plant(A);
    plant(B, { isolated: false });
    expect(run('use', `codex@${A}`).status).toBe(0);
    expect(run('use', `codex@${B}`).status).toBe(0);
    expect(resolved()).toBe(B);
  }, 120_000);

  it('a removed isolated default falls back to a surviving isolated copy', () => {
    plant(A);
    plant(B);
    expect(run('use', `codex@${B}`).status).toBe(0);
    expect(resolved()).toBe(B);

    expect(run('remove', `codex@${B}`, '--isolated').status).toBe(0);
    expect(resolved()).toBe(A);
  }, 180_000);

  it('a dangling pointer never resolves to a missing install', () => {
    plant(A);
    expect(run('use', `codex@${A}`).status).toBe(0);
    fs.rmSync(versionDir(A), { recursive: true, force: true });
    expect(resolved()).toBeNull();
  }, 120_000);

  it('agents view labels which isolated copy is the default', () => {
    plant(A);
    plant(B);
    expect(run('view', 'codex', '--versions').out).toContain('(no default)');

    expect(run('use', `codex@${B}`).status).toBe(0);
    const out = run('view', 'codex', '--versions').out;
    expect(out).toContain(`${B} (isolated default)`);
    expect(out).toContain(`${A} (isolated)`);
    expect(out).not.toContain('(no default)');
  }, 120_000);

  it('refuses to pin an isolated copy as a --project version', () => {
    plant(A);
    const r = run('use', `codex@${A}`, '--project');
    expect(r.out).toContain('--project pins are for shared versions');
  }, 120_000);
});
