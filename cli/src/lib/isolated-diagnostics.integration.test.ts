import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('isolated installs report themselves honestly', () => {
  let home: string;
  const V = '9.9.4';

  const shimsDir = () => path.join(home, '.agents', '.cache', 'shims');

  function plant({ isolated }: { isolated: boolean }) {
    const vdir = path.join(home, '.agents', '.history', 'versions', 'codex', V);
    fs.mkdirSync(path.join(vdir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(vdir, 'home', '.codex'), { recursive: true });
    fs.writeFileSync(path.join(vdir, 'package.json'), '{}');
    fs.writeFileSync(path.join(vdir, 'node_modules', '.bin', 'codex'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(vdir, 'node_modules', '.bin', 'codex'), 0o755);
    fs.mkdirSync(shimsDir(), { recursive: true });
    const alias = path.join(shimsDir(), `codex@${V}`);
    fs.writeFileSync(alias, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(alias, 0o755);
    if (isolated) {
      fs.writeFileSync(path.join(vdir, '.isolated'), 'x\n');
    } else {
      const shim = path.join(shimsDir(), 'codex');
      fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(shim, 0o755);
    }
  }

  function run(...args: string[]): string {
    try {
      return execFileSync('bun', [path.resolve(process.cwd(), 'src/index.ts'), ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          AGENTS_REAL_HOME: home,
          SHELL: '/bin/bash',
          AGENTS_NO_NUDGE: '1',
          FORCE_COLOR: '0',
          AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
          AGENTS_SYNC_MACHINE_ID: 'iso-diag',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString('utf-8');
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
  }
  const json = (...args: string[]) => {
    const out = run(...args);
    return JSON.parse(out.slice(out.indexOf('{')));
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-diag-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('inspect never reports a bare shim an isolated install does not have', () => {
    plant({ isolated: true });
    const d = json('inspect', 'codex', '--json');
    expect(d.shim).toBeNull();
    expect(d.isolated).toBe(true);
    expect(run('inspect', 'codex')).toContain('isolated installs stay off PATH');
  }, 120_000);

  it('inspect still reports the shim a NORMAL install really has', () => {
    plant({ isolated: false });
    const d = json('inspect', 'codex', '--json');
    expect(d.shim).toBe(path.join(shimsDir(), 'codex'));
    expect(fs.existsSync(d.shim)).toBe(true);
    expect(d.isolated).toBe(false);
  }, 120_000);

  it('inspect surfaces the isolated default, which `default` alone cannot', () => {
    plant({ isolated: true });
    expect(run('use', `codex@${V}`)).toContain('ISOLATED');
    const d = json('inspect', 'codex', '--json');
    expect(d.default).toBe(false);
    expect(d.isolatedDefault).toBe(true);
    expect(run('inspect', 'codex')).toContain('[isolated default]');
  }, 120_000);

  it('view --json carries an isolation signal for machine consumers', () => {
    plant({ isolated: true });
    run('use', `codex@${V}`);
    const entry = json('view', 'codex', '--json').versions[0];
    expect(entry.isolated).toBe(true);
    expect(entry.isIsolatedDefault).toBe(true);
    expect(entry.isDefault).toBe(false);
  }, 120_000);

  it('view --json marks a normal install as not isolated', () => {
    plant({ isolated: false });
    const entry = json('view', 'codex', '--json').versions[0];
    expect(entry.isolated).toBe(false);
    expect(entry.isIsolatedDefault).toBe(false);
  }, 120_000);
});
