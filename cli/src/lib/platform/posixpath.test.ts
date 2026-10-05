import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureLocalBinSymlink, localBinDir } from './posixpath.js';

describe('localBinDir', () => {
  it('is <home>/.local/bin', () => {
    expect(localBinDir('/home/x')).toBe(path.join('/home/x', '.local', 'bin'));
  });
});

describe('ensureLocalBinSymlink', () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-posixpath-'));
    target = path.join(dir, 'real-entry.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the symlink when nothing is there (and mkdirs the bin dir)', () => {
    const binDir = path.join(dir, '.local', 'bin');
    const res = ensureLocalBinSymlink('agents', target, binDir);
    expect(res).toMatchObject({ ok: true, created: true });
    expect(fs.realpathSync(path.join(binDir, 'agents'))).toBe(fs.realpathSync(target));
  });

  it('is idempotent — a second call does not recreate an already-correct link', () => {
    const first = ensureLocalBinSymlink('agents', target, dir);
    expect(first.created).toBe(true);
    const second = ensureLocalBinSymlink('agents', target, dir);
    expect(second).toMatchObject({ ok: true, created: false });
  });

  it('NEVER clobbers a dev-build symlink that points elsewhere', () => {
    const devBuild = path.join(dir, 'agents-cli-dev', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(devBuild), { recursive: true });
    fs.writeFileSync(devBuild, '#!/usr/bin/env node\n');
    const linkPath = path.join(dir, 'agents');
    fs.symlinkSync(devBuild, linkPath);

    const res = ensureLocalBinSymlink('agents', target, dir);
    expect(res.ok).toBe(false);
    expect(res.created).toBe(false);
    expect(res.skippedReason).toMatch(/points to/);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(devBuild));
  });

  it('NEVER clobbers a real (non-symlink) file at the path', () => {
    const linkPath = path.join(dir, 'agents');
    fs.writeFileSync(linkPath, 'a real binary, not ours');
    const res = ensureLocalBinSymlink('agents', target, dir);
    expect(res).toMatchObject({ ok: false, created: false });
    expect(res.skippedReason).toMatch(/non-symlink/);
    expect(fs.readFileSync(linkPath, 'utf-8')).toBe('a real binary, not ours');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
  });
});
