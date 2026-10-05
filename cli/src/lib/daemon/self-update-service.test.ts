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
  triggerSelfUpdateInBackground,
  type SelfUpdateDeps,
  selfUpdateSyncDeclineReason,
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
    installedVersion: () => '1.0.0',
    installedIsSettled: () => true,
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
    expect(await readInstalledVersion(packageRoot)).toBe('2.0.0');
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
    expect(await readInstalledVersion(packageRoot)).toBe('1.0.0');
    expect(logs.some((l) => l.level === 'ERROR' && l.message.includes('download failed'))).toBe(true);
  });

  it('a verify mismatch after a real install is surfaced as a failure, not a false success', { timeout: 120_000 }, async () => {
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

  it('an install another process already upgraded on disk relaunches without touching the registry or installing', async () => {
    const { ctx, logs } = makeCtx();
    const fetchLatestMetadata = vi.fn();
    const installAndVerify = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({ currentVersion: () => '1.0.0', installedVersion: () => '1.1.0', fetchLatestMetadata, installAndVerify }),
    );

    expect(outcome).toEqual({ updated: true });
    expect(fetchLatestMetadata).not.toHaveBeenCalled();
    expect(installAndVerify).not.toHaveBeenCalled();
    expect(logs.some((l) => l.level === 'INFO' && /on disk is 1\.1\.0 but this daemon is still running 1\.0\.0/.test(l.message))).toBe(true);
  });

  it('a stale install relaunches even when a shadow copy would otherwise decline the tick', async () => {
    const { ctx } = makeCtx();
    const fetchLatestMetadata = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({ detectShadow: () => true, currentVersion: () => '1.0.0', installedVersion: () => '1.0.1', fetchLatestMetadata }),
    );

    expect(outcome).toEqual({ updated: true });
    expect(fetchLatestMetadata).not.toHaveBeenCalled();
    expect(selfUpdateSyncDeclineReason(baseDeps({ detectShadow: () => true, currentVersion: () => '1.0.0', installedVersion: () => '1.0.1' }))).toBeNull();
  });

  it('a newer install that has not settled defers the relaunch instead of exiting into a half-written tree', async () => {
    const { ctx, logs } = makeCtx();
    const fetchLatestMetadata = vi.fn();

    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({ currentVersion: () => '1.0.0', installedVersion: () => '1.1.0', installedIsSettled: () => false, fetchLatestMetadata }),
    );

    expect(outcome).toEqual({ updated: false, reason: 'installed version still settling' });
    expect(fetchLatestMetadata).not.toHaveBeenCalled();
    expect(logs.some((l) => l.level === 'INFO' && /still settling; relaunch deferred/.test(l.message))).toBe(true);
  });

  it('an unknown on-disk version never triggers a relaunch', async () => {
    const { ctx } = makeCtx();
    const outcome = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        installedVersion: () => 'unknown',
        fetchLatestMetadata: async () => ({ version: '1.0.0', integrity: 'sha512-x', tarball: 'http://x' }),
      }),
    );
    expect(outcome).toEqual({ updated: false, reason: 'already current (1.0.0)' });
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
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();

    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(requestAborted).toBe(true);
    expect(await readInstalledVersion(packageRoot)).toBe('1.0.0');
  });

  it('two concurrent callers share one in-flight attempt — a subsequent request never starts a second install (PHNX-3695 review)', { timeout: 30_000 }, async () => {
    let requestCount = 0;
    const src = makeTempDir('dedupe-src');
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
    const server = http.createServer((_req, res) => {
      requestCount++;
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

    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx } = makeCtx();
    const deps = baseDeps({
      currentVersion: () => '1.0.0',
      packageRoot: () => packageRoot,
      fetchLatestMetadata: async () => ({ version: '2.0.0', integrity, tarball: tarballUrl }),
      installAndVerify: installAndVerifyDefault,
    });

    const [first, second] = await Promise.all([
      attemptSelfUpdateAndExit(ctx, new AbortController().signal, deps),
      attemptSelfUpdateAndExit(ctx, new AbortController().signal, deps),
    ]);

    expect(first).toEqual({ updated: true });
    expect(second).toEqual({ updated: true });
    expect(requestCount).toBe(1);
    expect(await readInstalledVersion(packageRoot)).toBe('2.0.0');

    const { tarballUrl: nextUrl, integrity: nextIntegrity } = await packAndServe('3.0.0');
    const third = await attemptSelfUpdateAndExit(
      ctx,
      new AbortController().signal,
      baseDeps({
        currentVersion: () => '2.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '3.0.0', integrity: nextIntegrity, tarball: nextUrl }),
        installAndVerify: installAndVerifyDefault,
      }),
    );
    expect(third).toEqual({ updated: true });
    expect(await readInstalledVersion(packageRoot)).toBe('3.0.0');
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
    expect(await readInstalledVersion(packageRoot)).toBe('2.0.0');
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('no .system repo here'))).toBe(true);
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('reconcile failed'))).toBe(true);
  });
});

describe('triggerSelfUpdateInBackground (decoupled on-demand trigger, PHNX-3605)', () => {
  it('runs the shared attempt and resolves to its outcome — the IPC handler need not await it', async () => {
    const { ctx } = makeCtx();
    const outcome = await triggerSelfUpdateInBackground(ctx, baseDeps({ isDevBuild: () => true }));
    expect(outcome).toEqual({ updated: false, reason: 'dev build — self-update is a no-op' });
  });

  it('surfaces a fail-closed not-updated outcome when the install fails, leaving the running daemon untouched', async () => {
    const packageRoot = makeInstalledPackageRoot('1.0.0');
    const { ctx } = makeCtx();
    const outcome = await triggerSelfUpdateInBackground(
      ctx,
      baseDeps({
        currentVersion: () => '1.0.0',
        packageRoot: () => packageRoot,
        fetchLatestMetadata: async () => ({ version: '2.0.0', integrity: 'sha512-bogus', tarball: 'http://127.0.0.1:1/nope.tgz' }),
        installAndVerify: async () => { throw new Error('download failed'); },
      }),
    );
    expect(outcome.updated).toBe(false);
    expect(await readInstalledVersion(packageRoot)).toBe('1.0.0');
  });
});
