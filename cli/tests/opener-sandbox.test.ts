process.env.AGENTS_TEST_ALLOW_OPENER = '1';

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  assertNoUnauthorizedOpenerSpawn,
  DESKTOP_OPENER_BASENAMES,
  isDesktopOpenerCommand,
  openerSandboxTripped,
} from './opener-sandbox.js';

const stubDir = process.env.AGENTS_TEST_OPENER_STUB_DIR;
const platformOpener = process.platform === 'darwin' ? 'open' : 'xdg-open';

describe('isDesktopOpenerCommand (PHNX-3072)', () => {
  it('matches the platform opener names, including absolute paths', () => {
    expect(isDesktopOpenerCommand('open')).toBe(true);
    expect(isDesktopOpenerCommand('/usr/bin/open')).toBe(true);
    expect(isDesktopOpenerCommand('xdg-open')).toBe(true);
    expect(isDesktopOpenerCommand('/usr/bin/xdg-open')).toBe(true);
    expect(isDesktopOpenerCommand('gnome-open')).toBe(true);
  });

  it('does not match ordinary binaries a test is allowed to spawn', () => {
    expect(isDesktopOpenerCommand('git')).toBe(false);
    expect(isDesktopOpenerCommand('node')).toBe(false);
    expect(isDesktopOpenerCommand('/bin/sleep')).toBe(false);
    expect(isDesktopOpenerCommand('true')).toBe(false);
  });
});

describe('vitest opener sandbox (PHNX-3072)', () => {
  it('PATH is prefixed with the fork-private opener stub dir, not left as the developer PATH', () => {
    expect(stubDir).toBeTruthy();
    expect(path.basename(path.dirname(stubDir as string))).toMatch(/^agents-vitest-/);
    const first = (process.env.PATH ?? '').split(path.delimiter)[0];
    expect(first).toBe(stubDir);
  });

  it('every known opener basename is a real executable stub in that dir', () => {
    expect(stubDir).toBeTruthy();
    for (const name of DESKTOP_OPENER_BASENAMES) {
      const stub = path.join(stubDir as string, process.platform === 'win32' ? `${name}.cmd` : name);
      expect(fs.existsSync(stub), `${name} stub missing at ${stub}`).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(stub).mode & 0o111).toBeTruthy();
      }
    }
  });

  it('spawning the platform opener against a real URL hits the stub (exit 1), not a browser', () => {
    const result = spawnSync(platformOpener, ['https://example.com'], { encoding: 'utf-8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toMatch(/PHNX-3072/);
    expect(String(result.stderr)).toMatch(new RegExp(platformOpener));
  });

  it('spawning every opener name against a URL hits the stub, on both macOS and Linux', () => {
    for (const name of DESKTOP_OPENER_BASENAMES) {
      const result = spawnSync(name, ['https://example.com'], { encoding: 'utf-8' });
      expect(result.error, `${name} should resolve to the stub`).toBeUndefined();
      expect(result.status, `${name} stub must fail loud`).toBe(1);
      expect(String(result.stderr)).toMatch(/PHNX-3072/);
    }
  });

  it('a naive subprocess spawn (env: {...process.env}) inherits the stub PATH for free', () => {
    const script =
      'const {spawnSync}=require("child_process");' +
      `const r=spawnSync(${JSON.stringify(platformOpener)},["https://example.com"],{encoding:"utf-8"});` +
      'process.stdout.write(String(r.status));' +
      'process.stderr.write(r.stderr||"");';
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf-8',
      env: { ...process.env },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('1');
    expect(result.stderr).toMatch(/PHNX-3072/);
  });

  it('non-opener binaries still resolve from the rest of PATH', () => {
    const result = spawnSync('node', ['-e', 'process.stdout.write("ok")'], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  it('the tripwire records the spawn, and the allow flag silences afterAll', () => {
    spawnSync(platformOpener, ['https://example.com'], { encoding: 'utf-8' });
    const log = openerSandboxTripped();
    expect(log).toBeTruthy();
    expect(log as string).toMatch(/example\.com/);

    const prev = process.env.AGENTS_TEST_ALLOW_OPENER;
    delete process.env.AGENTS_TEST_ALLOW_OPENER;
    try {
      expect(() => assertNoUnauthorizedOpenerSpawn()).toThrow(/PHNX-3072/);
    } finally {
      process.env.AGENTS_TEST_ALLOW_OPENER = prev;
    }
    expect(() => assertNoUnauthorizedOpenerSpawn()).not.toThrow();
  });
});

describe('opener stubs do not shadow git (PATH is a prefix, not a cage)', () => {
  it('git still runs', () => {
    const out = execFileSync('git', ['--version'], { encoding: 'utf-8' });
    expect(out).toMatch(/^git version /);
  });
});
