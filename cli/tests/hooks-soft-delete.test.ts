
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../src/lib/state.js';


const TEST_ROOT = join(tmpdir(), 'agents-cli-hooks-soft-delete-test');
const TEST_VERSIONS_DIR = join(TEST_ROOT, 'versions');
const TEST_TRASH_HOOKS_DIR = join(TEST_ROOT, '.trash', 'hooks');
const TEST_CENTRAL_HOOKS_DIR = join(TEST_ROOT, 'central-hooks');

vi.spyOn(state, 'getVersionsDir').mockReturnValue(TEST_VERSIONS_DIR);
vi.spyOn(state, 'getTrashHooksDir').mockReturnValue(TEST_TRASH_HOOKS_DIR);
vi.spyOn(state, 'getUserHooksDir').mockReturnValue(TEST_CENTRAL_HOOKS_DIR);

import {
  removeHookFromVersion,
  diffVersionHooks,
  getVersionHooksDir,
  listHooksInVersionHome,
} from '../src/lib/hooks/install.js';


function makeVersionHooksDir(agent: string, version: string): string {
  const dir = join(TEST_VERSIONS_DIR, agent, version, 'home', `.${agent}`, 'hooks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeScript(dir: string, filename: string, content = '#!/bin/sh\necho hi'): string {
  const p = join(dir, filename);
  writeFileSync(p, content);
  chmodSync(p, 0o755);
  return p;
}

function writeData(dir: string, filename: string, content = 'data: true'): string {
  const p = join(dir, filename);
  writeFileSync(p, content);
  return p;
}

function listTrashEntries(agent: string, version: string, hookName: string): string[] {
  const stampParent = join(TEST_TRASH_HOOKS_DIR, agent, version, hookName);
  if (!existsSync(stampParent)) return [];
  return readdirSync(stampParent);
}

function listTrashFiles(agent: string, version: string, hookName: string): string[] {
  const stamps = listTrashEntries(agent, version, hookName);
  if (stamps.length === 0) return [];
  const stampDir = join(TEST_TRASH_HOOKS_DIR, agent, version, hookName, stamps[0]);
  return readdirSync(stampDir).sort();
}


beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  mkdirSync(TEST_CENTRAL_HOOKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});


describe('removeHookFromVersion – soft-delete', () => {
  it('moves the script file to the trash instead of deleting it', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'my-hook.sh');

    const result = removeHookFromVersion('claude', '2.1.0', 'my-hook');

    expect(result.success).toBe(true);
    expect(existsSync(join(hooksDir, 'my-hook.sh'))).toBe(false);
    const trashed = listTrashFiles('claude', '2.1.0', 'my-hook');
    expect(trashed).toContain('my-hook.sh');
  });

  it('moves both script and data files when they share the same basename', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'expand-promptcuts.sh');
    writeData(hooksDir, 'expand-promptcuts.yaml');

    const result = removeHookFromVersion('claude', '2.1.0', 'expand-promptcuts');

    expect(result.success).toBe(true);
    expect(existsSync(join(hooksDir, 'expand-promptcuts.sh'))).toBe(false);
    expect(existsSync(join(hooksDir, 'expand-promptcuts.yaml'))).toBe(false);

    const trashed = listTrashFiles('claude', '2.1.0', 'expand-promptcuts');
    expect(trashed).toContain('expand-promptcuts.sh');
    expect(trashed).toContain('expand-promptcuts.yaml');
  });

  it('uses the correct trash directory structure: .trash/hooks/<agent>/<version>/<hookName>/<timestamp>/', () => {
    const hooksDir = makeVersionHooksDir('codex', '0.120.0');
    writeScript(hooksDir, 'on-tool.sh');

    removeHookFromVersion('codex', '0.120.0', 'on-tool');

    const stamps = listTrashEntries('codex', '0.120.0', 'on-tool');
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it('does not move unrelated files that share a directory', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'target-hook.sh');
    writeScript(hooksDir, 'other-hook.sh');

    removeHookFromVersion('claude', '2.1.0', 'target-hook');

    expect(existsSync(join(hooksDir, 'other-hook.sh'))).toBe(true);
    expect(existsSync(join(hooksDir, 'target-hook.sh'))).toBe(false);
  });

  it('returns success when the hooks directory does not exist (nothing to remove)', () => {
    const result = removeHookFromVersion('claude', '9.9.9', 'nonexistent-hook');

    expect(result.success).toBe(true);
    expect(listTrashEntries('claude', '9.9.9', 'nonexistent-hook')).toHaveLength(0);
  });

  it('returns success when the hook does not exist in an otherwise populated hooks dir', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'other-hook.sh');

    const result = removeHookFromVersion('claude', '2.1.0', 'missing-hook');

    expect(result.success).toBe(true);
    expect(listTrashEntries('claude', '2.1.0', 'missing-hook')).toHaveLength(0);
    expect(existsSync(join(hooksDir, 'other-hook.sh'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('creates the trash dir with mode 0o700', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'secure-hook.sh');

    removeHookFromVersion('claude', '2.1.0', 'secure-hook');

    const stamps = listTrashEntries('claude', '2.1.0', 'secure-hook');
    expect(stamps).toHaveLength(1);
    const stampDir = join(TEST_TRASH_HOOKS_DIR, 'claude', '2.1.0', 'secure-hook', stamps[0]);
    const stat = statSync(stampDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });
});


describe('diffVersionHooks – orphan detection', () => {
  it('classifies a hook in the version home but absent from central as an orphan', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'stale-hook.sh');

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.orphans).toContain('stale-hook');
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.matched).toHaveLength(0);
  });

  it('classifies a hook in central but absent from version home as toAdd', () => {
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'new-hook.sh');
    makeVersionHooksDir('claude', '2.1.0');

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.toAdd).toContain('new-hook');
    expect(diff.orphans).toHaveLength(0);
  });

  it('classifies a hook present in both with different content as toUpdate', () => {
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'updated-hook.sh', '#!/bin/sh\necho new');
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'updated-hook.sh', '#!/bin/sh\necho old');

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.toUpdate).toContain('updated-hook');
    expect(diff.orphans).toHaveLength(0);
    expect(diff.toAdd).toHaveLength(0);
  });

  it('classifies a hook present in both with identical content as matched', () => {
    const content = '#!/bin/sh\necho same';
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'synced-hook.sh', content);
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'synced-hook.sh', content);

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.matched).toContain('synced-hook');
    expect(diff.orphans).toHaveLength(0);
    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it('returns all four categories correctly when mixed state exists', () => {
    const centralContent = '#!/bin/sh\necho central';
    const staleContent = '#!/bin/sh\necho stale';

    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-a.sh', centralContent);
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-b.sh', centralContent);
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-c.sh', centralContent);

    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'hook-b.sh', centralContent);
    writeScript(hooksDir, 'hook-c.sh', staleContent);
    writeScript(hooksDir, 'hook-orphan.sh', staleContent);

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.toAdd).toEqual(['hook-a']);
    expect(diff.matched).toContain('hook-b');
    expect(diff.toUpdate).toEqual(['hook-c']);
    expect(diff.orphans).toEqual(['hook-orphan']);
  });

  it('returns empty diff when both central and version home are empty', () => {
    makeVersionHooksDir('claude', '2.1.0');

    const diff = diffVersionHooks('claude', '2.1.0');

    expect(diff.toAdd).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.matched).toHaveLength(0);
    expect(diff.orphans).toHaveLength(0);
  });
});
