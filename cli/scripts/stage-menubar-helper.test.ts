/**
 * stage-menubar-helper.sh — stages the PUBLISHED AGI Menu helper (PHNX-4036).
 *
 * The helper's source left this repo for phnx-labs/agi-menu, so nothing here can
 * build it; the only thing a release or a developer can do is fetch the signed
 * bundle the helper's own release published on `menubar/v<floor>` and verify it.
 * These tests EXECUTE the script (no mocks):
 *
 *  - against a real local HTTP server serving a fixture "release", so the sha256
 *    gate, the optional provenance sidecar, the 404 path, and the off-macOS
 *    refusal are all exercised offline and deterministically;
 *  - against the REAL published release at the floor in helper-versions.ts, when
 *    the network is reachable — the test that proves the address the script
 *    resolves is the one that actually serves the helper, and (on macOS) that the
 *    published bundle passes codesign + Gatekeeper + the DR-pin gate end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { helperFloor } from '../src/lib/helper-versions.js';

const CLI_ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(CLI_ROOT, 'scripts/stage-menubar-helper.sh');
const VERIFY = path.join(CLI_ROOT, 'scripts/verify-menubar-helper.sh');
const HELPER_VERSIONS = path.join(CLI_ROOT, 'src/lib/helper-versions.ts');

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

const roots: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A cli/-shaped dir holding only what the script reads: the two scripts + the floor table. */
function fixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'menubar-stage-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  for (const s of [STAGE, VERIFY]) {
    fs.copyFileSync(s, path.join(root, 'scripts', path.basename(s)));
    fs.chmodSync(path.join(root, 'scripts', path.basename(s)), 0o755);
  }
  fs.copyFileSync(HELPER_VERSIONS, path.join(root, 'src/lib/helper-versions.ts'));
  return root;
}

/** Serve a directory over real HTTP (404 for anything absent) and record every request path. */
async function serve(dir: string): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const file = path.join(dir, path.basename(req.url ?? ''));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200);
    res.end(fs.readFileSync(file));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests };
}

/** A fixture "release": zip bytes, the .sha256 the publisher writes, and optionally the provenance sidecar. */
function publish(dir: string, opts: { sidecar?: boolean; wrongSha?: boolean } = {}): { zip: Buffer } {
  fs.mkdirSync(dir, { recursive: true });
  const zip = Buffer.from(`PK fixture bundle bytes ${Math.random()}`);
  fs.writeFileSync(path.join(dir, 'MenubarHelper.app.zip'), zip);
  const sha = opts.wrongSha ? 'f'.repeat(64) : sha256(zip);
  fs.writeFileSync(path.join(dir, 'MenubarHelper.app.zip.sha256'), `${sha}  MenubarHelper.app.zip\n`);
  if (opts.sidecar) {
    fs.writeFileSync(
      path.join(dir, 'menubar-source.txt'),
      'repo=phnx-labs/agi-menu\ncommit=0123456789abcdef0123456789abcdef01234567\ntag=v9.9.9\nversion=9.9.9\n',
    );
  }
  return { zip };
}

/**
 * Run the script asynchronously. The fixture HTTP server lives in THIS process,
 * so a spawnSync here would block the event loop the server needs to answer —
 * the script's curl would wait on a socket nobody services.
 */
function run(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(root, 'scripts/stage-menubar-helper.sh'), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, out: `${stdout}${stderr}` }));
  });
}

const FLOOR = helperFloor('menubar');
const PUBLISHED_SHA_URL = `https://github.com/phnx-labs/agi-cli/releases/download/menubar/v${FLOOR}/MenubarHelper.app.zip.sha256`;

/** Real reachability of the published address; the live tests skip (never fake) without it. */
function publishedReleaseReachable(): boolean {
  const r = spawnSync(
    'curl',
    ['-sSIL', '--connect-timeout', '10', '--max-time', '30', '-o', '/dev/null', '-w', '%{http_code}', PUBLISHED_SHA_URL],
    { encoding: 'utf-8' },
  );
  return r.status === 0 && /^2\d\d$/.test(r.stdout.trim());
}
const ONLINE = process.platform !== 'win32' && publishedReleaseReachable();

