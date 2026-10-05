import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { foldLegacySystemRepo } from './migrate-fold.js';

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;

let testHome: string;

function setHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  if (testHome && fs.existsSync(testHome)) {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

describe('foldLegacySystemRepo', () => {
  it('no-ops when ~/.agents-system is missing', () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fold-missing-'));
    setHome(testHome);
    expect(() => foldLegacySystemRepo()).not.toThrow();
    expect(fs.existsSync(path.join(testHome, '.agents', '.system'))).toBe(false);
  });

  it('renames a real legacy dir into ~/.agents/.system and leaves a back-compat symlink', () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fold-rename-'));
    setHome(testHome);
    const legacy = path.join(testHome, '.agents-system');
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'hooks', 'x.sh'), '#!/bin/sh\n');

    foldLegacySystemRepo();

    const system = path.join(testHome, '.agents', '.system');
    expect(fs.existsSync(path.join(system, 'hooks', 'x.sh'))).toBe(true);
    const legStat = fs.lstatSync(legacy);
    expect(legStat.isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacy)).toBe(fs.realpathSync(system));
  });

  it('no-ops when ~/.agents-system is already a symlink', () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fold-symlink-'));
    setHome(testHome);
    const system = path.join(testHome, '.agents', '.system');
    fs.mkdirSync(system, { recursive: true });
    fs.writeFileSync(path.join(system, 'kept'), '1');
    fs.symlinkSync(system, path.join(testHome, '.agents-system'));

    foldLegacySystemRepo();

    expect(fs.readFileSync(path.join(system, 'kept'), 'utf-8')).toBe('1');
    expect(fs.lstatSync(path.join(testHome, '.agents-system')).isSymbolicLink()).toBe(true);
  });

  it('merges when both legacy and new paths exist, new wins on collision', () => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-fold-merge-'));
    setHome(testHome);
    const legacy = path.join(testHome, '.agents-system');
    const system = path.join(testHome, '.agents', '.system');
    fs.mkdirSync(path.join(legacy, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(system, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'hooks', 'only-legacy.sh'), 'legacy');
    fs.writeFileSync(path.join(legacy, 'hooks', 'both.sh'), 'from-legacy');
    fs.writeFileSync(path.join(system, 'hooks', 'both.sh'), 'from-system');
    fs.writeFileSync(path.join(system, 'hooks', 'only-system.sh'), 'system');

    foldLegacySystemRepo();

    expect(fs.readFileSync(path.join(system, 'hooks', 'only-legacy.sh'), 'utf-8')).toBe('legacy');
    expect(fs.readFileSync(path.join(system, 'hooks', 'only-system.sh'), 'utf-8')).toBe('system');
    expect(fs.readFileSync(path.join(system, 'hooks', 'both.sh'), 'utf-8')).toBe('from-system');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
  });
});
