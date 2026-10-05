/** The installation record is the frozen identity of an install. These tests pin that it is
 * minted once and never re-minted, migration infers the release from a pre-frozen dir name, and
 * a newer CLI's record is refused. Real filesystem, HOME redirected. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let home: string;

async function load() {
  vi.resetModules();
  return import('./store.js');
}

function versionDir(label: string, agent = 'claude'): string {
  return path.join(home, '.agents', '.history', 'versions', agent, label);
}

function makeVersionDir(label: string, agent = 'claude'): string {
  const dir = versionDir(label, agent);
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  return dir;
}

describe('installation store', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-installations-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('mints an opaque id that is not derived from the release', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const created = store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(created.id).toMatch(/^ins_[0-9a-f]{24}$/);
    expect(created.id).not.toContain('2.0.65');
    expect(created.label).toBe('2.0.65');
    expect(created.releaseVersion).toBe('2.0.65');
    expect(created.history).toEqual([{ releaseVersion: '2.0.65', at: created.createdAt }]);
    expect(fs.existsSync(path.join(versionDir('2.0.65'), 'installation.json'))).toBe(true);
  });

  it('keeps the same id when the install path runs again — a repair must not re-mint identity', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const first = store.createInstallation('claude', '2.0.65', '2.0.65');
    const second = store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(second.id).toBe(first.id);
    expect(second.history).toHaveLength(1);
  });

  it('migrates a pre-frozen version dir by reading its release from the directory name', async () => {
    const store = await load();
    const dir = makeVersionDir('1.9.0');
    expect(fs.existsSync(path.join(dir, 'installation.json'))).toBe(false);
    const dirCreated = fs.statSync(dir).mtime.toISOString();

    const migrated = store.ensureInstallation('claude', '1.9.0');
    expect(migrated.label).toBe('1.9.0');
    expect(migrated.releaseVersion).toBe('1.9.0');
    expect(migrated.createdAt).toBe(dirCreated);

    expect((await load()).ensureInstallation('claude', '1.9.0').id).toBe(migrated.id);
  });

  it('refuses to describe an installation whose directory does not exist', async () => {
    const store = await load();
    expect(() => store.ensureInstallation('claude', '9.9.9')).toThrow(/No installation directory/);
  });

  it('moves the release forward while preserving id, label and creation time', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const created = store.createInstallation('claude', '2.0.65', '2.0.65');
    const updated = store.recordRelease(created, '2.1.220');

    expect(updated.id).toBe(created.id);
    expect(updated.label).toBe('2.0.65');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.releaseVersion).toBe('2.1.220');
    expect(updated.history.map((h) => h.releaseVersion)).toEqual(['2.0.65', '2.1.220']);

    expect((await load()).readInstallation('claude', '2.0.65')?.releaseVersion).toBe('2.1.220');
  });

  it('resolves duplicate installations of the same release to the ONE managed installation (PHNX-3940)', async () => {
    const store = await load();
    makeVersionDir('main');
    makeVersionDir('2.0.65-b');
    const main = store.createInstallation('claude', 'main', '2.0.65');
    store.createInstallation('claude', '2.0.65-b', '2.0.65');

    const listed = store.listInstallations('claude');
    expect(listed.map((i) => i.label)).toEqual(['2.0.65-b', 'main']);
    expect(listed.every((i) => i.releaseVersion === '2.0.65')).toBe(true);
    expect(store.resolveManagedInstallation('claude')?.id).toBe(main.id);
  });

  it('resolves the managed installation through the global default when no main label exists', async () => {
    const store = await load();
    makeVersionDir('acct-work');
    makeVersionDir('2.0.65');
    store.createInstallation('claude', 'acct-work', '2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');

    expect(store.resolveManagedInstallation('claude')?.label).toBe('2.0.65');

    const { setGlobalDefault } = await import('./versions.js');
    setGlobalDefault('claude', 'acct-work');
    expect(store.resolveManagedInstallation('claude')?.label).toBe('acct-work');
  });

  it('never resolves an isolated copy as the managed installation', async () => {
    const store = await load();
    makeVersionDir('main');
    makeVersionDir('2.1.112');
    store.createInstallation('claude', 'main', '2.1.112');
    store.createInstallation('claude', '2.1.112', '2.1.112');
    store.markVersionIsolated('claude', '2.1.112');
    expect(store.resolveManagedInstallation('claude')?.label).toBe('main');

    store.markVersionIsolated('claude', 'main');
    expect(store.resolveManagedInstallation('claude')).toBeNull();
  });

  it('returns the existing managed installation from ensureHarnessInstallation without touching it', async () => {
    const store = await load();
    makeVersionDir('main');
    const created = store.createInstallation('claude', 'main', '2.0.65');

    const ensured = await store.ensureHarnessInstallation('claude');
    expect(ensured.installed).toBe(false);
    expect(ensured.installation.id).toBe(created.id);
    const again = await store.ensureHarnessInstallation('claude', { release: '9.9.9' });
    expect(again.installed).toBe(false);
    expect(again.installation.releaseVersion).toBe('2.0.65');
  });

  it('does not list a HOME-shaped slot dir (no binary, no record) as an installation', async () => {
    const store = await load();
    makeVersionDir('acct-slot-1');
    expect(store.listInstalledVersions('claude')).toEqual([]);
    expect(fs.existsSync(path.join(versionDir('acct-slot-1'), 'installation.json'))).toBe(false);
  });

  it('keeps a pre-frozen install (binary, no record) listed without writing on a read surface (issue #2058)', async () => {
    const store = await load();
    const dir = versionDir('2.0.65');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\n');

    expect(store.listInstalledVersions('claude')).toEqual(['2.0.65']);
    // `agents view` enumerates through this function and must leave every version home byte-
    // identical: record migration belongs to the record-based paths, never a read (the first
    // version migrated on sight and broke this invariant in CI).
    expect(fs.existsSync(path.join(dir, 'installation.json'))).toBe(false);
  });

  it('refuses a record written by a newer schema instead of misreading it', async () => {
    const store = await load();
    const dir = makeVersionDir('2.0.65');
    store.createInstallation('claude', '2.0.65', '2.0.65');
    const file = path.join(dir, 'installation.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, schema: 99 }));

    expect(() => store.readInstallation('claude', '2.0.65')).toThrow(/newer agents-cli/);
  });

  it('persists an explicit release pin at creation and preserves it through repair and updates', async () => {
    const store = await load();
    makeVersionDir('2.0.65');
    const created = store.createInstallation('claude', '2.0.65', '2.0.65', 'pinned');
    expect(created.updatePolicy).toBe('pinned');
    expect(store.readInstallation('claude', '2.0.65')?.updatePolicy).toBe('pinned');
    expect(store.createInstallation('claude', '2.0.65', '2.0.65').updatePolicy).toBe('pinned');
    expect(store.recordRelease(created, '2.1.220').updatePolicy).toBe('pinned');
    makeVersionDir('main');
    expect(store.createInstallation('claude', 'main', '2.1.220').updatePolicy).toBe('latest');
  });

  it('refuses a corrupted record instead of silently minting a replacement', async () => {
    const store = await load();
    const dir = makeVersionDir('2.0.65');
    fs.writeFileSync(path.join(dir, 'installation.json'), '{ not json');

    expect(() => store.ensureInstallation('claude', '2.0.65')).toThrow(/not valid JSON/);
  });

  it('rejects a label that could escape the versions directory', async () => {
    const store = await load();
    expect(() => store.createInstallation('claude', '../escape', '1.0.0')).toThrow(/Invalid installation label/);
  });

  it('refuses an unknown update policy instead of treating it as automatic', async () => {
    const store = await load();
    makeVersionDir('main', 'codex');
    const record = store.createInstallation('codex', 'main', '0.153.4');
    fs.writeFileSync(path.join(versionDir('main', 'codex'), 'installation.json'),
      JSON.stringify({ ...record, updatePolicy: 'future-policy' }));
    expect(() => store.readInstallation('codex', 'main')).toThrow(/unknown update policy/);
  });
});

describe.runIf(process.env.AGENTS_LIVE_UPDATE_TEST === '1')('ensureHarnessInstallation — live install path', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ensure-install-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    delete process.env.HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('installs the requested release into main when absent, then reuses it untouched', async () => {
    const store = await load();
    const first = await store.ensureHarnessInstallation('codex', { release: '0.147.0' });
    expect(first.installed).toBe(true);
    expect(first.installation.label).toBe('main');
    expect(first.installation.releaseVersion).toBe('0.147.0');
    expect(first.installation.updatePolicy).toBe('pinned');
    expect(fs.existsSync(path.join(home, '.agents', '.history', 'versions', 'codex', 'main', 'installation.json'))).toBe(true);

    const second = await store.ensureHarnessInstallation('codex');
    expect(second.installed).toBe(false);
    expect(second.installation.id).toBe(first.installation.id);
    console.log(`LIVE PROOF: ensureHarnessInstallation installed codex@main (release ${first.installation.releaseVersion}) and reused it untouched`);
  }, 600_000);
});
