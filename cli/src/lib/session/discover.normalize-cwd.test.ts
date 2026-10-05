
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { _normalizeCwdForTest as normalizeCwd } from './discover.js';

describe('normalizeCwd', () => {
  it('returns empty for a missing cwd', () => {
    expect(normalizeCwd(undefined)).toBe('');
    expect(normalizeCwd('')).toBe('');
  });

  it('resolves a relative path against the process cwd', () => {
    const out = normalizeCwd('.');
    expect(path.isAbsolute(out)).toBe(true);
  });

  it('strips a trailing separator so exact and prefix matching agree', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'normcwd-')));
    try {
      expect(normalizeCwd(dir + path.sep)).toBe(dir);
      expect(normalizeCwd(dir)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('collapses . and .. in an absolute path', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'normcwd-')));
    try {
      const noisy = path.join(dir, 'sub', '..', '.');
      expect(normalizeCwd(noisy)).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never invents a drive letter for a foreign absolute path', () => {
    const foreign = '/home/ubuntu/definitely-not-here-9f3a/app';
    const out = normalizeCwd(foreign);
    expect(out).not.toMatch(/^[a-zA-Z]:/);
    expect(out.replace(/\\/g, '/')).toBe(foreign);
  });

  it('keeps a foreign path stable across repeated normalization', () => {
    const foreign = '/var/data/proj/';
    const once = normalizeCwd(foreign);
    expect(normalizeCwd(once)).toBe(once);
  });

  it('never rebases a foreign Windows-rooted path onto this process cwd (RUSH-2358)', () => {
    const foreign = 'C:\\Users\\dev\\repo\\.agents\\worktrees\\my-feature';
    const out = normalizeCwd(foreign);
    expect(out).not.toContain(process.cwd());
    expect(out.replace(/\//g, '\\')).toBe(foreign);
  });
});
