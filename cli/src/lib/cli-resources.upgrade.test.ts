import * as crypto from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PKG = '@acme/pin-tool';
const CMD = 'pin-tool-e2e';

interface Published { version: string; tarball: Buffer }

function packVersion(dir: string, version: string): Published {
  const pkgDir = path.join(dir, `src-${version}`);
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version, bin: { [CMD]: 'bin/cli.js' } }));
  fs.writeFileSync(path.join(pkgDir, 'bin', 'cli.js'), `#!/usr/bin/env node\nconsole.log('${version}');\n`, { mode: 0o755 });
  const file = execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], { cwd: pkgDir, encoding: 'utf8' }).trim().split('\n').pop()!;
  return { version, tarball: fs.readFileSync(path.join(dir, file)) };
}

function serveRegistry(versions: Published[]): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tar = /^\/tarballs\/(.+)\.tgz$/.exec(url);
    if (tar) {
      const v = versions.find((p) => p.version === tar[1]);
      if (!v) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(v.tarball);
      return;
    }
    if (url === `/${PKG}`) {
      const packument = {
        name: PKG,
        'dist-tags': { latest: versions[versions.length - 1].version },
        versions: Object.fromEntries(versions.map((v) => [v.version, {
          name: PKG,
          version: v.version,
          bin: { [CMD]: 'bin/cli.js' },
          dist: {
            tarball: `${base}/tarballs/${v.version}.tgz`,
            shasum: crypto.createHash('sha1').update(v.tarball).digest('hex'),
            integrity: `sha512-${crypto.createHash('sha512').update(v.tarball).digest('base64')}`,
          },
        }])),
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(packument));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function manifestYaml(version: string): string {
  return `name: ${CMD}\ncheck: ${CMD} --version\ninstall:\n  - npm: "${PKG}@${version}"\n`;
}

describe.skipIf(process.platform === 'win32')('host CLI pin upgrade (real npm, local registry)', () => {
  let work: string;
  let server: http.Server;
  let home: string;
  let prefix: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'PATH', 'npm_config_registry', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_update_notifier', 'npm_config_audit', 'npm_config_fund'];

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pin-e2e-'));
    server = await serveRegistry([packVersion(work, '0.1.0'), packVersion(work, '0.2.0')]);
  }, 60_000);
  afterAll(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.resetModules();
    for (const k of ENV) saved[k] = process.env[k];
    home = fs.mkdtempSync(path.join(work, 'home-'));
    prefix = path.join(home, '.local');
    process.env.HOME = home;
    process.env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${saved.PATH}`;
    process.env.npm_config_registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    process.env.npm_config_cache = path.join(home, '.npm');
    process.env.npm_config_fetch_retries = '0';
    process.env.npm_config_update_notifier = 'false';
    process.env.npm_config_audit = 'false';
    process.env.npm_config_fund = 'false';
    await promisify(execFile)('npm', ['install', '-g', '--prefix', prefix, `${PKG}@0.1.0`]);
  }, 60_000);
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  function installed(): string {
    return execFileSync(CMD, ['--version'], { encoding: 'utf8' }).trim();
  }

  it('upgrades a user-layer pinned CLI through the daemon tick, and logs it', async () => {
    fs.mkdirSync(path.join(home, '.agents', 'clis'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'clis', `${CMD}.yaml`), manifestYaml('0.2.0'));
    const { upgradeHostClis } = await import('./daemon/self-update-service.js');
    const logs: string[] = [];
    await upgradeHostClis({ log: (level, msg) => logs.push(`${level} ${msg}`) }, new AbortController().signal, Date.now() + 15 * 60_000, home);
    expect(installed()).toBe('0.2.0');
    expect(logs).toContain(`INFO host-cli upgrade: ${CMD} 0.1.0 -> 0.2.0`);
  }, 120_000);

  it('never lets a project-layer manifest drive an unattended install', async () => {
    const project = path.join(home, 'checkout');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    fs.mkdirSync(path.join(project, '.agents', 'clis'), { recursive: true });
    fs.writeFileSync(path.join(project, '.agents', 'clis', `${CMD}.yaml`), manifestYaml('0.2.0'));
    const { upgradeOutdatedClis } = await import('./cli-resources.js');
    const results = await upgradeOutdatedClis({ cwd: project });
    expect(results.find((r) => r.name === CMD)).toBeUndefined();
    expect(installed()).toBe('0.1.0');
  }, 120_000);

  it('defers an install that could not finish inside the tick', async () => {
    fs.mkdirSync(path.join(home, '.agents', 'clis'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'clis', `${CMD}.yaml`), manifestYaml('0.2.0'));
    const { upgradeOutdatedClis } = await import('./cli-resources.js');
    const results = await upgradeOutdatedClis({ cwd: home, deadlineAt: Date.now() + 1_000 });
    expect(results.find((r) => r.name === CMD)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/deferred/) });
    expect(installed()).toBe('0.1.0');
  }, 120_000);
});
