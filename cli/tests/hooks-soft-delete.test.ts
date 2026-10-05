/** Tests for hooks soft-delete: removeHookFromVersion moves files to trash and diffVersionHooks
 * classifies them. The state.ts path getters are not injectable, so they are spied on BEFORE
 * importing hooks.ts so ESM live bindings pick them up. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../src/lib/state.js';

// ── Temp roots ────────────────────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), 'agents-cli-hooks-soft-delete-test');
const TEST_VERSIONS_DIR = join(TEST_ROOT, 'versions');
const TEST_TRASH_HOOKS_DIR = join(TEST_ROOT, '.trash', 'hooks');
const TEST_CENTRAL_HOOKS_DIR = join(TEST_ROOT, 'central-hooks');

// Redirect state getters before any module under test is loaded.
vi.spyOn(state, 'getVersionsDir').mockReturnValue(TEST_VERSIONS_DIR);
vi.spyOn(state, 'getTrashHooksDir').mockReturnValue(TEST_TRASH_HOOKS_DIR);
vi.spyOn(state, 'getUserHooksDir').mockReturnValue(TEST_CENTRAL_HOOKS_DIR);

// Import AFTER spies are installed.
import {
  removeHookFromVersion,
  diffVersionHooks,
  getVersionHooksDir,
  listHooksInVersionHome,
} from '../src/lib/hooks/install.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVersionHooksDir(agent: string, version: string): string {
  // Mirrors getVersionHooksDir: <versionsDir>/<agent>/<version>/home/.<agent>/hooks
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
  // Returns the timestamp directories.
  return readdirSync(stampParent);
}

function listTrashFiles(agent: string, version: string, hookName: string): string[] {
  const stamps = listTrashEntries(agent, version, hookName);
  if (stamps.length === 0) return [];
  const stampDir = join(TEST_TRASH_HOOKS_DIR, agent, version, hookName, stamps[0]);
  return readdirSync(stampDir).sort();
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  mkdirSync(TEST_CENTRAL_HOOKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── removeHookFromVersion ─────────────────────────────────────────────────────

describe('removeHookFromVersion – soft-delete', () => {
  it('moves the script file to the trash instead of deleting it', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'my-hook.sh');

    const result = removeHookFromVersion('claude', '2.1.0', 'my-hook');

    expect(result.success).toBe(true);
    // File must be gone from the version home.
    expect(existsSync(join(hooksDir, 'my-hook.sh'))).toBe(false);
    // File must appear in trash.
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

    // Stamp dirs: exactly one entry under the hookName directory.
    const stamps = listTrashEntries('codex', '0.120.0', 'on-tool');
    expect(stamps).toHaveLength(1);
    // Timestamp format: ISO with colons and dots replaced by dashes.
    expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  });

  it('does not move unrelated files that share a directory', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'target-hook.sh');
    writeScript(hooksDir, 'other-hook.sh');

    removeHookFromVersion('claude', '2.1.0', 'target-hook');

    // Other hook must remain.
    expect(existsSync(join(hooksDir, 'other-hook.sh'))).toBe(true);
    // Target hook must be gone.
    expect(existsSync(join(hooksDir, 'target-hook.sh'))).toBe(false);
  });

  it('returns success when the hooks directory does not exist (nothing to remove)', () => {
    // Do NOT create the hooksDir — it should not exist.
    const result = removeHookFromVersion('claude', '9.9.9', 'nonexistent-hook');

    expect(result.success).toBe(true);
    // Trash should be empty because there was nothing to move.
    expect(listTrashEntries('claude', '9.9.9', 'nonexistent-hook')).toHaveLength(0);
  });

  it('returns success when the hook does not exist in an otherwise populated hooks dir', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'other-hook.sh');

    const result = removeHookFromVersion('claude', '2.1.0', 'missing-hook');

    expect(result.success).toBe(true);
    // Nothing trashed — hook name did not match any file.
    expect(listTrashEntries('claude', '2.1.0', 'missing-hook')).toHaveLength(0);
    // Existing hook must be untouched.
    expect(existsSync(join(hooksDir, 'other-hook.sh'))).toBe(true);
  });

  // NTFS does not honor POSIX permission bits, so mkdirSync's mode 0o700 is a
  // no-op on Windows (stat reports 0o666-derived bits). The intent — a
  // private-by-default trash dir — only holds on POSIX.
  it.skipIf(process.platform === 'win32')('creates the trash dir with mode 0o700', () => {
    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    writeScript(hooksDir, 'secure-hook.sh');

    removeHookFromVersion('claude', '2.1.0', 'secure-hook');

    const stamps = listTrashEntries('claude', '2.1.0', 'secure-hook');
    expect(stamps).toHaveLength(1);
    const stampDir = join(TEST_TRASH_HOOKS_DIR, 'claude', '2.1.0', 'secure-hook', stamps[0]);
    const stat = statSync(stampDir);
    // mode & 0o777 isolates the permission bits.
    expect(stat.mode & 0o777).toBe(0o700);
  });
});

// ── diffVersionHooks ──────────────────────────────────────────────────────────

describe('diffVersionHooks – orphan detection', () => {
  it('classifies a hook in the version home but absent from central as an orphan', () => {
    // Central is empty (no hooks written to TEST_CENTRAL_HOOKS_DIR).
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
    // Version home is empty.
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

    // Hook A: in central, not in version → toAdd
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-a.sh', centralContent);
    // Hook B: in both, same content → matched
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-b.sh', centralContent);
    // Hook C: in both, different content → toUpdate
    writeScript(TEST_CENTRAL_HOOKS_DIR, 'hook-c.sh', centralContent);

    const hooksDir = makeVersionHooksDir('claude', '2.1.0');
    // hook-a absent from version home
    writeScript(hooksDir, 'hook-b.sh', centralContent);           // matched
    writeScript(hooksDir, 'hook-c.sh', staleContent);             // toUpdate
    writeScript(hooksDir, 'hook-orphan.sh', staleContent);        // orphan

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
