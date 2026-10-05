import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MaterializeGuardError,
  assertExactHarnessVersion,
  assertPortableHarness,
  resolveOutputHome,
} from './output-home.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('assertPortableHarness', () => {
  it('accepts the three portable homes', () => {
    expect(assertPortableHarness('claude')).toBe('claude');
    expect(assertPortableHarness('codex')).toBe('codex');
    expect(assertPortableHarness('opencode')).toBe('opencode');
  });

  it('rejects a non-portable harness, naming it', () => {
    expect(() => assertPortableHarness('gemini')).toThrow(MaterializeGuardError);
    expect(() => assertPortableHarness('gemini')).toThrow(/Unsupported capability.*gemini/i);
  });
});

describe('assertExactHarnessVersion', () => {
  it('accepts an exact version', () => {
    expect(assertExactHarnessVersion('2.1.0')).toBe('2.1.0');
  });

  it('rejects @latest and empty', () => {
    expect(() => assertExactHarnessVersion('latest')).toThrow(/Invalid harness version/);
    expect(() => assertExactHarnessVersion('')).toThrow(/Invalid harness version/);
  });
});

describe('resolveOutputHome', () => {
  it('rejects a path with a .. segment', () => {
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome('/tmp/out/../escape')).toThrow(/Path escape/);
  });

  it('refuses the live ~/.claude directory', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-home-'));
    tempDirs.push(home);
    const live = path.join(home, '.claude');
    fs.mkdirSync(live);
    expect(() => resolveOutputHome(live, process.cwd(), home)).toThrow(/Path escape/);
    expect(() => resolveOutputHome(path.join(live, 'nested'), process.cwd(), home)).toThrow(/Path escape/);
  });

  it('returns an absolute path for a safe target', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-ok-'));
    tempDirs.push(home);
    const out = path.join(home, 'ephemeral');
    expect(resolveOutputHome(out, process.cwd(), home)).toBe(path.resolve(out));
  });

  it('refuses the live home ROOT itself (materializer appends the config dir)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-home-root-'));
    tempDirs.push(home);
    expect(() => resolveOutputHome(home, process.cwd(), home)).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome(home, process.cwd(), home)).toThrow(/must not be the live home directory/);
  });

  it('refuses a symlink whose target is the live home ROOT', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symhome-'));
    tempDirs.push(home);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symlink-'));
    tempDirs.push(linkParent);
    const link = path.join(linkParent, 'alias');
    fs.symlinkSync(home, link);
    expect(() => resolveOutputHome(link, process.cwd(), home)).toThrow(/must not be the live home directory/);
  });

  it('refuses a target inside a symlinked-to-HOME ancestor', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symanc-'));
    tempDirs.push(home);
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-symanc-p-'));
    tempDirs.push(linkParent);
    const link = path.join(linkParent, 'alias');
    fs.symlinkSync(home, link);
    const escaped = path.join(link, '.claude', 'nested');
    expect(() => resolveOutputHome(escaped, process.cwd(), home)).toThrow(/live \.claude directory/);
  });

  it('refuses the live ~/.claude even when ~/.claude ITSELF is a symlink (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-livelink-'));
    tempDirs.push(home);
    const realClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-realclaude-'));
    tempDirs.push(realClaude);
    fs.symlinkSync(realClaude, path.join(home, '.claude'));

    expect(() => resolveOutputHome(realClaude, process.cwd(), home)).toThrow(/live \.claude directory/);
    expect(() => resolveOutputHome(path.join(home, '.claude'), process.cwd(), home)).toThrow(/live \.claude directory/);
    expect(() => resolveOutputHome(path.join(realClaude, 'nested'), process.cwd(), home)).toThrow(/live \.claude directory/);
  });

  it('fails closed — refuses EVERY output home while a live ~/.claude link is dangling (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-dangling-'));
    tempDirs.push(home);
    const absentTarget = path.join(home, 'not-there-yet');
    fs.symlinkSync(absentTarget, path.join(home, '.claude'));

    expect(() => resolveOutputHome(path.join(home, '.claude'), process.cwd(), home)).toThrow(/\.claude home is a dangling symlink/);
    expect(() => resolveOutputHome(absentTarget, process.cwd(), home)).toThrow(/\.claude home is a dangling symlink/);
    const unrelated = path.join(home, 'ephemeral-out');
    expect(() => resolveOutputHome(unrelated, process.cwd(), home)).toThrow(MaterializeGuardError);
    expect(() => resolveOutputHome(unrelated, process.cwd(), home)).toThrow(/\.claude home is a dangling symlink/);
  });

  it('fails closed on a RELATIVE, CHAINED dangling ~/.codex link — refusing an unrelated home too (PHNX-3838)', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-chain-'));
    tempDirs.push(parent);
    const home = path.join(parent, 'home');
    fs.mkdirSync(home);
    fs.symlinkSync('hop1', path.join(home, '.codex'));
    fs.symlinkSync('../evil', path.join(home, 'hop1'));
    const chainEnd = path.join(parent, 'evil');

    expect(() => resolveOutputHome(path.join(home, '.codex'), process.cwd(), home)).toThrow(/\.codex home is a dangling symlink/);
    expect(() => resolveOutputHome(chainEnd, process.cwd(), home)).toThrow(/\.codex home is a dangling symlink/);
    const unrelated = path.join(parent, 'ephemeral-out');
    expect(() => resolveOutputHome(unrelated, process.cwd(), home)).toThrow(/\.codex home is a dangling symlink/);
  });

  it('accepts a distinct output home when the protected homes are NOT dangling (PHNX-3838)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-live-ok-'));
    tempDirs.push(home);
    fs.mkdirSync(path.join(home, '.claude'));
    const realCodex = path.join(home, 'real-codex');
    fs.mkdirSync(realCodex);
    fs.symlinkSync(realCodex, path.join(home, '.codex'));

    const out = path.join(home, 'ephemeral');
    expect(resolveOutputHome(out, process.cwd(), home)).toBe(path.resolve(out));
    expect(() => resolveOutputHome(path.join(home, '.claude'), process.cwd(), home)).toThrow(/live \.claude directory/);
    expect(() => resolveOutputHome(realCodex, process.cwd(), home)).toThrow(/live \.codex directory/);
  });

  it('still allows a non-live directory reached through a benign symlink', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-benign-'));
    tempDirs.push(home);
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'mat-guard-benign-real-'));
    tempDirs.push(real);
    const link = path.join(path.dirname(real), `${path.basename(real)}-link`);
    fs.symlinkSync(real, link);
    tempDirs.push(link);
    const out = path.join(link, 'ephemeral');
    expect(resolveOutputHome(out, process.cwd(), home)).toBe(path.resolve(out));
  });
});
