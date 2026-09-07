import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { needsWindowsShell, toPosix } from './platform/index.js';
import {
  bunGlobalDir,
  buildMultiInstallInventory,
  classifyRemovableAgentsCliInstalls,
  deriveGlobalPrefix,
  detectPackageManager,
  ensureGlobalBinLinks,
  dismissUpdateVersion,
  downloadVerifiedTarball,
  findAgentsCliInstalls,
  installPackageIntoPrefix,
  isMultiInstallScanFresh,
  isNpxCacheInstall,
  isTouchIdStormFixedVersion,
  manualUninstallCommand,
  installLooksSettled,
  MULTI_INSTALL_SCAN_TTL_MS,
  NPM_PACKAGE_NAME,
  purgeRemovableAgentsCliInstalls,
  readInstalledVersion,
  readMultiInstallScanCache,
  readUpdateCache,
  remediateStaleAgentsCliInstalls,
  resolveMultiInstallInventory,
  resolveRunningPackageRoot,
  saveUpdateCheck,
  shouldPromptUpgrade,
  sweepStaleInstallStaging,
  TOUCH_ID_STORM_FIXED_SINCE,
  verifyInstalledVersion,
  verifyTarballIntegrity,
  writeMultiInstallScanCache,
  type AgentsCliInstall,
  type MultiInstallScanCache,
} from './self-update.js';

const tempDirs: string[] = [];

function makeTempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agents-self-update-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveRunningPackageRoot', () => {
  /** An npm-global-shaped install carrying both shipped entrypoints. */
  function makeCompiledInstall(label: string) {
    // realpath the base: on macOS the tmpdir lives under /var -> /private/var,
    // and resolveRunningPackageRoot resolves without canonicalizing symlinks.
    const base = fs.realpathSync(makeTempDir(label));
    const packageRoot = path.join(base, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(packageRoot, 'dist', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.73' }),
    );
    fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), '// entrypoint\n');
    const execPath = path.join(packageRoot, 'dist', 'bin', 'agents');
    fs.writeFileSync(execPath, 'MZ-not-really\n', { mode: 0o755 });
    return { packageRoot: fs.realpathSync(packageRoot), execPath };
  }

  it('returns the parent of __dirname for an ordinary JS install', () => {
    // dist/index.js runs with __dirname = <packageRoot>/dist.
    const { packageRoot } = makeCompiledInstall('js-install');
    expect(resolveRunningPackageRoot(path.join(packageRoot, 'dist'), '/usr/local/bin/node')).toBe(
      packageRoot,
    );
  });

  it('maps the Bun virtual __dirname to the real root via process.execPath', () => {
    // The reported bug: under the compiled standalone binary Bun sets
    // __dirname to /$bunfs/root, so <__dirname>/.. was "/$bunfs" — a path that
    // exists nowhere. It was then reported as a phantom second install and
    // rejected by deriveGlobalPrefix, so every self-upgrade failed.
    const { packageRoot, execPath } = makeCompiledInstall('bunfs');

    const resolved = resolveRunningPackageRoot('/$bunfs/root', execPath);

    expect(resolved).toBe(packageRoot);
    // The whole point: the result is a real, installable npm prefix.
    expect(fs.existsSync(resolved)).toBe(true);
    expect(() => deriveGlobalPrefix(resolved)).not.toThrow();
  });

  it('throws when execPath is itself virtual rather than guessing a prefix', () => {
    expect(() => resolveRunningPackageRoot('/$bunfs/root', '/$bunfs/root/agents')).toThrow(
      /Cannot locate the running agents-cli install/,
    );
  });

  it('throws when no agents-cli package.json sits above execPath', () => {
    const stray = path.join(makeTempDir('stray'), 'agents');
    fs.writeFileSync(stray, 'binary\n', { mode: 0o755 });
    expect(() => resolveRunningPackageRoot('/$bunfs/root', stray)).toThrow(
      /no @phnx-labs\/agents-cli package.json above/,
    );
  });
});

