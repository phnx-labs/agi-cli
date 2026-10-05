import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-installscripts-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const npmInstallCapture = vi.hoisted(() => ({ argv: undefined as string[] | undefined }));
const execCalls = vi.hoisted(() => ({ list: [] as Array<{ file: string; args: string[]; cwd?: string; shell?: boolean }> }));
const behavior = vi.hoisted(() => ({ failPostinstall: false }));
const npmView = vi.hoisted(() => ({ version: '2.1.187' }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFileMock = vi.fn((file, args, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = (typeof options === 'function' ? {} : options) ?? {};
    const argv: string[] = Array.isArray(args) ? args : [];
    if (file === 'npm' && argv[0] === 'install') {
      npmInstallCapture.argv = argv;
      if (cb) cb(null, 'mock npm install success', '');
    } else if (file === 'npm' && argv[0] === '--version') {
      if (cb) cb(null, '10.0.0', '');
    } else if (file === 'npm' && argv[0] === 'view') {
      if (cb) cb(null, `${npmView.version}\n`, '');
    } else {
      execCalls.list.push({ file, args: argv, cwd: (opts as any).cwd, shell: (opts as any).shell });
      const isPostinstall = (opts as any).shell === true && argv.length === 0;
      if (isPostinstall && behavior.failPostinstall) {
        if (cb) cb(new Error('mock postinstall failed'), '', 'boom');
      } else if (cb) {
        cb(null, '', '');
      }
    }
    return undefined;
  });
  (execFileMock as any)[promisify.custom] = (file: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) => {
      execFileMock(file, args, options as never, (err: Error | null, stdout: string, stderr: string) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      );
    });
  return { ...actual, execFile: execFileMock };
});

beforeEach(() => {
  npmInstallCapture.argv = undefined;
  execCalls.list = [];
  behavior.failPostinstall = false;
});

function postinstallCalls() {
  return execCalls.list.filter(c => c.shell === true && c.args.length === 0);
}

function stageInstall(home: string, agent: string, npmPackage: string, version: string, scripts?: Record<string, string>): string {
  const versionDir = path.join(home, '.agents', '.history', 'versions', agent, version);
  const binDir = path.join(versionDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cli = agent === 'claude' ? 'claude' : agent;
  fs.writeFileSync(path.join(binDir, cli), `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(path.join(binDir, cli), 0o755);
  const pkgRoot = path.join(versionDir, 'node_modules', ...npmPackage.split('/'));
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: npmPackage, version, ...(scripts ? { scripts } : {}) }));
  return pkgRoot;
}

describe('installVersion npm install argv', () => {
  it('includes --ignore-scripts in npm install arguments', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./installations/versions.js');
      const binDir = path.join(home, '.agents', '.history', 'versions', 'codex', '0.116.0', 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\necho 0.116.0\n');
      fs.chmodSync(path.join(binDir, 'codex'), 0o755);
      const result = await installVersion('codex', '0.116.0');
      expect(result.success).toBe(true);
      expect(npmInstallCapture.argv).toBeDefined();
      expect(npmInstallCapture.argv).toContain('install');
      expect(npmInstallCapture.argv).toContain('--ignore-scripts');
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('installVersion latest-alias resolution', () => {
  it('resolves `latest` to a concrete version up front and installs a pinned spec (no shared `latest/` dir)', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      npmView.version = '2.1.187';
      const { installVersion } = await import('./installations/versions.js');
      stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.187');

      const result = await installVersion('claude', 'latest');

      expect(result.success).toBe(true);
      expect(result.installedVersion).toBe('2.1.187');
      expect(npmInstallCapture.argv).toContain('@anthropic-ai/claude-code@2.1.187');
      expect(npmInstallCapture.argv).not.toContain('@anthropic-ai/claude-code');
      const versionsRoot = path.join(home, '.agents', '.history', 'versions', 'claude');
      expect(fs.existsSync(path.join(versionsRoot, '2.1.187'))).toBe(true);
      expect(fs.existsSync(path.join(versionsRoot, 'latest'))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('fails cleanly when npm cannot resolve `latest`', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      npmView.version = '';
      const { installVersion } = await import('./installations/versions.js');
      const result = await installVersion('claude', 'latest');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Could not resolve the latest/);
      expect(npmInstallCapture.argv).toBeUndefined();
      const versionsRoot = path.join(home, '.agents', '.history', 'versions', 'claude');
      expect(fs.existsSync(path.join(versionsRoot, 'latest'))).toBe(false);
    } finally {
      npmView.version = '2.1.187';
      process.env.HOME = originalHome;
    }
  });
});

describe('installVersion first-party postinstall', () => {
  it('runs the package postinstall (never prepare), scoped to the package root', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./installations/versions.js');
      const pkgRoot = stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', {
        postinstall: 'node install.cjs',
        prepare: "node -e \"process.exit(1)\"",
      });
      const result = await installVersion('claude', '2.1.186');
      expect(result.success).toBe(true);

      const posts = postinstallCalls();
      expect(posts).toHaveLength(1);
      expect(posts[0].file).toBe('node install.cjs');
      expect(posts[0].cwd).toBe(pkgRoot);
      expect(execCalls.list.some(c => /process\.exit\(1\)/.test(c.file))).toBe(false);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('is a no-op when the package declares no postinstall', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { installVersion } = await import('./installations/versions.js');
      stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', { build: 'tsc' });
      const result = await installVersion('claude', '2.1.186');
      expect(result.success).toBe(true);
      expect(postinstallCalls()).toHaveLength(0);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('is best-effort: a failing postinstall does not throw or fail the install', async () => {
    const home = makeTempHome();
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      behavior.failPostinstall = true;
      const { installVersion } = await import('./installations/versions.js');
      stageInstall(home, 'claude', '@anthropic-ai/claude-code', '2.1.186', { postinstall: 'node install.cjs' });
      const result = await installVersion('claude', '2.1.186');
      expect(postinstallCalls()).toHaveLength(1);
      expect(result.success).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });
});

describe('isMissingBinarySignature', () => {
  it('matches the claude gutted-stub phrases and the generic ENOENT signatures', async () => {
    vi.resetModules();
    const { isMissingBinarySignature } = await import('./installations/versions.js');
    expect(isMissingBinarySignature('spawn /x/claude ENOENT')).toBe(true);
    expect(isMissingBinarySignature("'…claude.exe' is not recognized")).toBe(true);
    expect(isMissingBinarySignature('Error: claude native binary not installed.')).toBe(true);
    expect(isMissingBinarySignature('Either postinstall did not run')).toBe(true);
    expect(isMissingBinarySignature('the platform-native optional dependency was not downloaded')).toBe(true);
  });

  it('never matches a healthy --version banner', async () => {
    vi.resetModules();
    const { isMissingBinarySignature } = await import('./installations/versions.js');
    expect(isMissingBinarySignature('2.1.186 (Claude Code)')).toBe(false);
    expect(isMissingBinarySignature('codex-cli 0.116.0')).toBe(false);
  });
});
