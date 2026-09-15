import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShimsDir } from './state.js';
import {
  SessionsClientError,
  _resetSessionsClientForTest,
  isReadQuery,
  planDeviceHostRead,
  resolveSessionsBin,
  sessionsBinSupportsFilters,
  sessionsBinSupportsHost,
  usesFilterFlags,
  usesHostFlag,
} from './sessions-client.js';

describe('isReadQuery', () => {
  it('sends list/search/id to the standalone', () => {
    expect(isReadQuery(['auth', 'middleware', '--json', '--limit', '5'])).toBe(true);
    expect(isReadQuery(['--json', '--limit', '5'])).toBe(true);
    expect(isReadQuery(['a1b2c3d4', '--json'])).toBe(true);
    expect(isReadQuery(['--local', '--limit', '20'])).toBe(true);
  });

  it('keeps the picker, lifecycle verbs, and unimplemented flags on the in-repo engine', () => {
    expect(isReadQuery([])).toBe(false);
    expect(isReadQuery(['resume', 'a1b2c3d4'])).toBe(false);
    expect(isReadQuery(['--active'])).toBe(false);
    expect(isReadQuery(['--markdown', 'a1b2c3d4'])).toBe(false);
    expect(isReadQuery(['watch', '--json'])).toBe(false);
    expect(isReadQuery(['--device', 'mac-mini'])).toBe(false);
    expect(isReadQuery(['--since', '7d', '--json'])).toBe(false);
    expect(isReadQuery(['-D', 'yosemite-s1', 'auth'])).toBe(false);
    expect(isReadQuery(['--waiting'])).toBe(false);
    expect(isReadQuery(['render'])).toBe(false);
    expect(isReadQuery(['stats'])).toBe(false);
    expect(isReadQuery(['--all'])).toBe(false);
    expect(isReadQuery(['--project', 'agents-cli'])).toBe(false);
    expect(isReadQuery(['migrations'])).toBe(false);
    expect(isReadQuery(['detach'])).toBe(false);
    expect(isReadQuery(['--help'])).toBe(false);
    expect(isReadQuery(['--agent', 'claude', '--version', '2.1.181'])).toBe(false);
  });

  it('routes the 0.2.0 filter flags only when the binary supports them', () => {
    // Conservative default (filters:false) — an old/absent binary keeps them in-repo.
    expect(isReadQuery(['--project', 'agents-cli'])).toBe(false);
    expect(isReadQuery(['--since', '7d', '--json'])).toBe(false);
    expect(isReadQuery(['--sort', 'cost'])).toBe(false);
    expect(isReadQuery(['--claude', '--json'])).toBe(false);
    expect(isReadQuery(['-p', 'agents-cli'])).toBe(false);
    expect(isReadQuery(['-a', 'claude@2.1.181'])).toBe(false);

    // filters:true (binary >= 0.2.0) — they route to the standalone.
    expect(isReadQuery(['--project', 'agents-cli'], { filters: true })).toBe(true);
    expect(isReadQuery(['--since', '7d', '--json'], { filters: true })).toBe(true);
    expect(isReadQuery(['--until', '1d'], { filters: true })).toBe(true);
    expect(isReadQuery(['--sort', 'cost'], { filters: true })).toBe(true);
    expect(isReadQuery(['--sort=duration', '--json'], { filters: true })).toBe(true);
    expect(isReadQuery(['--claude', '--json'], { filters: true })).toBe(true);
    expect(isReadQuery(['-p', 'agents-cli'], { filters: true })).toBe(true);
    expect(isReadQuery(['-a', 'claude@2.1.181'], { filters: true })).toBe(true);
    expect(isReadQuery(['--agent', 'claude@2.1.181', '--since', '7d'], { filters: true })).toBe(true);
  });

  it('keeps lifecycle verbs on the in-repo engine even with filters enabled', () => {
    expect(isReadQuery(['resume', 'a1b2c3d4'], { filters: true })).toBe(false);
    expect(isReadQuery(['--device', 'mac-mini'], { filters: true })).toBe(false);
    expect(isReadQuery(['watch', '--json'], { filters: true })).toBe(false);
  });

  it('routes the 0.2.1 `--host` flag only when the binary supports it', () => {
    // Conservative default (host:false) — an old/absent binary keeps `--host` in-repo.
    expect(isReadQuery(['auth', '--host', 'box'])).toBe(false);
    expect(isReadQuery(['auth', '--host=box'])).toBe(false);
    // filters:true but host:false — a 0.2.0 binary takes filters, NOT `--host`.
    expect(isReadQuery(['auth', '--host', 'box'], { filters: true })).toBe(false);

    // host:true (binary >= 0.2.1) — the query routes to the standalone.
    expect(isReadQuery(['auth', '--host', 'box'], { host: true })).toBe(true);
    expect(isReadQuery(['auth', '--host=box', '--json'], { host: true })).toBe(true);
    expect(isReadQuery(['a1b2c3d4', '--host', 'box'], { host: true })).toBe(true);
    // `--host` composes with the filter flags when both are enabled.
    expect(
      isReadQuery(['--project', 'agents-cli', '--host', 'box'], { filters: true, host: true }),
    ).toBe(true);
    // Lifecycle verbs still stay in-repo even with `--host` recognized.
    expect(isReadQuery(['resume', 'a1b2c3d4', '--host', 'box'], { host: true })).toBe(false);
  });
});