describe('deriveGlobalPrefix', () => {
  it('resolves the POSIX npm global layout (<prefix>/lib/node_modules/<scoped pkg>)', () => {
    const root = path.join('/Users/x/.nvm/versions/node/v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    // path.resolve so the expected carries a drive on Windows, matching the
    // function's own path.resolve of the input.
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/Users/x/.nvm/versions/node/v24.15.0'));
  });

  it('resolves the Windows npm global layout (<prefix>/node_modules/<scoped pkg>)', () => {
    const root = path.join('/x/npm-prefix', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/x/npm-prefix'));
  });

  it('resolves the dev-install prefix used by scripts/install.sh', () => {
    const root = path.join('/Users/x/.local/agents-cli-dev', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(deriveGlobalPrefix(root)).toBe(path.resolve('/Users/x/.local/agents-cli-dev'));
  });

  it('throws for a source checkout that is not under node_modules', () => {
    expect(() => deriveGlobalPrefix('/Users/x/src/github.com/muqsitnawaz/agents-cli')).toThrow(
      /not an npm-managed install/,
    );
  });
});

describe('detectPackageManager', () => {
  const savedBunInstall = process.env.BUN_INSTALL;
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
  });

  it('detects bun from the BUN_INSTALL global layout (no lib segment)', () => {
    process.env.BUN_INSTALL = '/Users/x/.bun';
    const root = path.join(bunGlobalDir(), 'node_modules', '@phnx-labs', 'agents-cli');
    expect(toPosix(root)).toBe('/Users/x/.bun/install/global/node_modules/@phnx-labs/agents-cli');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('detects bun structurally when BUN_INSTALL is not exported (default ~/.bun)', () => {
    delete process.env.BUN_INSTALL;
    // A bun install rooted at a `.bun` dir other than the current $HOME's.
    const root = path.join('/opt/someuser/.bun/install/global', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('bun');
  });

  it('treats the npm POSIX layout (<prefix>/lib/node_modules) as npm', () => {
    delete process.env.BUN_INSTALL;
    const root = path.join('/Users/x/.nvm/versions/node/v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('npm');
  });

  it('does not mistake a non-bun "global" dir for a bun install', () => {
    process.env.BUN_INSTALL = '/Users/x/.bun';
    const root = path.join('/srv/global', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(detectPackageManager(root)).toBe('npm');
  });
});

describe('verifyInstalledVersion', () => {
  function writePackage(dir: string, version: string): string {
    const root = path.join(dir, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@phnx-labs/agents-cli', version }));
    return root;
  }

  it('passes when the package root carries the expected version', async () => {
    const root = writePackage(makeTempDir('verify-ok'), '1.20.7');
    await expect(verifyInstalledVersion(root, '1.20.7')).resolves.toBeUndefined();
  });

  it('throws with both versions when the running root was not updated', async () => {
    // The original incident: npm exits 0 after installing into a different
    // prefix, while the running copy's root still carries the old version.
    const root = writePackage(makeTempDir('verify-stale'), '1.20.4');
    await expect(verifyInstalledVersion(root, '1.20.7')).rejects.toThrow(/still 1\.20\.4 \(expected 1\.20\.7\)/);
  });

  it('suggests `bun add -g` (not npm --prefix) when the stale install is bun-managed', async () => {
    // The bun incident: the npm --prefix command in the hint is exactly what
    // could not update a bun install, so the manual hint must use bun instead.
    const saved = process.env.BUN_INSTALL;
    const base = makeTempDir('verify-bun');
    process.env.BUN_INSTALL = base;
    try {
      const root = path.join(base, 'install', 'global', 'node_modules', '@phnx-labs', 'agents-cli');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.17' }),
      );
      await expect(verifyInstalledVersion(root, '1.20.19')).rejects.toThrow(
        /Run manually: bun add -g @phnx-labs\/agents-cli@1\.20\.19/,
      );
    } finally {
      if (saved === undefined) delete process.env.BUN_INSTALL;
      else process.env.BUN_INSTALL = saved;
    }
  });
});

describe('installPackageIntoPrefix', () => {
  function packDummyPackage(version: string): string {
    const src = makeTempDir('dummy-src');
    fs.writeFileSync(
      path.join(src, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version, license: 'MIT' }),
    );
    const tarball = execFileSync('npm', ['pack', '--silent'], {
      cwd: src,
      encoding: 'utf-8',
      shell: needsWindowsShell('npm'),
    }).trim();
    return path.join(src, tarball);
  }

  it('installs into the given prefix and the result verifies in place', { timeout: 120_000 }, async () => {
    const prefix = makeTempDir('prefix');
    const tarball = packDummyPackage('2.0.0');

    await installPackageIntoPrefix(tarball, prefix);

    // npm prefix layout is platform-divergent: POSIX nests under lib/, Windows
    // installs node_modules directly under the prefix. Source handles both.
    const installedRoot = process.platform === 'win32'
      ? path.join(prefix, 'node_modules', '@agents-cli-test', 'dummy')
      : path.join(prefix, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    expect(await readInstalledVersion(installedRoot)).toBe('2.0.0');
    await expect(verifyInstalledVersion(installedRoot, '2.0.0')).resolves.toBeUndefined();
    // The exact upgrade-flow composition: the prefix derived from the
    // installed root must round-trip back to the prefix we installed into.
    expect(deriveGlobalPrefix(installedRoot)).toBe(prefix);
  });

  it('verification catches an install that landed in a different prefix', { timeout: 120_000 }, async () => {
    // Reproduces the divergent-prefix incident end-to-end: the "running"
    // copy lives in prefix A at 1.0.0, the install writes 2.0.0 into prefix
    // B, and verification against A's root must fail rather than report a
    // successful upgrade.
    const prefixA = makeTempDir('prefix-a');
    const prefixB = makeTempDir('prefix-b');
    const runningRoot = path.join(prefixA, 'lib', 'node_modules', '@agents-cli-test', 'dummy');
    fs.mkdirSync(runningRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runningRoot, 'package.json'),
      JSON.stringify({ name: '@agents-cli-test/dummy', version: '1.0.0' }),
    );

    await installPackageIntoPrefix(packDummyPackage('2.0.0'), prefixB);

    await expect(verifyInstalledVersion(runningRoot, '2.0.0')).rejects.toThrow(/still 1\.0\.0 \(expected 2\.0\.0\)/);
  });
});

function sriFor(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

describe('verifyTarballIntegrity', () => {
  const tarball = Buffer.from('fake tarball bytes   for integrity check');

  it('accepts a tarball whose bytes match the SRI digest', () => {
    expect(() => verifyTarballIntegrity(tarball, sriFor(tarball))).not.toThrow();
  });

  it('rejects a tarball whose bytes do not match the SRI digest (tampered/corrupt)', () => {
    // The security gate: the registry attested one hash, the delivered bytes
    // hash to another — self-update must refuse it, not install it.
    const attested = sriFor(tarball);
    const tampered = Buffer.concat([tarball, Buffer.from('!')]);
    expect(() => verifyTarballIntegrity(tampered, attested)).toThrow(/integrity check failed/);
  });

  it('refuses an algorithm weaker than sha512', () => {
    const sha1 = `sha1-${createHash('sha1').update(tarball).digest('base64')}`;
    expect(() => verifyTarballIntegrity(tarball, sha1)).toThrow(/unsupported integrity algorithm 'sha1'/);
  });

  it('rejects a malformed integrity string', () => {
    expect(() => verifyTarballIntegrity(tarball, 'not-an-sri')).toThrow(/unsupported integrity algorithm/);
    expect(() => verifyTarballIntegrity(tarball, 'sha512')).toThrow(/malformed integrity string/);
  });
});

describe('downloadVerifiedTarball', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  function serve(bytes: Buffer): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
    });
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}/@phnx-labs/agents-cli/-/agents-cli-9.9.9.tgz`);
      });
    });
  }

  it('writes the tarball to disk when the served bytes match the integrity', async () => {
    const bytes = Buffer.from('verified package payload');
    const url = await serve(bytes);
    const file = await downloadVerifiedTarball(url, sriFor(bytes));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(path.basename(file)).toBe('agents-cli-9.9.9.tgz');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rejects a wrong-hash tarball and writes nothing', async () => {
    // End-to-end over real HTTP + real crypto: the server delivers bytes that
    // do not match the attested integrity; the download must reject.
    const attested = sriFor(Buffer.from('the legitimate published tarball'));
    const url = await serve(Buffer.from('a malicious substituted tarball'));
    await expect(downloadVerifiedTarball(url, attested)).rejects.toThrow(/integrity check failed/);
  });
});

describe('update-check cache', () => {
  function cacheFile(): string {
    return path.join(makeTempDir('cache'), 'nested', '.update-check');
  }

  it('readUpdateCache returns null for a missing or corrupt file', () => {
    const file = cacheFile();
    expect(readUpdateCache(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(readUpdateCache(file)).toBeNull();
  });

  it('saveUpdateCheck creates the parent directory and records the version', () => {
    const file = cacheFile();
    saveUpdateCheck(file, '1.20.7');
    const cache = readUpdateCache(file);
    expect(cache?.latestVersion).toBe('1.20.7');
    expect(cache?.lastCheck).toBeTypeOf('number');
  });

  it('a background refresh does not erase a dismissed version', () => {
    // The original bug: the user picked "Skip 1.20.7", then the next 24h
    // background refresh rewrote the cache without the dismissed marker and
    // re-prompted for the exact version they skipped.
    const file = cacheFile();
    dismissUpdateVersion(file, '1.20.7');
    expect(shouldPromptUpgrade(readUpdateCache(file), '1.20.4')).toBe(false);

    saveUpdateCheck(file, '1.20.7');

    expect(readUpdateCache(file)?.dismissed).toBe('1.20.7');
    expect(shouldPromptUpgrade(readUpdateCache(file), '1.20.4')).toBe(false);
  });

  it('a newer latest than the dismissed one resumes prompting', () => {
    const file = cacheFile();
    dismissUpdateVersion(file, '1.20.7');
    saveUpdateCheck(file, '1.20.8');

    const cache = readUpdateCache(file);
    expect(cache?.dismissed).toBe('1.20.7');
    expect(shouldPromptUpgrade(cache, '1.20.4')).toBe(true);
  });

  it('shouldPromptUpgrade is false when current is equal to or ahead of latest', () => {
    const cache = { lastCheck: 1, latestVersion: '1.20.7' };
    expect(shouldPromptUpgrade(cache, '1.20.7')).toBe(false);
    expect(shouldPromptUpgrade(cache, '1.21.0')).toBe(false);
    expect(shouldPromptUpgrade(null, '1.20.4')).toBe(false);
    expect(shouldPromptUpgrade(cache, '1.20.4')).toBe(true);
  });
});

// findAgentsCliInstalls is POSIX-only (Windows npm bins are .cmd wrappers, not
// symlinks — the function returns [] on win32), and the fixtures here create
// symlinks that need Developer Mode on Windows. Skip the whole block there.
describe.skipIf(process.platform === 'win32')('findAgentsCliInstalls', () => {
  function pathOnlyOptions(base: string) {
    return {
      homeDir: path.join(base, 'empty-home'),
      fnmDir: path.join(base, 'empty-fnm'),
      npmCacheDir: path.join(base, 'empty-cache'),
      globalNodeModulesDirs: [],
    };
  }

  /** Lay out an npm-global-shaped install and a bin dir whose `agents` symlinks into it. */
  function makeInstall(base: string, name: string, version: string, pkgName = '@phnx-labs/agents-cli') {
    const packageRoot = path.join(base, name, 'lib', 'node_modules', ...pkgName.split('/'));
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: pkgName, version }));
    fs.writeFileSync(path.join(packageRoot, 'dist', 'index.js'), '// entrypoint\n');
    const binDir = path.join(base, name, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(packageRoot, 'dist', 'index.js'), path.join(binDir, 'agents'));
    // realpath the root: on macOS the tmpdir lives under /var -> /private/var,
    // and the scanner reports canonicalized paths.
    return { packageRoot: fs.realpathSync(packageRoot), binDir };
  }

  function makeDiscoveredInstall(packageRoot: string, version: string, atomic: boolean): string {
    fs.mkdirSync(path.join(packageRoot, 'dist', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version }),
    );
    if (atomic) {
      fs.writeFileSync(path.join(packageRoot, 'dist', 'lib', 'app-bundle-install.js'), '// atomic installer\n');
    }
    return fs.realpathSync(packageRoot);
  }

  it('resolves each PATH entry to its package root, deduplicating repeats', () => {
    const base = makeTempDir('installs');
    const a = makeInstall(base, 'prefix-a', '1.20.4');
    const b = makeInstall(base, 'prefix-b', '1.20.7');
    const pathEnv = [a.binDir, b.binDir, a.binDir].join(path.delimiter);

    const installs = findAgentsCliInstalls(pathEnv, pathOnlyOptions(base));

    expect(installs).toHaveLength(2);
    expect(installs.map((i) => i.packageRoot).sort()).toEqual([a.packageRoot, b.packageRoot].sort());
    expect(installs.find((i) => i.packageRoot === a.packageRoot)?.version).toBe('1.20.4');
    expect(installs.find((i) => i.packageRoot === b.packageRoot)?.version).toBe('1.20.7');
  });

  it('follows symlink chains like the dev install (~/.local/bin/agents -> prefix bin -> dist)', () => {
    const base = makeTempDir('chain');
    const real = makeInstall(base, 'dev-prefix', '0.0.0-dev.abc123');
    const localBin = path.join(base, 'local-bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(path.join(real.binDir, 'agents'), path.join(localBin, 'agents'));

    const installs = findAgentsCliInstalls(localBin, pathOnlyOptions(base));

    expect(installs).toHaveLength(1);
    expect(installs[0].packageRoot).toBe(real.packageRoot);
    expect(installs[0].version).toBe('0.0.0-dev.abc123');
  });

  it('resolves a shim pointing at the compiled binary to the same root as the JS entry', () => {
    // The reported false positive: ~/.local/bin/agents -> dist/bin/agents is
    // first on PATH and is the copy that runs, but the scan only recognized
    // dist/index.js. The running copy was invisible here while its sibling
    // npm bin was reported — one install looked like two.
    const base = makeTempDir('compiled');
    const real = makeInstall(base, 'npm-prefix', '1.20.73');
    const compiled = path.join(real.packageRoot, 'dist', 'bin', 'agents');
    fs.mkdirSync(path.dirname(compiled), { recursive: true });
    fs.writeFileSync(compiled, 'compiled standalone\n', { mode: 0o755 });
    const localBin = path.join(base, 'local-bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(compiled, path.join(localBin, 'agents'));

    // A compiled shim on its own must resolve — before the fix this was [],
    // i.e. the copy that actually runs was invisible to the scan entirely.
    const compiledOnly = findAgentsCliInstalls(localBin, pathOnlyOptions(base));
    expect(compiledOnly).toHaveLength(1);
    expect(compiledOnly[0].packageRoot).toBe(real.packageRoot);
    expect(compiledOnly[0].version).toBe('1.20.73');

    // And alongside the sibling npm bin it dedups to one install, not two.
    const both = findAgentsCliInstalls([localBin, real.binDir].join(path.delimiter), pathOnlyOptions(base));
    expect(both).toHaveLength(1);
    expect(both[0].binPath).toBe(path.join(localBin, 'agents'));
  });

  it('skips unrelated binaries, foreign packages, and missing entries', () => {
    const base = makeTempDir('noise');
    // A plain executable named `agents` that is some other tool entirely.
    const plainBin = path.join(base, 'plain-bin');
    fs.mkdirSync(plainBin, { recursive: true });
    fs.writeFileSync(path.join(plainBin, 'agents'), '#!/bin/sh\necho other tool\n', { mode: 0o755 });
    // A dist/index.js layout that belongs to a different npm package.
    const foreign = makeInstall(base, 'foreign', '3.0.0', '@other/agents-tool');
    // A dangling symlink and a dir with no `agents` at all.
    const dangling = path.join(base, 'dangling-bin');
    fs.mkdirSync(dangling, { recursive: true });
    fs.symlinkSync(path.join(base, 'nowhere', 'dist', 'index.js'), path.join(dangling, 'agents'));
    const empty = path.join(base, 'empty-bin');
    fs.mkdirSync(empty, { recursive: true });

    const pathEnv = [plainBin, foreign.binDir, dangling, empty].join(path.delimiter);
    expect(findAgentsCliInstalls(pathEnv, pathOnlyOptions(base))).toEqual([]);
  });

  it('discovers installs outside PATH across node managers and the npx cache (#2147)', () => {
    const homeDir = makeTempDir('managed-installs');
    const npmCacheDir = path.join(homeDir, 'npm-cache');
    const roots = [
      makeDiscoveredInstall(
        path.join(homeDir, '.nvm', 'versions', 'node', 'v24.15.0', 'lib', 'node_modules', '@phnx-labs', 'agents-cli'),
        '1.22.5',
        true,
      ),
      makeDiscoveredInstall(
        path.join(homeDir, '.local', 'share', 'fnm', 'node-versions', 'v24.14.0', 'installation', 'lib', 'node_modules', '@phnx-labs', 'agents-cli'),
        '1.22.4',
        true,
      ),
      makeDiscoveredInstall(
        path.join(homeDir, '.volta', 'tools', 'image', 'packages', '@phnx-labs', 'agents-cli', 'lib', 'node_modules', '@phnx-labs', 'agents-cli'),
        '1.22.3',
        true,
      ),
      makeDiscoveredInstall(
        path.join(npmCacheDir, '_npx', 'run-1', 'node_modules', '@phnx-labs', 'agents-cli'),
        '1.20.88',
        false,
      ),
    ];

    const installs = findAgentsCliInstalls('', {
      homeDir,
      npmCacheDir,
      globalNodeModulesDirs: [],
    });

    expect(installs.map((install) => install.packageRoot).sort()).toEqual(roots.sort());
    expect(installs.every((install) => install.binPath === undefined)).toBe(true);
    expect(installs.find((install) => install.version === '1.20.88')?.atomicHelperInstall).toBe(false);
    expect(installs.filter((install) => install.atomicHelperInstall)).toHaveLength(3);
  });

  it('deduplicates a managed install already found through PATH and preserves its PATH note', () => {
    const homeDir = makeTempDir('managed-dedup');
    const nvmRoot = path.join(homeDir, '.nvm', 'versions', 'node', 'v24.15.0');
    const install = makeInstall(path.dirname(nvmRoot), path.basename(nvmRoot), '1.22.5');

    const installs = findAgentsCliInstalls(install.binDir, {
      homeDir,
      npmCacheDir: path.join(homeDir, 'empty-cache'),
      globalNodeModulesDirs: [],
    });

    expect(installs).toHaveLength(1);
    expect(installs[0].packageRoot).toBe(install.packageRoot);
    expect(installs[0].binPath).toBe(path.join(install.binDir, 'agents'));
  });
});

describe('buildMultiInstallInventory', () => {
  it('marks the running copy unsafe when it predates the atomic helper installer', () => {
    const runningRoot = '/prefix/lib/node_modules/@phnx-labs/agents-cli';
    const inventory = buildMultiInstallInventory(runningRoot, '1.20.88', [{
      binPath: '/prefix/bin/agents',
      packageRoot: runningRoot,
      version: '1.20.88',
      atomicHelperInstall: false,
    }]);

    expect(inventory).toEqual([{
      packageRoot: runningRoot,
      version: '1.20.88',
      note: 'running; unsafe legacy helper installer — remove this copy',
      running: true,
      autoPurgeable: false,
    }]);
  });

  // RUSH-2705: the multi-install banner chooses its remedy from these flags —
  // `agents doctor --fix` for auto-purgeable peers, a manual command otherwise.
  it('flags an npx-cache peer auto-purgeable but not a healthy >=1.22.30 duplicate', () => {
    const runningRoot = '/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli';
    const nvmRoot = '/home/u/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli';
    const npxRoot = '/home/u/.npm/_npx/abc123/node_modules/@phnx-labs/agents-cli';
    const inventory = buildMultiInstallInventory(runningRoot, '1.22.39', [
      { packageRoot: runningRoot, version: '1.22.39', atomicHelperInstall: true },
      { packageRoot: nvmRoot, version: '1.22.37', atomicHelperInstall: true },
      { packageRoot: npxRoot, version: '1.20.65', atomicHelperInstall: true },
    ]);

    const byRoot = new Map(inventory.map((entry) => [entry.packageRoot, entry]));
    expect(byRoot.get(runningRoot)).toMatchObject({ running: true, autoPurgeable: false });
    // The stale-but-safe global: detected, never auto-purged.
    expect(byRoot.get(nvmRoot)).toMatchObject({ running: false, autoPurgeable: false });
    // npx-cache + pre-1.22.30 with a fixed peer: --fix removes it.
    expect(byRoot.get(npxRoot)).toMatchObject({ running: false, autoPurgeable: true });
  });
});

describe('manualUninstallCommand (RUSH-2705)', () => {
  // The two POSIX-literal cases are layout-specific (nvm / a bare checkout under
  // /srv exist only on POSIX): on win32, path resolution rewrites the literal to
  // D:\home\... and the expectation can never hold. The bun case stays — it
  // builds its path from os.homedir(), so it is platform-correct everywhere.
  it.skipIf(process.platform === 'win32')('pins the peer npm prefix for a POSIX global layout (the nvm duplicate case)', () => {
    const root = '/home/u/.nvm/versions/node/v24.15.0/lib/node_modules/@phnx-labs/agents-cli';
    expect(manualUninstallCommand(root)).toBe(
      "npm uninstall -g --prefix '/home/u/.nvm/versions/node/v24.15.0' @phnx-labs/agents-cli",
    );
  });

  it('uses bun for a bun global layout', () => {
    const root = path.join(os.homedir(), '.bun', 'install', 'global', 'node_modules', '@phnx-labs', 'agents-cli');
    expect(manualUninstallCommand(root)).toBe('bun remove -g @phnx-labs/agents-cli');
  });

  it.skipIf(process.platform === 'win32')('falls back to deleting the directory when no npm prefix owns the tree', () => {
    const root = '/srv/checkouts/agents-cli';
    expect(manualUninstallCommand(root)).toBe(`rm -rf '${root}'`);
  });
});

/**
 * RUSH-2324: short-TTL cache for the multi-install PATH scan that every
 * ordinary CLI invocation runs via maybeWarnMultiInstall. Real fs only.
 */
describe('multi-install scan cache (RUSH-2324)', () => {
  const NOW = 1_700_000_000_000;
  const runningRoot = '/prefix/lib/node_modules/@phnx-labs/agents-cli';
  const inventory = [{
    packageRoot: runningRoot,
    version: '1.22.35',
    note: 'running',
    running: true,
    autoPurgeable: false,
  }];

  function makeCache(overrides: Partial<MultiInstallScanCache> = {}): MultiInstallScanCache {
    return {
      scannedAt: NOW,
      pathEnv: '/usr/bin:/usr/local/bin',
      runningRoot,
      runningVersion: '1.22.35',
      inventory,
      ...overrides,
    };
  }

  it('isMultiInstallScanFresh is true only when TTL, PATH, root, and version all match', () => {
    const cache = makeCache();
    expect(isMultiInstallScanFresh(cache, cache.pathEnv, runningRoot, '1.22.35', NOW + 1_000)).toBe(true);
    expect(isMultiInstallScanFresh(cache, cache.pathEnv, runningRoot, '1.22.35', NOW + MULTI_INSTALL_SCAN_TTL_MS - 1)).toBe(true);
    expect(isMultiInstallScanFresh(cache, cache.pathEnv, runningRoot, '1.22.35', NOW + MULTI_INSTALL_SCAN_TTL_MS)).toBe(false);
    expect(isMultiInstallScanFresh(cache, '/other/path', runningRoot, '1.22.35', NOW + 1_000)).toBe(false);
    expect(isMultiInstallScanFresh(cache, cache.pathEnv, '/other/root', '1.22.35', NOW + 1_000)).toBe(false);
    expect(isMultiInstallScanFresh(cache, cache.pathEnv, runningRoot, '9.9.9', NOW + 1_000)).toBe(false);
    expect(isMultiInstallScanFresh(null, cache.pathEnv, runningRoot, '1.22.35', NOW)).toBe(false);
  });

  it('read/write round-trip a real cache file beside the update-check path', () => {
    const dir = makeTempDir('multi-install-cache');
    const file = path.join(dir, '.multi-install-scan');
    const cache = makeCache();
    writeMultiInstallScanCache(file, cache);
    expect(readMultiInstallScanCache(file)).toEqual(cache);
  });

  it('readMultiInstallScanCache returns null for missing or corrupt files', () => {
    const dir = makeTempDir('multi-install-cache-bad');
    expect(readMultiInstallScanCache(path.join(dir, 'missing'))).toBeNull();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, 'not-json');
    expect(readMultiInstallScanCache(bad)).toBeNull();
    fs.writeFileSync(bad, JSON.stringify({ scannedAt: 'nope' }));
    expect(readMultiInstallScanCache(bad)).toBeNull();
  });

  it('rejects a pre-RUSH-2705 cache whose entries lack the remedy flags', () => {
    const dir = makeTempDir('multi-install-cache-old-shape');
    const file = path.join(dir, '.multi-install-scan');
    fs.writeFileSync(file, JSON.stringify(makeCache({
      // The shape written before running/autoPurgeable existed.
      inventory: [
        { packageRoot: runningRoot, version: '1.22.35', note: 'running' },
      ] as unknown as MultiInstallScanCache['inventory'],
    })));
    expect(readMultiInstallScanCache(file)).toBeNull();
  });

  it('resolveMultiInstallInventory returns the cached inventory without re-scanning when fresh', () => {
    const dir = makeTempDir('multi-install-resolve');
    const file = path.join(dir, '.multi-install-scan');
    // Seed a cache that claims a second install. A re-scan with an empty PATH
    // and no known roots would produce only the running entry — so if the
    // cache is honored we get length 2, not 1.
    const seeded = makeCache({
      pathEnv: '',
      inventory: [
        { packageRoot: runningRoot, version: '1.22.35', note: 'running', running: true, autoPurgeable: false },
        { packageRoot: '/other/lib/node_modules/@phnx-labs/agents-cli', version: '1.20.0', note: 'discovered install', running: false, autoPurgeable: true },
      ],
    });
    writeMultiInstallScanCache(file, seeded);
    const resolved = resolveMultiInstallInventory(
      runningRoot,
      '1.22.35',
      '',
      file,
      {
        now: NOW + 1_000,
        // Force no known-root discovery so a re-scan cannot invent the second entry.
        findOpts: {
          homeDir: path.join(dir, 'no-home'),
          fnmDir: path.join(dir, 'no-fnm'),
          npmCacheDir: path.join(dir, 'no-npm-cache'),
          globalNodeModulesDirs: [],
        },
      },
    );
    expect(resolved).toEqual(seeded.inventory);
    expect(resolved).toHaveLength(2);
  });

  it('resolveMultiInstallInventory re-scans and rewrites the cache when stale', () => {
    const dir = makeTempDir('multi-install-stale');
    const file = path.join(dir, '.multi-install-scan');
    const seeded = makeCache({
      pathEnv: '',
      scannedAt: NOW - MULTI_INSTALL_SCAN_TTL_MS - 1,
      inventory: [
        { packageRoot: runningRoot, version: '1.22.35', note: 'running', running: true, autoPurgeable: false },
        { packageRoot: '/stale/other', version: '0.0.1', note: 'discovered install', running: false, autoPurgeable: false },
      ],
    });
    writeMultiInstallScanCache(file, seeded);
    const resolved = resolveMultiInstallInventory(
      runningRoot,
      '1.22.35',
      '',
      file,
      {
        now: NOW,
        findOpts: {
          homeDir: path.join(dir, 'no-home'),
          fnmDir: path.join(dir, 'no-fnm'),
          npmCacheDir: path.join(dir, 'no-npm-cache'),
          globalNodeModulesDirs: [],
        },
      },
    );
    // Empty PATH + empty known roots → inventory is just the running copy.
    expect(resolved).toEqual([
      { packageRoot: runningRoot, version: '1.22.35', note: 'running', running: true, autoPurgeable: false },
    ]);
    const rewritten = readMultiInstallScanCache(file);
    expect(rewritten?.scannedAt).toBe(NOW);
    expect(rewritten?.inventory).toEqual(resolved);
  });
});

describe('classifyRemovableAgentsCliInstalls / purge (RUSH-2415)', () => {
  it('isTouchIdStormFixedVersion treats 1.22.30+, later releases, and dev builds as fixed', () => {
    expect(TOUCH_ID_STORM_FIXED_SINCE).toBe('1.22.30');
    expect(isTouchIdStormFixedVersion('1.22.30')).toBe(true);
    expect(isTouchIdStormFixedVersion('1.22.33')).toBe(true);
    expect(isTouchIdStormFixedVersion('0.0.0-dev.abc')).toBe(true);
    expect(isTouchIdStormFixedVersion('1.22.29')).toBe(false);
    expect(isTouchIdStormFixedVersion('1.20.88')).toBe(false);
    expect(isTouchIdStormFixedVersion('not-a-version')).toBe(false);
  });

  it('detects npx-cache roots by path segment', () => {
    expect(isNpxCacheInstall('/home/u/.npm/_npx/run-1/node_modules/@phnx-labs/agents-cli')).toBe(true);
    expect(isNpxCacheInstall('/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli')).toBe(false);
  });

  it('never classifies the running root as removable', () => {
    const running = '/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli';
    const installs: AgentsCliInstall[] = [
      { packageRoot: running, version: '1.22.33', atomicHelperInstall: true },
      {
        packageRoot: '/home/u/.npm/_npx/x/node_modules/@phnx-labs/agents-cli',
        version: '1.20.65',
        atomicHelperInstall: false,
      },
    ];
    const removable = classifyRemovableAgentsCliInstalls(running, installs);
    expect(removable.every((r) => r.packageRoot !== running)).toBe(true);
    expect(removable).toHaveLength(1);
    expect(removable[0].reasons).toEqual(
      expect.arrayContaining(['npx-cache', 'unsafe-legacy-helper', 'pre-fixed-version']),
    );
  });

  it('does not mark a lone pre-fixed install as pre-fixed-version (would strand the box)', () => {
    const running = '/opt/a/lib/node_modules/@phnx-labs/agents-cli';
    const stale = '/opt/b/lib/node_modules/@phnx-labs/agents-cli';
    const installs: AgentsCliInstall[] = [
      { packageRoot: running, version: '1.22.25', atomicHelperInstall: true },
      { packageRoot: stale, version: '1.22.18', atomicHelperInstall: true },
    ];
    const removable = classifyRemovableAgentsCliInstalls(running, installs);
    // No fixed peer → no pre-fixed-version reason. Neither is legacy/npx.
    expect(removable).toEqual([]);
  });

  it('marks pre-fixed peers removable once a fixed copy exists', () => {
    const running = '/opt/homebrew/lib/node_modules/@phnx-labs/agents-cli';
    const staleNvm = '/home/u/.nvm/versions/node/v24/lib/node_modules/@phnx-labs/agents-cli';
    const installs: AgentsCliInstall[] = [
      { packageRoot: running, version: '1.22.33', atomicHelperInstall: true },
      { packageRoot: staleNvm, version: '1.22.25', atomicHelperInstall: true },
    ];
    const removable = classifyRemovableAgentsCliInstalls(running, installs);
    expect(removable).toEqual([{
      packageRoot: staleNvm,
      version: '1.22.25',
      reasons: ['pre-fixed-version'],
    }]);
  });

  it('marks unsafe-legacy even when the version string is modern', () => {
    const running = '/opt/a/lib/node_modules/@phnx-labs/agents-cli';
    const legacy = '/opt/b/lib/node_modules/@phnx-labs/agents-cli';
    const installs: AgentsCliInstall[] = [
      { packageRoot: running, version: '1.22.33', atomicHelperInstall: true },
      { packageRoot: legacy, version: '1.22.33', atomicHelperInstall: false },
    ];
    const removable = classifyRemovableAgentsCliInstalls(running, installs);
    expect(removable).toEqual([{
      packageRoot: legacy,
      version: '1.22.33',
      reasons: ['unsafe-legacy-helper'],
    }]);
  });

  it('purge deletes a real package tree and refuses a non-agents-cli path', () => {
    const base = makeTempDir('purge');
    const goodRoot = path.join(base, 'good', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(goodRoot, { recursive: true });
    fs.writeFileSync(
      path.join(goodRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.88' }),
    );
    fs.writeFileSync(path.join(goodRoot, 'marker.txt'), 'bye');

    const foreignRoot = path.join(base, 'foreign');
    fs.mkdirSync(foreignRoot, { recursive: true });
    fs.writeFileSync(
      path.join(foreignRoot, 'package.json'),
      JSON.stringify({ name: '@other/tool', version: '1.0.0' }),
    );

    const goodCanonical = fs.realpathSync(goodRoot);
    const foreignCanonical = fs.realpathSync(foreignRoot);
    const result = purgeRemovableAgentsCliInstalls([
      { packageRoot: goodRoot, version: '1.20.88', reasons: ['npx-cache'] },
      { packageRoot: foreignRoot, version: '1.0.0', reasons: ['npx-cache'] },
    ]);

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].packageRoot).toBe(goodCanonical);
    expect(fs.existsSync(goodRoot)).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].packageRoot).toBe(foreignCanonical);
    expect(result.failed[0].error).toMatch(/not @phnx-labs\/agents-cli/);
    expect(fs.existsSync(foreignRoot)).toBe(true);
  });

  it('purge dryRun leaves trees on disk', () => {
    const base = makeTempDir('purge-dry');
    const root = path.join(base, 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.1' }),
    );
    const result = purgeRemovableAgentsCliInstalls(
      [{ packageRoot: root, version: '1.20.1', reasons: ['pre-fixed-version'] }],
      { dryRun: true },
    );
    expect(result.removed).toHaveLength(1);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('purge never removes the runningRoot even if listed', () => {
    const base = makeTempDir('purge-running');
    const root = path.join(base, 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.1' }),
    );
    const result = purgeRemovableAgentsCliInstalls(
      [{ packageRoot: root, version: '1.20.1', reasons: ['pre-fixed-version'] }],
      { runningRoot: root },
    );
    expect(result.removed).toHaveLength(0);
    expect(result.skippedRunning).toBe(1);
    expect(fs.existsSync(root)).toBe(true);
  });

  // findAgentsCliInstalls is POSIX-only (returns [] on win32 — Windows npm
  // bins are .cmd wrappers, not symlinks; see findAgentsCliInstalls).
  it.skipIf(process.platform === 'win32')('remediateStaleAgentsCliInstalls end-to-end: fixed peer + npx stale → purged', () => {
    const homeDir = makeTempDir('remediate');
    const fixedRoot = path.join(homeDir, 'fixed', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(fixedRoot, 'dist', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(fixedRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.22.33' }),
    );
    fs.writeFileSync(path.join(fixedRoot, 'dist', 'lib', 'app-bundle-install.js'), '// atomic\n');

    const npmCacheDir = path.join(homeDir, 'npm-cache');
    const npxRoot = path.join(npmCacheDir, '_npx', 'run-9', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(npxRoot, { recursive: true });
    fs.writeFileSync(
      path.join(npxRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.20.65' }),
    );

    const npxCanonical = fs.realpathSync(npxRoot);
    const result = remediateStaleAgentsCliInstalls({
      runningRoot: fixedRoot,
      runningVersion: '1.22.33',
      pathEnv: '',
      findOpts: {
        homeDir,
        npmCacheDir,
        globalNodeModulesDirs: [],
        fnmDir: path.join(homeDir, 'empty-fnm'),
      },
    });

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.removed.some((r) => r.packageRoot === npxCanonical)).toBe(true);
    expect(fs.existsSync(npxRoot)).toBe(false);
    expect(fs.existsSync(fixedRoot)).toBe(true);
  });

  // RUSH-2705: the bug this pins — a healthy >=1.22.30 duplicate was detected
  // (and nagged about) but never purged, while --fix reported nothing at all.
  it.skipIf(process.platform === 'win32')('remediateStaleAgentsCliInstalls reports a healthy duplicate as unresolved with its exact removal command', () => {
    const homeDir = makeTempDir('remediate-unresolved');
    const runningRoot = path.join(homeDir, 'brew', 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(runningRoot, 'dist', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(runningRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.22.39' }),
    );
    fs.writeFileSync(path.join(runningRoot, 'dist', 'lib', 'app-bundle-install.js'), '// atomic\n');

    // The nvm-shaped peer: >=1.22.30, atomic helper, not npx-cache. --fix must
    // leave it on disk and hand back the npm uninstall pinned to its prefix.
    const nvmPrefix = path.join(homeDir, '.nvm', 'versions', 'node', 'v24.15.0');
    const dupRoot = path.join(nvmPrefix, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(dupRoot, 'dist', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(dupRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.22.37' }),
    );
    fs.writeFileSync(path.join(dupRoot, 'dist', 'lib', 'app-bundle-install.js'), '// atomic\n');

    const result = remediateStaleAgentsCliInstalls({
      runningRoot,
      runningVersion: '1.22.39',
      pathEnv: '',
      findOpts: {
        homeDir,
        npmCacheDir: path.join(homeDir, 'no-npm-cache'),
        globalNodeModulesDirs: [path.join(nvmPrefix, 'lib', 'node_modules')],
        fnmDir: path.join(homeDir, 'empty-fnm'),
      },
    });

    expect(result.removed).toHaveLength(0);
    expect(fs.existsSync(dupRoot)).toBe(true);
    expect(result.unresolved).toHaveLength(1);
    const unresolved = result.unresolved[0];
    expect(unresolved.version).toBe('1.22.37');
    expect(fs.realpathSync(unresolved.packageRoot)).toBe(fs.realpathSync(dupRoot));
    expect(unresolved.manualRemoveCommand).toBe(
      `npm uninstall -g --prefix '${fs.realpathSync(nvmPrefix)}' @phnx-labs/agents-cli`,
    );
  });
});

describe('sweepStaleInstallStaging', () => {
  /**
   * npm's own retire-path naming (@npmcli/arborist `lib/retire-path.js`):
   * `.<basename>-<8-char sha1(base64, alnum-only) of the full path>`,
   * sibling to the directory it retires. Reproduced here (not imported) so the
   * test proves the sweep matches npm's real scheme, not just its own guess.
   */
  function npmRetirePath(from: string): string {
    const dir = path.dirname(from);
    const base = path.basename(from);
    const hash = createHash('sha1').update(from).digest('base64')
      .replace(/[^a-zA-Z0-9]+/g, '')
      .slice(0, 8);
    return path.join(dir, `.${base}-${hash}`);
  }

  it('a rename onto an orphaned staging dir fails ENOTEMPTY, and the sweep clears it', async () => {
    const scopeDir = makeTempDir('sweep-scope');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"@phnx-labs/agents-cli"}');

    // Simulate a crash mid-reify: the retire-rename completed (the live
    // package moved to its staging path) but the final rename never ran, so
    // the staging dir is left behind non-empty — the exact orphan this bug
    // report describes.
    const stagingPath = npmRetirePath(packageRoot);
    fs.mkdirSync(stagingPath);
    fs.writeFileSync(path.join(stagingPath, 'package.json'), '{"name":"@phnx-labs/agents-cli","version":"old"}');

    // Prove the failure is real, not asserted from prose: a second reify's
    // retire-rename (renaming the CURRENT live package out of the way again,
    // onto the same deterministic path) hits ENOTEMPTY on this actual
    // filesystem, exactly as it does for npm.
    let threw: NodeJS.ErrnoException | undefined;
    try {
      fs.renameSync(packageRoot, stagingPath);
    } catch (err) {
      threw = err as NodeJS.ErrnoException;
    }
    expect(threw?.code).toBe('ENOTEMPTY');
    // The failed rename must not have moved anything.
    expect(fs.existsSync(packageRoot)).toBe(true);

    const swept = await sweepStaleInstallStaging(packageRoot);

    expect(swept).toEqual([stagingPath]);
    expect(fs.existsSync(stagingPath)).toBe(false);
    // The sweep clears the collision, not the live package it protects.
    expect(fs.existsSync(packageRoot)).toBe(true);

    // With the orphan gone, the exact rename that failed above now succeeds —
    // proving the sweep is what unblocks a real reify, not just a directory
    // deletion in isolation.
    expect(() => fs.renameSync(packageRoot, stagingPath)).not.toThrow();
    expect(fs.existsSync(stagingPath)).toBe(true);
    expect(fs.existsSync(packageRoot)).toBe(false);
  });

  it('leaves an unrelated dotfile and a differently-named sibling alone', async () => {
    const scopeDir = makeTempDir('sweep-scope-safe');
    const packageRoot = path.join(scopeDir, 'agents-cli');
    fs.mkdirSync(packageRoot);

    const unrelatedDotfile = path.join(scopeDir, '.DS_Store');
    fs.writeFileSync(unrelatedDotfile, '');
    const otherPackageStaging = path.join(scopeDir, '.some-other-pkg-abcd1234');
    fs.mkdirSync(otherPackageStaging);

    const swept = await sweepStaleInstallStaging(packageRoot);

    expect(swept).toEqual([]);
    expect(fs.existsSync(unrelatedDotfile)).toBe(true);
    expect(fs.existsSync(otherPackageStaging)).toBe(true);
  });

  it('returns an empty list when the scope dir does not exist', async () => {
    const missing = path.join(os.tmpdir(), `agents-self-update-missing-${Date.now()}`, 'agents-cli');
    expect(await sweepStaleInstallStaging(missing)).toEqual([]);
  });
});

describe('ensureGlobalBinLinks (PHNX-2768)', () => {
  const BIN = {
    agents: 'dist/index.js',
    ag: 'dist/index.js',
    browser: 'dist/browser.js',
    computer: 'dist/computer.js',
  };

  /**
   * A real npm-global-shaped POSIX install: `<prefix>/lib/node_modules/...`
   * with the four shipped bin targets on disk. Returns the prefix + package
   * root; the caller decides which (if any) `<prefix>/bin/*` links to create,
   * so a test can model the healthy box or the stranded one.
   */
  function makeInstall(label: string): { prefix: string; packageRoot: string; binDir: string } {
    const prefix = fs.realpathSync(makeTempDir(label));
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@phnx-labs/agents-cli', version: '1.22.40', bin: BIN }),
    );
    for (const rel of new Set(Object.values(BIN))) {
      fs.writeFileSync(path.join(packageRoot, rel), '#!/usr/bin/env node\n');
    }
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    return { prefix, packageRoot, binDir: path.join(prefix, 'bin') };
  }

  function linkResolvesTo(binDir: string, name: string, packageRoot: string): boolean {
    return (
      fs.realpathSync(path.join(binDir, name)) ===
      fs.realpathSync(path.join(packageRoot, BIN[name as keyof typeof BIN]))
    );
  }

  it('restores every bin link the upgrade left missing — the zion strand', async () => {
    // Reproduce the bug: package upgraded in place, but `<prefix>/bin/*` gone,
    // so `command -v agents` finds nothing on the box.
    const { prefix, packageRoot, binDir } = makeInstall('strand');
    for (const name of Object.keys(BIN)) {
      expect(fs.existsSync(path.join(binDir, name))).toBe(false);
    }

    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);

    // All four siblings restored, not just `agents`.
    expect(repairs.map((r) => r.name).sort()).toEqual(['ag', 'agents', 'browser', 'computer']);
    expect(repairs.every((r) => r.action === 'repaired')).toBe(true);
    for (const name of Object.keys(BIN)) {
      expect(linkResolvesTo(binDir, name, packageRoot)).toBe(true);
      // Relative link, mirroring npm's own bin links and the by-hand repair.
      expect(fs.readlinkSync(path.join(binDir, name)).startsWith('..')).toBe(true);
    }
  });

  it('leaves already-correct links untouched — the healthy path still works', async () => {
    const { prefix, packageRoot, binDir } = makeInstall('healthy');
    for (const [name, rel] of Object.entries(BIN)) {
      const linkPath = path.join(binDir, name);
      fs.symlinkSync(path.relative(binDir, path.join(packageRoot, rel)), linkPath);
    }
    const before = Object.fromEntries(
      Object.keys(BIN).map((name) => [name, fs.readlinkSync(path.join(binDir, name))]),
    );

    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);

    expect(repairs.every((r) => r.action === 'ok')).toBe(true);
    // Untouched: same link content, still resolving.
    for (const name of Object.keys(BIN)) {
      expect(fs.readlinkSync(path.join(binDir, name))).toBe(before[name]);
      expect(linkResolvesTo(binDir, name, packageRoot)).toBe(true);
    }
  });

  it('repairs a dangling or stale link pointing at a foreign path', async () => {
    const { prefix, packageRoot, binDir } = makeInstall('stale');
    // `agents` points at a since-removed old install; the others are missing.
    fs.symlinkSync('/nonexistent/old-install/dist/index.js', path.join(binDir, 'agents'));

    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);

    expect(repairs.every((r) => r.action === 'repaired')).toBe(true);
    for (const name of Object.keys(BIN)) {
      expect(linkResolvesTo(binDir, name, packageRoot)).toBe(true);
    }
  });

  it('reports a link it cannot make resolve as failed — never a silent pass', async () => {
    const { prefix, packageRoot, binDir } = makeInstall('unrepairable');
    // The upgrade landed the package.json but not the `agents` entry target,
    // so the link can be created but can never resolve.
    fs.rmSync(path.join(packageRoot, 'dist', 'index.js'));

    const repairs = await ensureGlobalBinLinks(packageRoot, prefix);

    const failed = repairs.filter((r) => r.action === 'failed');
    // agents + ag both target the missing dist/index.js.
    expect(failed.map((r) => r.name).sort()).toEqual(['ag', 'agents']);
    expect(failed[0].error).toBeTruthy();
    // browser + computer still repaired — one bad target does not abort the rest.
    expect(repairs.filter((r) => r.action === 'repaired').map((r) => r.name).sort()).toEqual([
      'browser',
      'computer',
    ]);
    expect(linkResolvesTo(binDir, 'browser', packageRoot)).toBe(true);
  });

  it('fails loud when package.json cannot be read', async () => {
    const prefix = fs.realpathSync(makeTempDir('nopkg'));
    const packageRoot = path.join(prefix, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(packageRoot, { recursive: true });
    await expect(ensureGlobalBinLinks(packageRoot, prefix)).rejects.toThrow(/could not read bin entries/);
  });
});