describeUnix('stage-menubar-helper.sh', () => {
  it("--print-floor is the CLI's own menubar floor (helperFloor), not a second parser", async () => {
    const r = await run(fixture(), ['--print-floor']);
    expect(r.status, r.out).toBe(0);
    expect(r.stdout.trim()).toBe(FLOOR);
    expect(FLOOR).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('fetches the zip + .sha256 + provenance sidecar, verifies the sha, and reports it as JSON', async () => {
    const root = fixture();
    const release = path.join(root, 'release');
    const { zip } = publish(release, { sidecar: true });
    const { url, requests } = await serve(release);
    const dl = path.join(root, 'dl');

    const r = await run(root, ['--fetch-only', '--json', '--base-url', url, '--download-dir', dl]);
    expect(r.status, r.out).toBe(0);
    const info = JSON.parse(r.stdout);
    expect(info.helper).toBe('menubar');
    expect(info.floor).toBe(FLOOR);
    expect(info.tag).toBe(`menubar/v${FLOOR}`);
    expect(info.assetUrl).toBe(`${url}/MenubarHelper.app.zip`);
    expect(info.sha256).toBe(sha256(zip));
    expect(info.app).toBeNull(); // --fetch-only never extracts
    expect(info.source).toEqual({
      repo: 'phnx-labs/agi-menu',
      commit: '0123456789abcdef0123456789abcdef01234567',
      tag: 'v9.9.9',
      version: '9.9.9',
    });
    // The bytes on disk are the served bytes, at the path the JSON names.
    expect(fs.readFileSync(info.zip)).toEqual(zip);
    expect(requests).toEqual([
      '/MenubarHelper.app.zip.sha256',
      '/MenubarHelper.app.zip',
      '/menubar-source.txt',
    ]);
  });

  it('records no provenance when the release predates the sidecar (a 404 there is not an error)', async () => {
    const root = fixture();
    const release = path.join(root, 'release');
    publish(release, { sidecar: false });
    const { url } = await serve(release);
    const r = await run(root, ['--fetch-only', '--json', '--base-url', url, '--download-dir', path.join(root, 'dl')]);
    expect(r.status, r.out).toBe(0);
    expect(JSON.parse(r.stdout).source).toBeNull();
  });

  it('fails closed when the downloaded bytes do not match the published .sha256', async () => {
    const root = fixture();
    const release = path.join(root, 'release');
    publish(release, { wrongSha: true });
    const { url } = await serve(release);
    const r = await run(root, ['--fetch-only', '--json', '--base-url', url, '--download-dir', path.join(root, 'dl')]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('sha256 mismatch');
    expect(r.out).toContain('refusing to stage the wrong bytes');
    expect(r.stdout.trim()).toBe(''); // no JSON on failure — a caller parsing it must not see a half-record
  });

  it('fails closed when the release has no assets, naming the agi-menu publish step', async () => {
    const root = fixture();
    const release = path.join(root, 'release');
    fs.mkdirSync(release);
    const { url } = await serve(release);
    const r = await run(root, ['--fetch-only', '--base-url', url, '--download-dir', path.join(root, 'dl')]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`no MenubarHelper.app.zip.sha256 on release menubar/v${FLOOR}`);
    expect(r.out).toContain('phnx-labs/agi-menu');
    expect(r.out).toContain('helper-versions.ts');
  });

  it('refuses to stage an extracted bundle off macOS, before downloading anything', async () => {
    // A real Linux box has no codesign/spctl, so an extracted bundle could never
    // be verified there. The script must say so up front rather than download
    // 2 MB and then die — and must not touch bin/. `uname` is stubbed on PATH
    // so this runs the genuine branch on a macOS test host too.
    const root = fixture();
    const release = path.join(root, 'release');
    publish(release);
    const { url, requests } = await serve(release);
    const fakebin = path.join(root, 'fakebin');
    fs.mkdirSync(fakebin);
    fs.writeFileSync(path.join(fakebin, 'uname'), '#!/usr/bin/env bash\necho Linux\n');
    fs.chmodSync(path.join(fakebin, 'uname'), 0o755);

    const r = await run(root, ['--base-url', url, '--download-dir', path.join(root, 'dl')], {
      PATH: `${fakebin}:${process.env.PATH}`,
    });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('needs macOS');
    expect(r.out).toContain('--fetch-only');
    expect(requests).toEqual([]);
    expect(fs.existsSync(path.join(root, 'bin/MenubarHelper.app'))).toBe(false);
  });

  it('rejects an unknown flag instead of silently ignoring it', async () => {
    const r = await run(fixture(), ['--rebuild']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('unknown argument: --rebuild');
  });
});

describeUnix('stage-menubar-helper.sh against the PUBLISHED release', () => {
  // These hit https://github.com/phnx-labs/agi-cli/releases/download/menubar/v<floor>/
  // for real. They skip — never stub — when that address is unreachable, so an
  // offline run stays green without pretending the release was checked.
  it.skipIf(!ONLINE)(
    `downloads menubar/v${FLOOR} and its sha256 matches the published .sha256`,
    async () => {
      const root = fixture();
      const dl = path.join(root, 'dl');
      const r = await run(root, ['--fetch-only', '--json', '--download-dir', dl]);
      expect(r.status, r.out).toBe(0);
      const info = JSON.parse(r.stdout);
      expect(info.tag).toBe(`menubar/v${FLOOR}`);
      expect(info.assetUrl).toBe(
        `https://github.com/phnx-labs/agi-cli/releases/download/menubar/v${FLOOR}/MenubarHelper.app.zip`,
      );
      const published = fs.readFileSync(path.join(dl, 'MenubarHelper.app.zip.sha256'), 'utf-8').split(/\s+/)[0];
      expect(info.sha256).toBe(published);
      expect(sha256(fs.readFileSync(info.zip))).toBe(published);
      // A zip, not an HTML error page that happened to hash consistently.
      expect(fs.readFileSync(info.zip).subarray(0, 2).toString('latin1')).toBe('PK');
    },
    300_000,
  );

  it.skipIf(!ONLINE || process.platform !== 'darwin')(
    'stages the published bundle into bin/ and it passes codesign, Gatekeeper, and the DR-pin gate',
    async () => {
      const root = fixture();
      const r = await run(root, ['--json', '--download-dir', path.join(root, 'dl')]);
      expect(r.status, r.out).toBe(0);
      const info = JSON.parse(r.stdout);
      expect(info.app).toBe(path.join(root, 'bin/MenubarHelper.app'));
      expect(fs.existsSync(path.join(info.app, 'Contents/MacOS/AGI Menu'))).toBe(true);
      // The stapled notarization ticket verify-menubar-helper.sh requires.
      expect(fs.existsSync(path.join(info.app, 'Contents/CodeResources'))).toBe(true);
      // Re-running replaces the bundle in place rather than nesting a second
      // copy inside it (the "unsealed contents" corruption).
      const again = await run(root, ['--json', '--download-dir', path.join(root, 'dl')]);
      expect(again.status, again.out).toBe(0);
      expect(fs.existsSync(path.join(info.app, 'MenubarHelper.app'))).toBe(false);
    },
    600_000,
  );
});
