// Tests for the install-staging self-heal check (PHNX-3393): removes an orphaned npm reify staging
// dir, with a 10-minute age guard so a live reify is never touched.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as selfUpdate from '../../self-update.js';
import { installStagingCheck, STALE_INSTALL_STAGING_AGE_MS } from './install-staging.js';

const ctx = { dryRun: false, mode: 'safe' } as never;
const dryRunCtx = { dryRun: true, mode: 'safe' } as never;

const tempDirs: string[] = [];
function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `install-staging-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** touch mtime to `ageMs` in the past, matching how a real crash-orphaned dir ages. */
function ageDir(dirPath: string, ageMs: number): void {
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(dirPath, past, past);
}

/** Point resolveRunningPackageRoot at a fixed root for the duration of one test. */
function stubRunningPackageRoot(packageRoot: string): void {
  vi.spyOn(selfUpdate, 'resolveRunningPackageRoot').mockReturnValue(packageRoot);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('install-staging check', () => {
  it('removes a staging dir older than the age guard', async () => {
    const scopeDir = makeTempDir('scope');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);
    const stagingPath = path.join(scopeDir, '.agents-cli-abcd1234');
    fs.mkdirSync(stagingPath);
    fs.writeFileSync(path.join(stagingPath, 'package.json'), '{}');
    ageDir(stagingPath, STALE_INSTALL_STAGING_AGE_MS + 60_000);
    stubRunningPackageRoot(packageRoot);

    const r = await installStagingCheck.run(ctx);

    expect(r.ok).toBe(false);
    expect(r.fixed).toHaveLength(1);
    expect(r.fixed[0]).toContain(stagingPath);
    expect(fs.existsSync(stagingPath)).toBe(false);
    // The live package itself is never touched.
    expect(fs.existsSync(packageRoot)).toBe(true);
  });

  it('never touches a staging dir younger than the age guard — a concurrent live reify', async () => {
    const scopeDir = makeTempDir('scope-live');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);
    const stagingPath = path.join(scopeDir, '.agents-cli-deadbeef');
    fs.mkdirSync(stagingPath);
    // Freshly created — well inside the age guard window.
    stubRunningPackageRoot(packageRoot);

    const r = await installStagingCheck.run(ctx);

    expect(r.ok).toBe(true);
    expect(fs.existsSync(stagingPath)).toBe(true);
  });

  it('reports what it would remove under dryRun without touching disk', async () => {
    const scopeDir = makeTempDir('scope-dry');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);
    const stagingPath = path.join(scopeDir, '.agents-cli-11111111');
    fs.mkdirSync(stagingPath);
    ageDir(stagingPath, STALE_INSTALL_STAGING_AGE_MS + 60_000);
    stubRunningPackageRoot(packageRoot);

    const r = await installStagingCheck.run(dryRunCtx);

    expect(r.fixed).toHaveLength(1);
    expect(fs.existsSync(stagingPath)).toBe(true);
  });

  it('stays silent when not an npm/bun-managed install (source checkout)', async () => {
    vi.spyOn(selfUpdate, 'resolveRunningPackageRoot').mockImplementation(() => {
      throw new Error('not inside a node_modules tree');
    });

    const r = await installStagingCheck.run(ctx);
    expect(r.ok).toBe(true);
  });

  it('leaves an unrelated dotfile and a differently-named sibling alone', async () => {
    const scopeDir = makeTempDir('scope-safe');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);
    const unrelated = path.join(scopeDir, '.DS_Store');
    fs.writeFileSync(unrelated, '');
    ageDir(unrelated, STALE_INSTALL_STAGING_AGE_MS + 60_000);
    const otherPkg = path.join(scopeDir, '.some-other-pkg-abcd1234');
    fs.mkdirSync(otherPkg);
    ageDir(otherPkg, STALE_INSTALL_STAGING_AGE_MS + 60_000);
    stubRunningPackageRoot(packageRoot);

    const r = await installStagingCheck.run(ctx);

    expect(r.ok).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.existsSync(otherPkg)).toBe(true);
  });
});
