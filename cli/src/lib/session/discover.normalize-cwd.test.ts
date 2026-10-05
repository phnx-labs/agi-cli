/** `normalizeCwd` runs on both sides of the cwd filter in `db.ts`; the two must normalize
 * identically or the LIKE subdir match returns nothing. It must also survive a FOREIGN path:
 * Windows `path.resolve()` rebased `/Users/me` onto `D:\`. */

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
    // The LIKE subdir wildcard in db.ts appends path.sep to this value; a
    // trailing separator would produce '//' and match nothing.
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
    // The regression: on Windows this used to come back as 'D:\\home\\ubuntu\\app'.
    // The path does not exist on this machine under either OS, so the result must
    // still name the same directory it did in the transcript.
    const foreign = '/home/ubuntu/definitely-not-here-9f3a/app';
    const out = normalizeCwd(foreign);
    expect(out).not.toMatch(/^[a-zA-Z]:/);
    expect(out.replace(/\\/g, '/')).toBe(foreign);
  });

  it('keeps a foreign path stable across repeated normalization', () => {
    // Idempotence is what lets the stored value and the query value agree.
    const foreign = '/var/data/proj/';
    const once = normalizeCwd(foreign);
    expect(normalizeCwd(once)).toBe(once);
  });

  it('never rebases a foreign Windows-rooted path onto this process cwd (RUSH-2358)', () => {
    // Mirror regression: on POSIX a Windows-recorded cwd fell through to path.resolve() and gained
    // THIS process's cwd as prefix, grafting an unrelated directory (and possibly a wrong worktree
    // slug via WORKTREE_RE) onto a synced session.
    const foreign = 'C:\\Users\\dev\\repo\\.agents\\worktrees\\my-feature';
    const out = normalizeCwd(foreign);
    expect(out).not.toContain(process.cwd());
    expect(out.replace(/\//g, '\\')).toBe(foreign);
  });
});
