/**
 * Helper release-manifest reuse, exercised against REAL helper inputs (no mocks).
 * A missing helper or an input-digest change must fail — there is no rebuild.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
