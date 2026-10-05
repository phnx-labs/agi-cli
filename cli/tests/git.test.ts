import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import simpleGit from 'simple-git';
import { pullRepo } from '../src/lib/git.js';

let TEST_DIR: string;
let REMOTE_DIR: string;
let LOCAL_DIR: string;

describe('pullRepo', () => {
  beforeEach(async () => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'agents-cli-git-test-'));
    REMOTE_DIR = join(TEST_DIR, 'remote');
    LOCAL_DIR = join(TEST_DIR, 'local');

    mkdirSync(REMOTE_DIR, { recursive: true });
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.init(false);
    await remoteGit.addConfig('user.name', 'Test User');
    await remoteGit.addConfig('user.email', 'test@example.com');
    writeFileSync(join(REMOTE_DIR, 'README.md'), '# Test');
    await remoteGit.add('.');
    await remoteGit.commit('initial');

    mkdirSync(LOCAL_DIR, { recursive: true });
    await simpleGit().clone(REMOTE_DIR, LOCAL_DIR);
    const localGit = simpleGit(LOCAL_DIR);
    await localGit.addConfig('user.name', 'Test User');
    await localGit.addConfig('user.email', 'test@example.com');
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('fast-forwards when local is behind origin', async () => {
    writeFileSync(join(REMOTE_DIR, 'new-file.md'), '# New');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('add new file');

    const before = await simpleGit(LOCAL_DIR).revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await simpleGit(LOCAL_DIR).revparse(['HEAD']);

    expect(result.success).toBe(true);
    expect(result.commit).toBeTruthy();
    expect(result.error).toBeUndefined();
    expect(after).not.toBe(before);
    expect(
      await simpleGit(LOCAL_DIR).revparse(['HEAD']),
    ).toBe(await remoteGit.revparse(['HEAD']));
  });

  it('reports success when already up to date', async () => {
    const before = await simpleGit(LOCAL_DIR).revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await simpleGit(LOCAL_DIR).revparse(['HEAD']);

    expect(result.success).toBe(true);
    expect(result.commit).toBeTruthy();
    expect(after).toBe(before);
  });

  it('pulls past uncommitted changes the incoming commits do not touch', async () => {
    writeFileSync(join(LOCAL_DIR, 'dirty.txt'), 'uncommitted change');

    const result = await pullRepo(LOCAL_DIR);

    expect(result.success).toBe(true);
    expect(readFileSync(join(LOCAL_DIR, 'dirty.txt'), 'utf8')).toBe('uncommitted change');
  });

  it('refuses when an incoming commit touches the modified tracked file', async () => {
    writeFileSync(join(REMOTE_DIR, 'README.md'), '# Upstream edit\n');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('upstream edits README');
    writeFileSync(join(LOCAL_DIR, 'README.md'), '# Modified');

    const result = await pullRepo(LOCAL_DIR);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked by local changes');
    expect(result.error).toContain('README.md');
    expect(readFileSync(join(LOCAL_DIR, 'README.md'), 'utf8')).toBe('# Modified');
  });

  it('rebases a diverged branch instead of refusing when nothing conflicts', async () => {
    writeFileSync(join(REMOTE_DIR, 'remote-only.txt'), 'remote');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('remote commit');

    writeFileSync(join(LOCAL_DIR, 'local-only.txt'), 'local');
    const localGit = simpleGit(LOCAL_DIR);
    await localGit.add('.');
    await localGit.commit('local commit');

    const result = await pullRepo(LOCAL_DIR);

    expect(result.success).toBe(true);
    expect(existsSync(join(LOCAL_DIR, 'remote-only.txt'))).toBe(true);
    expect(existsSync(join(LOCAL_DIR, 'local-only.txt'))).toBe(true);
    const log = await localGit.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('local commit');
  });

  it('rolls the tree back on a genuine conflict, leaving no rebase in progress', async () => {
    writeFileSync(join(REMOTE_DIR, 'shared.txt'), 'remote side');
    const remoteGit = simpleGit(REMOTE_DIR);
    await remoteGit.add('.');
    await remoteGit.commit('remote edit');

    writeFileSync(join(LOCAL_DIR, 'shared.txt'), 'local side');
    const localGit = simpleGit(LOCAL_DIR);
    await localGit.add('.');
    await localGit.commit('local edit');

    const before = await localGit.revparse(['HEAD']);
    const result = await pullRepo(LOCAL_DIR);
    const after = await localGit.revparse(['HEAD']);

    expect(result.success).toBe(false);
    expect(after).toBe(before);
    expect(existsSync(join(LOCAL_DIR, '.git', 'rebase-merge'))).toBe(false);
    const status = await localGit.status();
    expect(status.conflicted).toEqual([]);
  });
});
