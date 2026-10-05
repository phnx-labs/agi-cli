import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseCliManifest,
  selectInstallMethod,
  describeMethod,
  buildInstallCommand,
  resolveBinDir,
  hasCommand,
  isCliInstalled,
  isCliInstalledAsync,
  npmPin,
  owningNpmPrefix,
  upgradeCliToPin,
  installedCliVersion,
  type CliManifest,
  type InstallMethod,
} from './cli-resources.js';

function manifest(install: InstallMethod[]): CliManifest {
  return {
    name: 'higgsfield',
    description: 'test',
    check: { kind: 'version', cmd: 'higgsfield', args: ['--version'] },
    install,
    source: 'user',
    path: '/tmp/test.yaml',
  };
}

describe('parseCliManifest', () => {
  it('parses a multi-method manifest with post_install', () => {
    const yaml = `
name: higgsfield
description: AI media CLI
homepage: https://higgsfield.ai/cli
check: higgsfield --version
install:
  - npm: "@higgsfield/cli@latest"
  - brew: higgsfield
  - script: https://example.com/install.sh
post_install: |
  Run higgsfield auth login.
`;
    const parsed = parseCliManifest(yaml, { name: 'higgsfield', source: 'user', path: '/tmp/h.yaml' });
    expect(parsed.name).toBe('higgsfield');
    expect(parsed.description).toBe('AI media CLI');
    expect(parsed.check).toEqual({ kind: 'version', cmd: 'higgsfield', args: ['--version'] });
    expect(parsed.install).toHaveLength(3);
    expect(parsed.install[0]).toEqual({ npm: '@higgsfield/cli@latest' });
    expect(parsed.install[1]).toEqual({ brew: 'higgsfield' });
    expect(parsed.install[2]).toEqual({ script: 'https://example.com/install.sh' });
    expect(parsed.postInstall).toMatch(/auth login/);
  });

  it('defaults check to "<name> --version" when omitted', () => {
    const parsed = parseCliManifest(
      'name: gh\ninstall:\n  - brew: gh\n',
      { name: 'gh', source: 'user', path: '/tmp/g.yaml' },
    );
    expect(parsed.check).toEqual({ kind: 'version', cmd: 'gh', args: ['--version'] });
  });

  it('uses the filename-derived name when manifest omits it', () => {
    const parsed = parseCliManifest(
      'install:\n  - brew: glab\n',
      { name: 'glab', source: 'user', path: '/tmp/glab.yaml' },
    );
    expect(parsed.name).toBe('glab');
  });

  it('tolerates a double-quoted Windows-style path in a display-only field', () => {
    // A double-quoted YAML string with `C:\Users\...` trips the strict parser (`\U` is invalid).
    // parseCliManifest uses strict:false, so the manifest must load, not throw.
    const raw = 'name: gh\ndescription: "Binary at C:\\Users\\foo"\ninstall:\n  - brew: gh\n';
    const parsed = parseCliManifest(raw, { name: 'gh', source: 'user', path: '/tmp/g.yaml' });
    expect(parsed.name).toBe('gh');
    expect(parsed.description).toBeDefined();
  });

  it('rejects a Windows-style path in check.cmd even after tolerant parse', () => {
    // Even with strict:false the security validator runs on check.cmd.
    // Backslash and colon are not in SAFE_CHECK_TOKEN, so the path is rejected.
    const raw =
      'name: gh\ncheck:\n  kind: version\n  cmd: "C:\\\\bin\\\\gh"\ninstall:\n  - brew: gh\n';
    expect(() =>
      parseCliManifest(raw, { name: 'gh', source: 'user', path: '/tmp/g.yaml' }),
    ).toThrow(/unsafe token/);
  });

  it('rejects an empty install list', () => {
    expect(() =>
      parseCliManifest('name: x\ninstall: []\n', { name: 'x', source: 'user', path: '/x' }),
    ).toThrow(/non-empty list/);
  });

  it('rejects an install entry with no recognized method', () => {
    expect(() =>
      parseCliManifest(
        'name: x\ninstall:\n  - apt: x\n',
        { name: 'x', source: 'user', path: '/x' },
      ),
    ).toThrow(/unknown method/);
  });

  it('rejects an install entry with multiple methods declared', () => {
    expect(() =>
      parseCliManifest(
        'name: x\ninstall:\n  - npm: x\n    brew: x\n',
        { name: 'x', source: 'user', path: '/x' },
      ),
    ).toThrow(/exactly one method/);
  });

  it('parses a binary platform map with extract path', () => {
    const yaml = `
name: x
install:
  - binary:
      darwin-arm64:
        url: https://example.com/x-darwin.tgz
        extract: x
      linux-x64:
        url: https://example.com/x-linux.tgz
        extract: x
`;
    const parsed = parseCliManifest(yaml, { name: 'x', source: 'user', path: '/x' });
    expect(parsed.install).toHaveLength(1);
    const m = parsed.install[0];
    expect('binary' in m).toBe(true);
    if ('binary' in m) {
      expect(m.binary['darwin-arm64'].url).toBe('https://example.com/x-darwin.tgz');
      expect(m.binary['darwin-arm64'].extract).toBe('x');
    }
  });
});

