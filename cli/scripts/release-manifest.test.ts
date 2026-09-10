/**
 * Helper release-manifest reuse, exercised against REAL helper inputs (no mocks).
 * A missing helper or an input-digest change must fail — there is no rebuild.
 *
 * Two helpers, two kinds of input. computer-mac's input is its Swift source in
 * this repo. menubar's source lives in phnx-labs/agi-menu (PHNX-4036), so its
 * input is the floor pin in cli/src/lib/helper-versions.ts — the one file that
 * decides which published MenubarHelper.app.zip the CLI installs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, 'release-manifest.sh');
const REPO = path.resolve(__dirname, '../..');
const temps: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sh(args: string[]): { status: number; out: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf-8' });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('release-manifest.sh', () => {
  it('input-digest is stable for unchanged computer-mac / menubar inputs', () => {
    for (const helper of ['computer-mac', 'menubar'] as const) {
      const a = sh(['input-digest', '--repo-root', REPO, '--helper', helper]);
      const b = sh(['input-digest', '--repo-root', REPO, '--helper', helper]);
      expect(a.status, a.out).toBe(0);
      expect(a.out.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(a.out.trim()).toBe(b.out.trim());
    }
  });

  it('reuses a helper whose input digest still matches and refuses a missing helper', () => {
    const dir = tmp('rel-manifest-');
    const file = path.join(dir, 'manifest.json');
    const created = sh(['new', '--cli-version', '1.22.40', '--cli-tree', 'abc']);
    expect(created.status, created.out).toBe(0);
    fs.writeFileSync(file, created.out);

    const digest = sh(['input-digest', '--repo-root', REPO, '--helper', 'computer-mac']).out.trim();
    const asset = path.join(dir, 'computer-mac.bin');
    fs.writeFileSync(asset, 'signed-bytes');
    const sha = spawnSync('sha256sum', [asset], { encoding: 'utf-8' });
    const assetDigest =
      sha.status === 0
        ? `sha256:${sha.stdout.trim().split(/\s+/)[0]}`
        : `sha256:${spawnSync('shasum', ['-a', '256', asset], { encoding: 'utf-8' }).stdout.trim().split(/\s+/)[0]}`;

    const put = sh([
      'put',
      '--file',
      file,
      '--helper',
      'computer-mac',
      '--helper-version',
      '3.0.0',
      '--input-digest',
      digest,
      '--asset-digest',
      assetDigest,
      '--asset-path',
      asset,
      '--platform',
      'darwin',
    ]);
    expect(put.status, put.out).toBe(0);

    const reuse = sh(['reuse', '--file', file, '--helper', 'computer-mac', '--input-digest', digest]);
    expect(reuse.status, reuse.out).toBe(0);
    expect(JSON.parse(reuse.out).assetDigest).toBe(assetDigest);

    const missing = sh(['resolve', '--file', file, '--helper', 'menubar']);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('missing helper menubar');
    expect(missing.out).toContain('no fallback rebuild');

    const drifted = sh([
      'reuse',
      '--file',
      file,
      '--helper',
      'computer-mac',
      '--input-digest',
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    ]);
    expect(drifted.status).not.toBe(0);
    expect(drifted.out).toContain('outside the ordinary release path');
  });

  it('require binds live helper inputs and fails when the recorded digest is stale', () => {
    const dir = tmp('rel-manifest-req-');
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, sh(['new', '--cli-version', '1.22.40', '--cli-tree', 'abc']).out);
    const digest = sh(['input-digest', '--repo-root', REPO, '--helper', 'menubar']).out.trim();
    const asset = path.join(dir, 'menu.app');
    fs.writeFileSync(asset, 'menu');
    const sum = spawnSync(process.platform === 'linux' ? 'sha256sum' : 'shasum', 
      process.platform === 'linux' ? [asset] : ['-a', '256', asset], { encoding: 'utf-8' });
    const assetDigest = `sha256:${sum.stdout.trim().split(/\s+/)[0]}`;
    expect(
      sh([
        'put',
        '--file',
        file,
        '--helper',
        'menubar',
        '--helper-version',
        '1.0.0',
        '--input-digest',
        digest,
        '--asset-digest',
        assetDigest,
        '--asset-path',
        asset,
      ]).status,
    ).toBe(0);

    const ok = sh(['require', '--file', file, '--repo-root', REPO, '--helper', 'menubar']);
    expect(ok.status, ok.out).toBe(0);

    const tmpMan = JSON.parse(fs.readFileSync(file, 'utf-8'));
    tmpMan.helpers.menubar.inputDigest =
      'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    fs.writeFileSync(file, JSON.stringify(tmpMan));
    const stale = sh(['require', '--file', file, '--repo-root', REPO, '--helper', 'menubar']);
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain('outside the ordinary release path');
  });

  it("menubar's input digest is the floor pin: it moves with helper-versions.ts and nothing else", () => {
    // A throwaway git repo (input-digest resolves --repo-root through git) that
    // carries ONLY the floor table. No cli/menubar/ source exists anywhere any
    // more, so hashing it would either fail or hash nothing.
    const repo = tmp('rel-manifest-floor-');
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    git('init', '-q');
    const table = path.join(repo, 'cli/src/lib/helper-versions.ts');
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.writeFileSync(table, "export const HELPER_RELEASES = { menubar: { tagPrefix: 'menubar', floor: '1.1.0' } };\n");
    const before = sh(['input-digest', '--repo-root', repo, '--helper', 'menubar']);
    expect(before.status, before.out).toBe(0);
    expect(before.out.trim()).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Something else in the tree changing must NOT move the digest...
    fs.writeFileSync(path.join(repo, 'cli/src/lib/other.ts'), 'export const x = 1;\n');
    expect(sh(['input-digest', '--repo-root', repo, '--helper', 'menubar']).out.trim()).toBe(before.out.trim());
    // ...and a floor bump MUST, so the producer re-records from the new release.
    fs.writeFileSync(table, "export const HELPER_RELEASES = { menubar: { tagPrefix: 'menubar', floor: '1.2.0' } };\n");
    const bumped = sh(['input-digest', '--repo-root', repo, '--helper', 'menubar']);
    expect(bumped.status, bumped.out).toBe(0);
    expect(bumped.out.trim()).not.toBe(before.out.trim());
    // A repo with no floor table at all cannot key the helper -- fail loud.
    fs.rmSync(table);
    const missing = sh(['input-digest', '--repo-root', repo, '--helper', 'menubar']);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain('helper input missing');
  });

  it('put records the published-release provenance as `source` and copy-asset names the menubar zip', () => {
    const dir = tmp('rel-manifest-menubar-');
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, sh(['new', '--cli-version', '1.22.93', '--cli-tree', 'abc']).out);
    const digest = sh(['input-digest', '--repo-root', REPO, '--helper', 'menubar']).out.trim();
    const zip = path.join(dir, 'MenubarHelper.app.zip');
    fs.writeFileSync(zip, 'published-zip-bytes');
    const assetDigest = `sha256:${createHash('sha256').update(fs.readFileSync(zip)).digest('hex')}`;
    const source = JSON.stringify({ repo: 'phnx-labs/agi-menu', commit: 'abc123', tag: 'v1.1.0', version: '1.1.0' });

    // Provenance must be an object: a stray string would leave a reader guessing.
    const bad = sh([
      'put', '--file', file, '--helper', 'menubar', '--helper-version', '1.1.0',
      '--input-digest', digest, '--asset-digest', assetDigest, '--asset-path', zip,
      '--source', 'phnx-labs/agi-menu@abc123',
    ]);
    expect(bad.status).not.toBe(0);
    expect(bad.out).toContain('--source must be a JSON object');

    const put = sh([
      'put', '--file', file, '--helper', 'menubar', '--helper-version', '1.1.0',
      '--input-digest', digest, '--asset-digest', assetDigest, '--asset-path', zip,
      '--asset-url', 'https://github.com/phnx-labs/agi-cli/releases/download/menubar/v1.1.0/MenubarHelper.app.zip',
      '--source', source,
    ]);
    expect(put.status, put.out).toBe(0);
    const rec = JSON.parse(sh(['resolve', '--file', file, '--helper', 'menubar']).out);
    expect(rec.source).toEqual(JSON.parse(source));
    expect(rec.helperVersion).toBe('1.1.0');

    // A record without provenance (a pre-sidecar release) simply has no field.
    const plain = path.join(dir, 'plain.json');
    fs.writeFileSync(plain, sh(['new', '--cli-version', '1.22.93', '--cli-tree', 'abc']).out);
    expect(sh([
      'put', '--file', plain, '--helper', 'menubar', '--helper-version', '1.1.0',
      '--input-digest', digest, '--asset-digest', assetDigest, '--asset-path', zip,
    ]).status).toBe(0);
    expect(JSON.parse(sh(['resolve', '--file', plain, '--helper', 'menubar']).out)).not.toHaveProperty('source');

    // copy-asset attaches the ZIP the CLI downloads (never a bare .app directory).
    const dest = path.join(dir, 'out');
    const copied = sh(['copy-asset', '--file', file, '--helper', 'menubar', '--asset-path', dest]);
    expect(copied.status, copied.out).toBe(0);
    expect(copied.out.trim()).toBe(path.join(dest, 'MenubarHelper.app.zip'));
    expect(fs.readFileSync(copied.out.trim(), 'utf-8')).toBe('published-zip-bytes');
    expect(fs.readFileSync(`${copied.out.trim()}.sha256`, 'utf-8')).toBe(
      `${assetDigest.slice('sha256:'.length)}  MenubarHelper.app.zip\n`,
    );
  });

  it('copy-asset writes the verified helper bytes and refuses a missing asset', () => {
    const dir = tmp('rel-manifest-copy-');
    const file = path.join(dir, 'manifest.json');
    fs.writeFileSync(file, sh(['new', '--cli-version', '1.22.40', '--cli-tree', 'abc']).out);
    const digest = sh(['input-digest', '--repo-root', REPO, '--helper', 'computer-mac']).out.trim();
    const asset = path.join(dir, 'computer-mac-src.bin');
    fs.writeFileSync(asset, 'signed-helper-bytes');
    const sum = spawnSync(process.platform === 'linux' ? 'sha256sum' : 'shasum',
      process.platform === 'linux' ? [asset] : ['-a', '256', asset], { encoding: 'utf-8' });
    const assetDigest = `sha256:${sum.stdout.trim().split(/\s+/)[0]}`;
    expect(
      sh([
        'put',
        '--file',
        file,
        '--helper',
        'computer-mac',
        '--helper-version',
        '3.0.0',
        '--input-digest',
        digest,
        '--asset-digest',
        assetDigest,
        '--asset-path',
        asset,
      ]).status,
    ).toBe(0);
    const dest = path.join(dir, 'out');
    const copied = sh(['copy-asset', '--file', file, '--helper', 'computer-mac', '--asset-path', dest]);
    expect(copied.status, copied.out).toBe(0);
    expect(fs.readFileSync(copied.out.trim())).toEqual(fs.readFileSync(asset));
  });
});
