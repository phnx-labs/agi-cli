/**
 * SelfUpdateService / attemptSelfUpdateAndExit (PHNX-3695).
 *
 * Drives the REAL install path — `npm pack` a tiny fixture package, serve it
 * over a real local HTTP server (standing in for the registry + tarball CDN,
 * following the exact fixture pattern `self-update.test.ts`'s
 * `installPackageIntoPrefix` / `downloadVerifiedTarball` suites use), and
 * install it with the real `installAndVerifyDefault` into a real temp-dir npm
 * prefix. No mocked npm client, no mocked fs/process — only the two boundaries
 * that must be fixture-controlled for a hermetic test (which "latest version"
 * the registry reports, and where "packageRoot" points) are injected, exactly
 * the seam `SelfUpdateDeps` exists for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { needsWindowsShell } from '../platform/index.js';
import { readInstalledVersion } from '../self-update.js';
import type { DaemonContext } from './service.js';
import {
  attemptSelfUpdateAndExit,
  installAndVerifyDefault,
  type SelfUpdateDeps,
} from './self-update-service.js';

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-self-update-svc-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

function sriFor(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

/** Pack a real fixture package at `version` with `npm pack`, and serve its bytes over a real local HTTP server. */
async function packAndServe(version: string): Promise<{ tarballUrl: string; integrity: string }> {
  const src = makeTempDir('dummy-src');
  fs.writeFileSync(
    path.join(src, 'package.json'),
    JSON.stringify({ name: '@agents-cli-test/dummy', version, license: 'MIT' }),
  );
  const tarballName = execFileSync('npm', ['pack', '--silent'], {
    cwd: src,
    encoding: 'utf-8',
    shell: needsWindowsShell('npm'),
  }).trim();
  const bytes = fs.readFileSync(path.join(src, tarballName));
  const integrity = sriFor(bytes);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(bytes);
  });
  servers.push(server);
  const tarballUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}/${tarballName}`);
    });
  });
  return { tarballUrl, integrity };
}

/** A real npm-prefix-shaped install directory at `version`, for `packageRoot()`. */
function makeInstalledPackageRoot(version: string): string {
  const prefix = makeTempDir('prefix');
  const root = path.join(prefix, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: '@agents-cli-test/dummy', version }),
  );
  return root;
}

function makeCtx(): { ctx: DaemonContext; logs: Array<{ level: string; message: string }> } {
  const logs: Array<{ level: string; message: string }> = [];
  return { ctx: { log: (level, message) => logs.push({ level, message }) }, logs };
}

function baseDeps(overrides: Partial<SelfUpdateDeps>): SelfUpdateDeps {
  return {
    currentVersion: () => '1.0.0',
    isDevBuild: () => false,
    detectShadow: () => false,
    packageRoot: () => { throw new Error('packageRoot not stubbed'); },
    fetchLatestMetadata: async () => { throw new Error('fetchLatestMetadata not stubbed'); },
    installAndVerify: async () => { throw new Error('installAndVerify not stubbed'); },
    syncSystemRepo: async () => {},
    syncLocal: async () => {},
    ...overrides,
  };
}

describe('attemptSelfUpdateAndExit', () => {
  it('registry newer -> real install -> verify passes -> reports updated', { timeout: 120_000 }, async () => {
    const { tarballUrl, integrity } = await packAndServe('2.0.0');
    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx, logs } = makeCtx();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '1.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity, tarball: tarballUrl }),
        installAndVerify: installAndVerifyDefault,
      }),
    );

    expect(outcome).toEqual({ updated: true });
    expect(readInstalledVersion(packageRoot)).toBe('2.0.0');
    expect(logs.some((l) => l.level === 'INFO' && /verified 1\.0\.0 -> 2\.0\.0/.test(l.message))).toBe(true);
  });

  it('install failure leaves the old version untouched and reports not updated', async () => {
    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx, logs } = makeCtx();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '1.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity: 'sha512-bogus', tarball: 'http://127.0.0.1:1/nope.tgz' }),
        installAndVerify: async () => { throw new Error('download failed'); },
      }),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('install or verify failed');
    expect(readInstalledVersion(packageRoot)).toBe('1.0.0');
    expect(logs.some((l) => l.level === 'ERROR' && l.message.includes('download failed'))).toBe(true);
  });

  it('a verify mismatch after a real install is surfaced as a failure, not a false success', { timeout: 120_000 }, async () => {
    // The registry claims 2.0.0 but the fixture tarball is actually 3.0.0 —
    // installAndVerifyDefault's verifyInstalledVersion (self-update.ts) must
    // catch the mismatch against the CLAIMED version, exactly like `agents
    // upgrade` would refuse to report success on a wrong install.
    const { tarballUrl, integrity } = await packAndServe('3.0.0');
    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx, logs } = makeCtx();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '1.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity, tarball: tarballUrl }),
        installAndVerify: installAndVerifyDefault,
      }),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('install or verify failed');
    expect(logs.some((l) => l.level === 'ERROR' && /still 3\.0\.0|expected 2\.0\.0/.test(l.message))).toBe(true);
  });

  it('dev build no-ops immediately without checking the registry', async () => {
    const { ctx } = makeCtx();
    const fetchLatestMetadata = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({ isDevBuild: () => true, fetchLatestMetadata }),
    );

    expect(outcome).toEqual({ updated: false, reason: 'dev build — self-update is a no-op' });
    expect(fetchLatestMetadata).not.toHaveBeenCalled();
  });

  it('a shadowed install no-ops immediately without checking the registry', async () => {
    const { ctx } = makeCtx();
    const fetchLatestMetadata = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({ detectShadow: () => true, fetchLatestMetadata }),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toMatch(/shadow/);
    expect(fetchLatestMetadata).not.toHaveBeenCalled();
  });

  it('reports not-updated (no install attempted) when already current', async () => {
    const { ctx } = makeCtx();
    const installAndVerify = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '2.0.0',
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity: 'sha512-x', tarball: 'http://x' }),
        installAndVerify,
      }),
    );

    expect(outcome).toEqual({ updated: false, reason: 'already current (2.0.0)' });
    expect(installAndVerify).not.toHaveBeenCalled();
  });

  it('a registry check failure fails closed with the old version untouched', async () => {
    const { ctx, logs } = makeCtx();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        fetchLatestMetadata: async () => { throw new Error('registry unreachable'); },
      }),
    );

    expect(outcome.updated).toBe(false);
    expect(outcome.reason).toBe('registry check failed');
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('registry unreachable'))).toBe(true);
  });

  it('a deadline abort during a real in-flight install actually kills it, not just abandons the await (PHNX-3695 review)', { timeout: 30_000 }, async () => {
    // A prior version raced the tick's AbortSignal against the download/install
    // promises without ever cancelling the underlying fetch/child process, so a
    // deadline abort left an orphaned `npm install` writing into the shared
    // prefix while the very next attempt started a fresh install into the same
    // directory. installAndVerifyDefault now threads `signal` into
    // downloadVerifiedTarball's own `fetch` option (self-update.ts), which Node
    // aborts for real. Prove that here with a server that stalls the response
    // body indefinitely and observes whether the request socket was actually
    // torn down, not just abandoned by the client.
    const src = makeTempDir('slow-src');
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version: '2.0.0', license: 'MIT' }),
    );
    const tarballName = execFileSync('npm', ['pack', '--silent'], {
      cwd: src,
      encoding: 'utf-8',
      shell: needsWindowsShell('npm'),
    }).trim();
    const bytes = fs.readFileSync(path.join(src, tarballName));
    const integrity = sriFor(bytes);

    let requestAborted = false;
    const server = http.createServer((req, res) => {
      req.on('aborted', () => { requestAborted = true; });
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      // Write a byte then stall — never call res.end() — so the request stays
      // open until either the client aborts it or the test's own server
      // teardown (afterEach) closes the socket.
      res.write(Buffer.from([0]));
    });
    servers.push(server);
    const tarballUrl = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/${tarballName}`);
      });
    });

    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const controller = new AbortController();
    const pending = installAndVerifyDefault(
      { version: '2.0.0', integrity, tarball: tarballUrl },
      packageRoot,
      controller.signal,
    );
    // Give the request time to actually reach the server before aborting.
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();

    await expect(pending).rejects.toThrow();
    // The abort must have reached the real HTTP request (Node's fetch cancels
    // the underlying socket on AbortSignal), not merely stopped the caller
    // from awaiting a still-running download.
    await new Promise((r) => setTimeout(r, 100));
    expect(requestAborted).toBe(true);
    // The old install must remain untouched — nothing here got far enough to
    // touch the package-manager step at all, let alone corrupt it.
    expect(readInstalledVersion(packageRoot)).toBe('1.0.0');
  });

  it('a failed post-install .system/local sync does not undo an already-verified update', { timeout: 120_000 }, async () => {
    const { tarballUrl, integrity } = await packAndServe('2.0.0');
    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx, logs } = makeCtx();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '1.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity, tarball: tarballUrl }),
        installAndVerify: installAndVerifyDefault,
        syncSystemRepo: async () => { throw new Error('no .system repo here'); },
        syncLocal: async () => { throw new Error('reconcile failed'); },
      }),
    );

    expect(outcome).toEqual({ updated: true });
    expect(readInstalledVersion(packageRoot)).toBe('2.0.0');
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('no .system repo here'))).toBe(true);
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('reconcile failed'))).toBe(true);
  });
});
