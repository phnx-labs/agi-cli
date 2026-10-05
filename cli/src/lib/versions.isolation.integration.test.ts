import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


describe.skipIf(process.platform === 'win32')('ensureAgentRunnable — isolation boundary', () => {
  let home: string;

  const versionDir = (version: string) =>
    path.join(home, '.agents', '.history', 'versions', 'codex', version);

  function plant(version: string, opts: { runnable: boolean; isolated?: boolean }) {
    const dir = versionDir(version);
    const binDir = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
    if (opts.runnable) {
      const bin = path.join(binDir, 'codex');
      fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(bin, 0o755);
    }
    if (opts.isolated) fs.writeFileSync(path.join(dir, '.isolated'), `${new Date().toISOString()}\n`);
  }

  interface Outcome {
    healed: string | null;
    defaultAfter: string | null;
    installedAfter: string[];
    stillIsolated: boolean;
  }

  function runEnsure(
    target: string,
    probeIsolationOf: string,
    opts?: { allowDefaultSwitch?: boolean },
  ): Outcome {
    const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
    const optsArg = opts ? `, undefined, ${JSON.stringify(opts)}` : '';
    const script = `
      import {
        ensureAgentRunnable, getGlobalDefault, listInstalledVersions, isVersionIsolated,
      } from ${JSON.stringify(versionsPath)};
      const healed = await ensureAgentRunnable('codex', ${JSON.stringify(target)}${optsArg});
      console.log('__RESULT__' + JSON.stringify({
        healed,
        defaultAfter: getGlobalDefault('codex'),
        installedAfter: listInstalledVersions('codex'),
        stillIsolated: isVersionIsolated('codex', ${JSON.stringify(probeIsolationOf)}),
      }));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        AGENTS_DEVICES_DIR: path.join(home, '.agents', '.history', 'devices'),
        AGENTS_SYNC_MACHINE_ID: 'testbox',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    return JSON.parse(out.split('__RESULT__')[1]);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-runnable-iso-'));
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('leaves the normal default alone when an ISOLATED target cannot be repaired', () => {
    plant('9.9.1', { runnable: true });
    plant('9.9.3', { runnable: true });
    plant('9.9.2', { runnable: false, isolated: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.2', '9.9.2');

    expect(r.healed).toBeNull();
    expect(r.defaultAfter).toBe('9.9.1');
    expect(r.installedAfter.sort()).toEqual(['9.9.1', '9.9.3']);
    expect(r.stillIsolated).toBe(true);
  }, 180_000);

  it('never adopts an ISOLATED version as the fallback default, but still adopts a normal one', () => {
    plant('9.9.1', { runnable: false });
    plant('9.9.9', { runnable: true, isolated: true });
    plant('9.9.3', { runnable: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.1', '9.9.9');

    expect(r.healed).toBe('9.9.3');
    expect(r.defaultAfter).toBe('9.9.3');
    expect(r.defaultAfter).not.toBe('9.9.9');
    expect(r.stillIsolated).toBe(true);
  }, 180_000);

  it('does not repoint the default in unattended mode (allowDefaultSwitch: false)', () => {
    plant('9.9.1', { runnable: false });
    plant('9.9.3', { runnable: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.1', '9.9.3', { allowDefaultSwitch: false });

    expect(r.healed).toBeNull();
    expect(r.defaultAfter).toBe('9.9.1');
    expect(r.defaultAfter).not.toBe('9.9.3');
  }, 180_000);

  it('still repoints the default in interactive mode (default behavior unchanged)', () => {
    plant('9.9.1', { runnable: false });
    plant('9.9.3', { runnable: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const r = runEnsure('9.9.1', '9.9.3');

    expect(r.healed).toBe('9.9.3');
    expect(r.defaultAfter).toBe('9.9.3');
  }, 180_000);

  it('refuses to pin `latest` when the user holds that exact version as an isolated copy', () => {
    const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
    const latest = execFileSync('npm', ['view', '@openai/codex', 'version'], { encoding: 'utf-8' }).trim();
    expect(latest).toMatch(/^\d+\.\d+\.\d+/);

    plant('9.9.1', { runnable: false });
    plant(latest, { runnable: true, isolated: true });
    fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents:\n  codex: "9.9.1"\n');

    const before = fs.readFileSync(path.join(versionDir(latest), '.isolated'), 'utf-8');
    const r = runEnsure('9.9.1', latest);

    expect(r.healed).toBeNull();
    expect(r.defaultAfter).toBe('9.9.1');
    expect(r.defaultAfter).not.toBe(latest);
    expect(r.stillIsolated).toBe(true);
    expect(fs.readFileSync(path.join(versionDir(latest), '.isolated'), 'utf-8')).toBe(before);
  }, 300_000);
});
