import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { blocksLocalScripts, computeNewUserPath, npmGlobalBinFromEntry, shouldWriteExpandable } from './winpath.js';

describe('computeNewUserPath', () => {
  const dir = 'C:\\shims';

  it('is a no-op when dir is already the first entry', () => {
    const current = 'C:\\shims;C:\\other';
    expect(computeNewUserPath(current, dir)).toEqual({ changed: false, value: current });
  });

  it('moves dir to the front and dedups when it appears later', () => {
    expect(computeNewUserPath('C:\\other;C:\\shims;C:\\more', dir)).toEqual({
      changed: true,
      value: 'C:\\shims;C:\\other;C:\\more',
    });
  });

  it('prepends when absent', () => {
    expect(computeNewUserPath('C:\\other', dir)).toEqual({ changed: true, value: 'C:\\shims;C:\\other' });
  });

  it('handles an empty current PATH', () => {
    expect(computeNewUserPath('', dir)).toEqual({ changed: true, value: 'C:\\shims' });
  });

  it('preserves %VAR% segments verbatim when prepending', () => {
    expect(computeNewUserPath('%USERPROFILE%\\bin;C:\\other', dir)).toEqual({
      changed: true,
      value: 'C:\\shims;%USERPROFILE%\\bin;C:\\other',
    });
  });

  it('preserves %VAR% segments and dedups when moving dir to the front', () => {
    expect(computeNewUserPath('%USERPROFILE%\\bin;C:\\shims;%SystemRoot%\\System32', dir)).toEqual({
      changed: true,
      value: 'C:\\shims;%USERPROFILE%\\bin;%SystemRoot%\\System32',
    });
  });

  it('drops empty / ;; segments when it changes the value', () => {
    expect(computeNewUserPath('C:\\other;;%USERPROFILE%\\bin;', dir)).toEqual({
      changed: true,
      value: 'C:\\shims;C:\\other;%USERPROFILE%\\bin',
    });
  });

  it('is idempotent — applying the result again is a no-op', () => {
    const first = computeNewUserPath('C:\\other;C:\\shims', dir);
    expect(first.changed).toBe(true);
    const second = computeNewUserPath(first.value, dir);
    expect(second).toEqual({ changed: false, value: first.value });
  });
});

describe('shouldWriteExpandable', () => {
  it('keeps REG_EXPAND_SZ when the original kind was ExpandString', () => {
    expect(shouldWriteExpandable('ExpandString', 'C:\\shims;C:\\other')).toBe(true);
  });

  it('stays REG_SZ for a plain String value with no %', () => {
    expect(shouldWriteExpandable('String', 'C:\\shims;C:\\other')).toBe(false);
  });

  it('upgrades to REG_EXPAND_SZ when the value contains a %VAR% reference', () => {
    expect(shouldWriteExpandable('String', 'C:\\shims;%USERPROFILE%\\bin')).toBe(true);
  });

  it('defaults to REG_EXPAND_SZ when Path was absent (null or Absent)', () => {
    expect(shouldWriteExpandable(null, 'C:\\shims')).toBe(true);
    expect(shouldWriteExpandable('Absent', 'C:\\shims')).toBe(true);
  });
});

// A real HKCU\Environment round-trip needs a Windows host. The pure functions cover the #308 fix;
// the PowerShell primitives are exercised on Windows at install.

describe('blocksLocalScripts', () => {
  it('flags policies that block unsigned local scripts', () => {
    for (const p of ['Restricted', 'AllSigned', 'restricted', 'allsigned', '  Restricted  ']) {
      expect(blocksLocalScripts(p)).toBe(true);
    }
  });

  it('allows policies that permit local scripts', () => {
    for (const p of ['RemoteSigned', 'Bypass', 'Unrestricted', 'Undefined']) {
      expect(blocksLocalScripts(p)).toBe(false);
    }
  });

  it('treats unknown / null policy as non-blocking (no false alarm)', () => {
    expect(blocksLocalScripts(null)).toBe(false);
    expect(blocksLocalScripts('')).toBe(false);
  });
});

describe('npmGlobalBinFromEntry', () => {
  it('resolves the prefix four levels up from dist/index.js', () => {
    const prefix = path.join('opt', 'tools', 'npmglobal');
    const entry = path.join(prefix, 'node_modules', '@phnx-labs', 'agents-cli', 'dist', 'index.js');
    expect(npmGlobalBinFromEntry(entry)).toBe(path.resolve(prefix));
  });
});