describe('usesFilterFlags', () => {
  it('detects only the 0.2.0 filter flags', () => {
    for (const args of [
      ['--project', 'x'],
      ['--project=x'],
      ['--since', '7d'],
      ['--until', '1d'],
      ['--sort', 'cost'],
      ['-p', 'x'],
      ['-a', 'claude'],
      ['--claude'],
      ['--grok', '--json'],
    ]) {
      expect(usesFilterFlags(args)).toBe(true);
    }
    for (const args of [
      ['--json', '--limit', '5'],
      ['--agent', 'claude'],
      ['auth', 'middleware'],
      ['a1b2c3d4'],
      ['--host', 'box'], // `--host` is NOT a filter flag — it has its own predicate/floor
      [],
    ]) {
      expect(usesFilterFlags(args)).toBe(false);
    }
  });
});

describe('planDeviceHostRead', () => {
  it('strips --device from a read query and returns the device + read args', () => {
    expect(planDeviceHostRead(['auth', '--device', 'box', '--json'])).toEqual({
      device: 'box',
      readArgs: ['auth', '--json'],
    });
    // -D short form, and the device value positioned last.
    expect(planDeviceHostRead(['a1b2c3d4', '-D', 'box'])).toEqual({
      device: 'box',
      readArgs: ['a1b2c3d4'],
    });
    // --device=value and -Dvalue glued forms.
    expect(planDeviceHostRead(['auth', '--device=box', '--json'])).toEqual({
      device: 'box',
      readArgs: ['auth', '--json'],
    });
    expect(planDeviceHostRead(['auth', '-Dbox'])).toEqual({
      device: 'box',
      readArgs: ['auth'],
    });
  });

  it('routes the 0.2.0 filter flags alongside --device only when filters are supported', () => {
    // filters:false (old/absent binary) — a device query using a 0.2.0 filter is
    // NOT a standalone read; it stays on the in-repo engine.
    expect(planDeviceHostRead(['--since', '7d', '--device', 'box'])).toBeNull();
    // filters:true — the stripped read is recognized, so it plans the rewrite.
    expect(planDeviceHostRead(['--since', '7d', '--device', 'box'], { filters: true })).toEqual({
      device: 'box',
      readArgs: ['--since', '7d'],
    });
  });

  it('returns null when there is no --device to rewrite', () => {
    expect(planDeviceHostRead(['auth', '--json'])).toBeNull();
    expect(planDeviceHostRead([])).toBeNull();
  });

  it('returns null when an explicit --host is already present (--host wins)', () => {
    expect(planDeviceHostRead(['auth', '--device', 'box', '--host', 'other'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device', 'box', '--host=other'])).toBeNull();
  });

  it('never rewrites a lifecycle --device (resume/watch/etc.)', () => {
    expect(planDeviceHostRead(['resume', 'a1b2c3d4', '--device', 'box'])).toBeNull();
    expect(planDeviceHostRead(['watch', '--device', 'box', '--json'])).toBeNull();
    expect(planDeviceHostRead(['stats', '--device', 'box'])).toBeNull();
  });

  it('never collapses a MULTI-device query — --host is point-to-one (stays on the in-repo fan-out)', () => {
    // A trailing bare token is commander's variadic second device.
    expect(planDeviceHostRead(['auth', '--device', 'box', 'mac-mini', '--json'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device=box', 'mac-mini'])).toBeNull();
    expect(planDeviceHostRead(['auth', '-D', 'box', 'mac-mini'])).toBeNull();
    // The flag repeated is multi-device too.
    expect(planDeviceHostRead(['auth', '--device', 'box', '--device', 'mac-mini'])).toBeNull();
    expect(planDeviceHostRead(['auth', '-D', 'box', '-D', 'mac-mini'])).toBeNull();
    // Fan-out sentinels, case-insensitive.
    expect(planDeviceHostRead(['auth', '--device', 'all'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device', 'fleet', '--json'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device', 'ALL'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device=Fleet'])).toBeNull();
    // A missing / flag-shaped value is not a device.
    expect(planDeviceHostRead(['auth', '--device'])).toBeNull();
    expect(planDeviceHostRead(['auth', '--device', '--json'])).toBeNull();
  });

  it('still collapses the clean single-device forms (one occurrence, one value, no trailing bare token)', () => {
    // A following FLAG (not a bare token) is fine — variadic stops at the flag.
    expect(planDeviceHostRead(['auth', '--device', 'box', '--json'])).toEqual({
      device: 'box',
      readArgs: ['auth', '--json'],
    });
    expect(planDeviceHostRead(['auth', '--device', 'box'])).toEqual({
      device: 'box',
      readArgs: ['auth'],
    });
    expect(planDeviceHostRead(['auth', '--device=box', '--json'])).toEqual({
      device: 'box',
      readArgs: ['auth', '--json'],
    });
    expect(planDeviceHostRead(['auth', '-Dbox'])).toEqual({ device: 'box', readArgs: ['auth'] });
  });
});

describe('usesHostFlag', () => {
  it('detects the 0.2.1 `--host` flag and nothing else', () => {
    for (const args of [['--host', 'box'], ['--host=box'], ['auth', '--host', 'box', '--json']]) {
      expect(usesHostFlag(args)).toBe(true);
    }
    for (const args of [
      ['--json', '--limit', '5'],
      ['--project', 'x'],
      ['--device', 'mac-mini'],
      ['auth', 'middleware'],
      [],
    ]) {
      expect(usesHostFlag(args)).toBe(false);
    }
  });
});

describe.skipIf(process.platform === 'win32')('sessionsBinSupportsFilters', () => {
  let dir: string;
  const prevBin = process.env.SESSIONS_BIN;

  function fakeSessions(version: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-ver-'));
    const bin = path.join(dir, 'sessions');
    fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.SESSIONS_BIN;
    else process.env.SESSIONS_BIN = prevBin;
    _resetSessionsClientForTest();
  });

  it('is true for a binary at or above the 0.2.0 floor', () => {
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsFilters(fakeSessions('0.2.0'))).toBe(true);
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsFilters(fakeSessions('1.4.2'))).toBe(true);
  });

  it('is false for an older binary or an unreadable version', () => {
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsFilters(fakeSessions('0.1.1'))).toBe(false);
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsFilters(fakeSessions('nonsense'))).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('sessionsBinSupportsHost', () => {
  let dir: string;
  const prevBin = process.env.SESSIONS_BIN;

  function fakeSessions(version: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-host-ver-'));
    const bin = path.join(dir, 'sessions');
    fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.SESSIONS_BIN;
    else process.env.SESSIONS_BIN = prevBin;
    _resetSessionsClientForTest();
  });

  it('is true for a binary at or above the 0.2.1 floor', () => {
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsHost(fakeSessions('0.2.1'))).toBe(true);
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsHost(fakeSessions('1.4.2'))).toBe(true);
  });

  it('is false below the host floor even when filters are supported (0.2.0)', () => {
    // The load-bearing safety case: a 0.2.0 binary takes the filters but must NOT
    // receive a `--host` query.
    _resetSessionsClientForTest();
    const bin = fakeSessions('0.2.0');
    expect(sessionsBinSupportsHost(bin)).toBe(false);
    expect(sessionsBinSupportsFilters(bin)).toBe(true);
  });

  it('is false for an older binary or an unreadable version (fail-safe)', () => {
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsHost(fakeSessions('0.1.1'))).toBe(false);
    _resetSessionsClientForTest();
    expect(sessionsBinSupportsHost(fakeSessions('nonsense'))).toBe(false);
  });
});

describe('resolveSessionsBin', () => {
  describe.skipIf(process.platform === 'win32')(
    "never resolves to the legacy shim in agents-cli's own shims dir",
    () => {
      let realDir: string;
      let shimsDir: string;
      const prevPath = process.env.PATH;
      const prevBin = process.env.SESSIONS_BIN;

      beforeEach(() => {
        shimsDir = getShimsDir();
        fs.mkdirSync(shimsDir, { recursive: true });
        const shim = path.join(shimsDir, 'sessions');
        fs.writeFileSync(
          shim,
          `#!/bin/sh\nAGENTS_BIN='/opt/agents-cli/dist/index.js'\nexec "$AGENTS_BIN" sessions "$@"\n`,
        );
        fs.chmodSync(shim, 0o755);
        realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-real-bin-'));
        const real = path.join(realDir, 'sessions');
        fs.writeFileSync(real, '#!/bin/sh\necho standalone\n');
        fs.chmodSync(real, 0o755);
        delete process.env.SESSIONS_BIN;
        _resetSessionsClientForTest();
      });

      afterEach(() => {
        fs.rmSync(path.join(shimsDir, 'sessions'), { force: true });
        fs.rmSync(realDir, { recursive: true, force: true });
        process.env.PATH = prevPath;
        if (prevBin === undefined) delete process.env.SESSIONS_BIN;
        else process.env.SESSIONS_BIN = prevBin;
        _resetSessionsClientForTest();
      });

      it('skips the shim and resolves the standalone further down PATH', () => {
        process.env.PATH = [shimsDir, realDir].join(path.delimiter);
        _resetSessionsClientForTest();
        expect(resolveSessionsBin()).toBe(fs.realpathSync(path.join(realDir, 'sessions')));
      });

      it('reports SESSIONS_BIN_MISSING when the shim is the only sessions on PATH', () => {
        process.env.PATH = shimsDir;
        _resetSessionsClientForTest();
        try {
          resolveSessionsBin();
          throw new Error('expected resolveSessionsBin to throw');
        } catch (error) {
          expect(error).toBeInstanceOf(SessionsClientError);
          expect((error as SessionsClientError).code).toBe('SESSIONS_BIN_MISSING');
        }
      });
    },
  );
});
