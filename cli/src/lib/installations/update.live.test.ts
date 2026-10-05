import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

describe.runIf(process.env.AGENTS_LIVE_UPDATE_TEST === '1')('real npm account-home update', () => {
  let root: string | undefined;
  afterEach(() => { vi.unstubAllEnvs(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('updates two Codex account homes to one current release without moving their data', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-update-'));
    vi.stubEnv('HOME', root);
    vi.resetModules();
    const versions = await import('./versions.js');
    const store = await import('./store.js');
    const policy = await import('./update-policy.js');
    const { updateInstallation } = await import('./update.js');
    const latest = await versions.getLatestNpmVersion('codex');
    expect(latest).toBeTruthy();
    const identities: string[] = [];
    for (const label of ['personal', 'work']) {
      const installed = await versions.installVersion('codex', '0.147.0', undefined, { installationLabel: label });
      expect(installed.success, installed.error).toBe(true);
      const before = store.readInstallation('codex', label)!;
      identities.push(before.id);
      const home = versions.getVersionHomePath('codex', label);
      expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(true);
      expect(fs.existsSync(path.join(root!, '.codex', 'hooks.json'))).toBe(false);
      const data = path.join(home, '.codex', 'update-preservation-proof.txt');
      fs.mkdirSync(path.dirname(data), { recursive: true });
      fs.writeFileSync(data, `account-owned data: ${label}`);
      const homeInode = fs.statSync(home).ino;
      await policy.setInstallationUpdatePolicy('codex', label, 'latest');
      const updated = await updateInstallation(before, { to: latest! });
      expect(updated.installation.id).toBe(before.id);
      expect(updated.installation.label).toBe(label);
      expect(updated.installation.releaseVersion).toBe(latest);
      expect(updated.installation.updatePolicy).toBe('latest');
      expect(fs.statSync(home).ino).toBe(homeInode);
      expect(fs.readFileSync(data, 'utf8')).toBe(`account-owned data: ${label}`);
      const binary = versions.getBinaryPath('codex', label);
      const actual = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      expect(actual).toContain(latest!);
      console.log(`LIVE PROOF: ${label}: 0.147.0 -> ${latest}; same installation id, label, home inode, and account data; binary: ${actual.trim()}`);
    }
    expect(new Set(identities).size).toBe(2);
    expect(versions.listInstalledVersions('codex').sort()).toEqual(['personal', 'work']);
  }, 600_000);
});