describe('describeMethod', () => {
  it('renders npm/brew/script', () => {
    expect(describeMethod({ npm: 'foo@1.0' })).toBe('npm install -g foo@1.0');
    expect(describeMethod({ brew: 'foo' })).toBe('brew install foo');
    expect(describeMethod({ script: 'https://x' })).toBe('curl https://x | sh');
  });
});

describe('buildInstallCommand', () => {
  it('builds the npm and brew shell strings exactly', () => {
    expect(buildInstallCommand({ npm: '@higgsfield/cli@latest' }))
      .toBe('npm install -g @higgsfield/cli@latest');
    expect(buildInstallCommand({ brew: 'higgsfield' }))
      .toBe('brew install higgsfield');
  });
});

describe('resolveBinDir', () => {
  const key = `${process.platform}-${process.arch}`;
  const savedBinDirEnv = process.env.AGENTS_CLI_BIN_DIR;
  const savedHome = process.env.HOME;
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so pinning
  // only HOME leaves resolveBinDir() pointing at the runner's real profile.
  const savedUserProfile = process.env.USERPROFILE;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-bindir-'));
    delete process.env.AGENTS_CLI_BIN_DIR;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(() => {
    if (savedBinDirEnv === undefined) delete process.env.AGENTS_CLI_BIN_DIR;
    else process.env.AGENTS_CLI_BIN_DIR = savedBinDirEnv;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('honors AGENTS_CLI_BIN_DIR when set, without touching the filesystem', () => {
    const override = path.join(tmpHome, 'custom-bin-dir');
    process.env.AGENTS_CLI_BIN_DIR = override;
    expect(resolveBinDir()).toBe(override);
    expect(fs.existsSync(override)).toBe(false);
  });

  it('creates and prefers ~/.local/bin over /usr/local/bin when it is writable', () => {
    const expected = path.join(tmpHome, '.local', 'bin');
    expect(fs.existsSync(expected)).toBe(false);
    expect(resolveBinDir()).toBe(expected);
    expect(fs.statSync(expected).isDirectory()).toBe(true);
  });

  it('falls back off ~/.local/bin when it cannot be created (e.g. path is a file)', () => {
    // Force `mkdirSync(~/.local/bin, { recursive: true })` to fail with ENOTDIR
    // by making ~/.local a regular file instead of a directory. tmpHome already
    // exists (mkdtempSync created it above).
    fs.writeFileSync(path.join(tmpHome, '.local'), 'not a directory');

    let usrLocalBinWritable = true;
    try {
      fs.accessSync('/usr/local/bin', fs.constants.W_OK);
    } catch {
      usrLocalBinWritable = false;
    }

    if (usrLocalBinWritable) {
      expect(resolveBinDir()).toBe('/usr/local/bin');
    } else {
      // Matches the reported bug: /usr/local/bin not user-writable (e.g. on
      // Apple Silicon Macs). The failure must be an actionable error, not a
      // raw EACCES surfaced later from curl/tar.
      expect(() => resolveBinDir()).toThrow(/AGENTS_CLI_BIN_DIR/);
      expect(() => resolveBinDir()).toThrow(/\.local\/bin/);
    }
  });

  it('buildInstallCommand embeds the same resolved directory for tar and curl', () => {
    const method: InstallMethod = {
      binary: { [key]: { url: 'https://example.com/x-bin.tgz', extract: 'x' } },
    };
    const binDir = resolveBinDir();
    expect(buildInstallCommand(method)).toBe(
      `curl -fsSL https://example.com/x-bin.tgz -o /tmp/agents-cli-bin.tgz && tar -xzf /tmp/agents-cli-bin.tgz -C ${binDir} x`,
    );

    const flatMethod: InstallMethod = {
      binary: { [key]: { url: 'https://example.com/x-bin' } },
    };
    expect(buildInstallCommand(flatMethod)).toBe(
      `curl -fsSL https://example.com/x-bin -o ${path.join(binDir, 'agents-cli-downloaded')}`,
    );
  });
});

describe('selectInstallMethod', () => {
  // selectInstallMethod calls hasCommand() which probes the real host.
  // We can still validate the "no compatible method" path deterministically.
  it('returns null when only an unsupported-platform binary is declared', () => {
    const m = manifest([{ binary: { 'plan9-mips': { url: 'http://x' } } }]);
    expect(selectInstallMethod(m)).toBeNull();
  });

  it('returns the only npm method on a host with npm (this dev box has npm)', () => {
    // We rely on the dev environment having npm; if it doesn't, this test is
    // skipped at the assertion level rather than failing.
    const m = manifest([{ npm: 'foo' }]);
    const picked = selectInstallMethod(m);
    if (picked) {
      expect(picked).toEqual({ npm: 'foo' });
    }
  });
});

describe('host detection', () => {
  it('hasCommand finds node and rejects garbage on every platform', () => {
    // node is guaranteed: it is running this test.
    expect(hasCommand('node')).toBe(true);
    expect(hasCommand('definitely-not-a-real-command-xyz')).toBe(false);
  });

  it('isCliInstalled is false for a version check on a missing command', () => {
    const m = manifest([{ npm: 'foo' }]);
    m.check = { kind: 'version', cmd: 'definitely-not-a-real-command-xyz', args: ['--version'] };
    expect(isCliInstalled(m)).toBe(false);
  });

  it('isCliInstalledAsync (RUSH-2136) matches the sync check on real commands', async () => {
    // node is guaranteed (it runs this test): a version check exits 0 => installed.
    const present = manifest([{ npm: 'foo' }]);
    present.check = { kind: 'version', cmd: 'node', args: ['--version'] };
    expect(await isCliInstalledAsync(present)).toBe(true);
    expect(isCliInstalled(present)).toBe(true);

    const missing = manifest([{ npm: 'foo' }]);
    missing.check = { kind: 'version', cmd: 'definitely-not-a-real-command-xyz', args: ['--version'] };
    expect(await isCliInstalledAsync(missing)).toBe(false);
    expect(isCliInstalled(missing)).toBe(false);

    // A present command that exits non-zero is NOT installed (a failed run, not a
    // missing binary) — same verdict as the sync path.
    const nonZero = manifest([{ npm: 'foo' }]);
    nonZero.check = { kind: 'version', cmd: 'node', args: ['--definitely-not-a-flag'] };
    expect(await isCliInstalledAsync(nonZero)).toBe(false);
  });

  describe.runIf(process.platform === 'win32')('win32 .cmd shims', () => {
    // npm installs and script installers put `.cmd`/`.bat` shims on PATH, which
    // Node cannot spawn without a shell — the version check must still pass.
    let tmpDir: string | undefined;
    const savedPath = process.env.Path ?? process.env.PATH;

    afterEach(() => {
      if (process.env.Path !== undefined) process.env.Path = savedPath;
      else process.env.PATH = savedPath;
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    });

    it('isCliInstalled passes a version check backed by a .cmd shim', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-shim-'));
      fs.writeFileSync(path.join(tmpDir, 'fake-shim-tool.cmd'), '@exit /b 0\r\n');
      const key = process.env.Path !== undefined ? 'Path' : 'PATH';
      process.env[key] = `${tmpDir};${savedPath}`;
      const m = manifest([{ npm: 'foo' }]);
      m.check = { kind: 'version', cmd: 'fake-shim-tool', args: ['--version'] };
      expect(isCliInstalled(m)).toBe(true);
    });

    it('isCliInstalled stays false when the .cmd shim exits non-zero', () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-shim-'));
      fs.writeFileSync(path.join(tmpDir, 'fake-shim-fail.cmd'), '@exit /b 1\r\n');
      const key = process.env.Path !== undefined ? 'Path' : 'PATH';
      process.env[key] = `${tmpDir};${savedPath}`;
      const m = manifest([{ npm: 'foo' }]);
      m.check = { kind: 'version', cmd: 'fake-shim-fail', args: ['--version'] };
      expect(isCliInstalled(m)).toBe(false);
    });
  });
});