describe('resolveRunningPackageRoot', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeInstall(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-root-'));
    roots.push(tmp);
    const root = path.join(tmp, 'lib', 'node_modules', '@phnx-labs', 'agents-cli');
    fs.mkdirSync(path.join(root, 'dist', 'lib', 'daemon'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'lib', 'self-heal', 'checks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NPM_PACKAGE_NAME, version: '1.0.0' }));
    return root;
  }

  it('walks up from a module nested under dist/lib/… to the package root, not one level up', () => {
    // The daemon's self-update tick called this from dist/lib/daemon and got
    // `dist/lib` back, so deriveGlobalPrefix threw "not an npm-managed install"
    // on every tick, fleet-wide — the running daemon never relaunched onto a
    // release (2026-09-07).
    const root = makeInstall();
    expect(resolveRunningPackageRoot(path.join(root, 'dist', 'lib', 'daemon'))).toBe(root);
    expect(resolveRunningPackageRoot(path.join(root, 'dist', 'lib', 'self-heal', 'checks'))).toBe(root);
    expect(resolveRunningPackageRoot(path.join(root, 'dist'))).toBe(root);
    expect(() => deriveGlobalPrefix(resolveRunningPackageRoot(path.join(root, 'dist', 'lib', 'daemon')))).not.toThrow();
  });

  it('fails loud when no package.json naming this package exists above the module', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-noroot-'));
    roots.push(tmp);
    const nested = path.join(tmp, 'dist', 'lib');
    fs.mkdirSync(nested, { recursive: true });
    expect(() => resolveRunningPackageRoot(nested)).toThrow(/no @phnx-labs\/agents-cli package.json above/);
  });
});

