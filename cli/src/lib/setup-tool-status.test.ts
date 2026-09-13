import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCachedToolSetup, refreshToolSetup, subscribeToolSetup, toolReadiness } from './setup-tool-status.js';

describe('standalone setup metadata and explicit health checks', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-setup-'));
    process.env.PATH = path.join(root, 'bin');
    fs.mkdirSync(process.env.PATH);
    for (const tool of ['BROWSER', 'COMPUTER', 'SECRETS']) delete process.env[`${tool}_BIN`];
  });
  afterEach(() => { process.env = saved; fs.rmSync(root, { recursive: true, force: true }); });
  const opts = () => ({ cacheDir: root });

  it.skipIf(process.platform === 'win32')('detects missing tools without running commands and rejects the legacy browser shim', () => {
    expect(getCachedToolSetup(opts()).map((r) => r.installed)).toEqual([false, false, false]);
    const legacy = path.join(root, 'dist', 'browser.js');
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(legacy, '#!/bin/sh\nexit 88\n', { mode: 0o755 });
    fs.symlinkSync(legacy, path.join(root, 'bin', 'browser'));
    expect(getCachedToolSetup(opts())[0].installed).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('reads package version through the executable symlink and invalidates changed installs', async () => {
    const dir = path.join(root, 'package');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const executable = path.join(dir, 'bin', 'secrets');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 88\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@phnx-labs/secrets-cli', version: '1.2.3' }));
    fs.symlinkSync(executable, path.join(root, 'bin', 'secrets'));
    const [checked] = await refreshToolSetup('secrets', opts());
    expect(checked).toMatchObject({ installed: true, version: '1.2.3', readiness: 'unknown' });
    expect(checked.checkedAtMs).toBeTypeOf('number');
    expect(getCachedToolSetup(opts())[2].checkedAtMs).toBe(checked.checkedAtMs);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@phnx-labs/secrets-cli', version: '1.2.4' }));
    expect(getCachedToolSetup(opts())[2]).toMatchObject({ version: '1.2.4', checkedAtMs: null });
  });

  it('turns a real failed executable check into unknown without confusing absence', async () => {
    fs.linkSync(process.execPath, path.join(root, 'bin', process.platform === 'win32' ? 'browser.exe' : 'browser'));
    const [row] = await refreshToolSetup('browser', opts());
    expect(row).toMatchObject({ installed: true, readiness: 'unknown' });
    expect(row.checkedAtMs).toBeTypeOf('number');
    expect(getCachedToolSetup(opts())[0]).toEqual(row);
  });

  it('publishes install changes through filesystem events and unsubscribes', async () => {
    const changes: ReturnType<typeof getCachedToolSetup>[] = [];
    let stop = () => {};
    const changed = new Promise<void>((resolve) => {
      stop = subscribeToolSetup((rows) => { changes.push(rows); resolve(); }, opts());
    });
    try {
      fs.linkSync(process.execPath, path.join(root, 'bin', process.platform === 'win32' ? 'computer.exe' : 'computer'));
      expect(getCachedToolSetup(opts())[1].installed).toBe(true);
      await changed;
    } finally { stop(); }
    expect(changes).toHaveLength(1);
    expect(changes[0][1].installed).toBe(true);
  });

  it('resolves npm command launchers to their JavaScript entrypoint', () => {
    const dir = path.join(root, 'bin', 'node_modules', '@phnx-labs', 'secrets-cli');
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    const entry = path.join(dir, 'dist', 'index.js');
    fs.writeFileSync(entry, 'process.exit(88);\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@phnx-labs/secrets-cli', version: '1.2.3', bin: { secrets: 'dist/index.js' } }));
    const launcher = path.join(root, 'bin', 'secrets.cmd');
    fs.writeFileSync(launcher, '@node "%~dp0/node_modules/@phnx-labs/secrets-cli/dist/index.js" %*\n');
    process.env.SECRETS_BIN = launcher;
    expect(getCachedToolSetup(opts())[2]).toMatchObject({ installed: true, executable: entry, version: '1.2.3' });
  });

  it('keeps install, helper state and permission results distinct', () => {
    expect(toolReadiness('computer', { installed: false }).readiness).toBe('needs-setup');
    expect(toolReadiness('computer', { installed: true, running: false }).readiness).toBe('stopped');
    expect(toolReadiness('computer', { running: true, trusted: false }).readiness).toBe('permission-required');
    expect(toolReadiness('computer', { running: true, trusted: true }).readiness).toBe('ready');
    expect(toolReadiness('browser', { running: false }).readiness).toBe('stopped');
    expect(toolReadiness('browser', { ok: false }).readiness).toBe('unknown');
  });
});