describe.skipIf(process.platform === 'win32')('version pins (host CLI auto-upgrade)', () => {
  let root: string;
  let savedPath: string | undefined;
  let savedRegistry: string | undefined;
  let savedRetries: string | undefined;

  function installFake(prefix: string, pkg: string, cmd: string, version: string): void {
    const pkgDir = path.join(prefix, 'lib', 'node_modules', ...pkg.split('/'));
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    const script = path.join(pkgDir, 'bin', 'cli.js');
    fs.writeFileSync(script, `#!/usr/bin/env node\nconsole.log('${version}');\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.symlinkSync(path.relative(path.join(prefix, 'bin'), script), path.join(prefix, 'bin', cmd));
  }

  function pinned(cmd: string, npm: string): CliManifest {
    return { name: cmd, check: { kind: 'version', cmd, args: ['--version'] }, install: [{ npm }], source: 'user', path: '/tmp/t.yaml' };
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pin-'));
    savedPath = process.env.PATH;
    savedRegistry = process.env.npm_config_registry;
    savedRetries = process.env.npm_config_fetch_retries;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedRegistry === undefined) delete process.env.npm_config_registry; else process.env.npm_config_registry = savedRegistry;
    if (savedRetries === undefined) delete process.env.npm_config_fetch_retries; else process.env.npm_config_fetch_retries = savedRetries;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads an exact npm pin and ignores tags and unpinned specs', () => {
    expect(npmPin(pinned('x', '@phnx-labs/secrets-cli@0.1.8'))).toEqual({ pkg: '@phnx-labs/secrets-cli', version: '0.1.8' });
    expect(npmPin(pinned('x', '@higgsfield/cli@latest'))).toBeNull();
    expect(npmPin(pinned('x', '@scope/tool'))).toBeNull();
    expect(npmPin(manifest([{ brew: 'gh' }]))).toBeNull();
  });

  it('resolves the prefix that owns the binary on PATH, not npm\'s own prefix', () => {
    const prefix = path.join(root, 'local');
    installFake(prefix, '@acme/pin-tool', 'pin-tool-a', '0.1.0');
    process.env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${savedPath}`;
    expect(owningNpmPrefix('pin-tool-a', '@acme/pin-tool')).toBe(fs.realpathSync(prefix));
    expect(owningNpmPrefix('pin-tool-a', '@acme/other')).toBeNull();
  });

  it('reports a binary at or above its pin as current and never downgrades it', async () => {
    const prefix = path.join(root, 'local');
    installFake(prefix, '@acme/pin-tool', 'pin-tool-b', '0.2.0');
    process.env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${savedPath}`;
    expect(await upgradeCliToPin(pinned('pin-tool-b', '@acme/pin-tool@0.1.9'))).toEqual({ name: 'pin-tool-b', status: 'current', version: '0.2.0' });
  });

  it('never installs a missing tool', async () => {
    expect(await upgradeCliToPin(pinned('pin-tool-absent-xyz', '@acme/pin-tool@0.1.0'))).toMatchObject({ status: 'skipped' });
  });

  it('refuses to upgrade a binary that is not an npm install of the pinned package', async () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pin-tool-c'), '#!/bin/sh\necho 0.1.0\n', { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    const r = await upgradeCliToPin(pinned('pin-tool-c', '@acme/pin-tool@0.2.0'));
    expect(r).toMatchObject({ status: 'skipped' });
    expect((r as { reason: string }).reason).toMatch(/outdated \(0\.1\.0 < 0\.2\.0\).*not an npm install/);
  });

  it('leaves the old version in place when the install fails', async () => {
    const prefix = path.join(root, 'local');
    installFake(prefix, '@acme/pin-tool', 'pin-tool-d', '0.1.0');
    process.env.PATH = `${path.join(prefix, 'bin')}${path.delimiter}${savedPath}`;
    process.env.npm_config_registry = 'http://127.0.0.1:9/';
    process.env.npm_config_fetch_retries = '0';
    const m = pinned('pin-tool-d', '@acme/pin-tool@0.2.0');
    const r = await upgradeCliToPin(m);
    expect(r).toMatchObject({ name: 'pin-tool-d', status: 'failed' });
    expect(await installedCliVersion(m)).toBe('0.1.0');
  }, 60_000);
});