describe('installLooksSettled', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeInstall(bin: string | Record<string, string> | undefined, opts: { writeBins?: boolean } = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-settled-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: NPM_PACKAGE_NAME, version: '1.0.0', bin }));
    if (opts.writeBins !== false) {
      const targets = typeof bin === 'string' ? [bin] : Object.values(bin ?? {});
      for (const rel of targets) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), '#!/usr/bin/env node\n');
      }
    }
    return root;
  }

  it('a package.json written moments ago is not settled, the same tree a minute later is', () => {
    const root = makeInstall({ agents: 'dist/index.js', ag: 'dist/index.js' });
    const written = fs.statSync(path.join(root, 'package.json')).mtimeMs;
    expect(installLooksSettled(root, 60_000, written + 5_000)).toBe(false);
    expect(installLooksSettled(root, 60_000, written + 61_000)).toBe(true);
  });

  it('a settled package.json whose bin entry has not landed yet is not settled (bun mid-extraction)', () => {
    const root = makeInstall('dist/index.js', { writeBins: false });
    const written = fs.statSync(path.join(root, 'package.json')).mtimeMs;
    expect(installLooksSettled(root, 60_000, written + 61_000)).toBe(false);
  });

  it('an unreadable or missing package.json is never settled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-settled-none-'));
    roots.push(root);
    expect(installLooksSettled(root, 60_000)).toBe(false);
  });
});
