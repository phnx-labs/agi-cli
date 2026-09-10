import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installSecretsCli } from './secrets-cli-install.js';
import {
  SECRETS_CLI_SPEC,
  SECRETS_CLI_VERSION,
  builtinSecretsCliManifest,
  isSecretsPresent,
} from './secrets-cli.js';
import { isCliInstalled, resolveCliManifest } from './cli-resources.js';
import { findInPath } from './agent-spec/agents.js';
import { getShimsDir } from './state.js';
import { _resetSecretsClientForTest } from './secrets-client.js';

describe('builtin secrets host-CLI manifest', () => {
  it('pins the published package and is what resolveCliManifest returns without a yaml', () => {
    const builtin = builtinSecretsCliManifest();
    expect(builtin.name).toBe('secrets');
    expect(builtin.source).toBe('builtin');
    expect(builtin.install).toEqual([{ npm: SECRETS_CLI_SPEC }]);
    const resolved = resolveCliManifest('secrets', fs.mkdtempSync(path.join(os.tmpdir(), 'agents-no-clis-')));
    expect(resolved?.source).toBe('builtin');
    expect(resolved?.install).toEqual([{ npm: SECRETS_CLI_SPEC }]);
  });
});

describe('isCliInstalled for secrets uses findInPath (skips shims)', () => {
  const savedPath = process.env.PATH;
  const savedBin = process.env.SECRETS_BIN;

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    else process.env.SECRETS_BIN = savedBin;
    _resetSecretsClientForTest();
  });

  it('reports missing when PATH is empty', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
    expect(isSecretsPresent()).toBe(false);
    expect(isCliInstalled(builtinSecretsCliManifest())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('does not treat the leftover shims-dir alias as installed', () => {
    const shimsDir = getShimsDir();
    fs.mkdirSync(shimsDir, { recursive: true });
    const shim = path.join(shimsDir, 'secrets');
    fs.writeFileSync(shim, '#!/bin/sh\nexec agents secrets "$@"\n', { mode: 0o755 });
    try {
      delete process.env.SECRETS_BIN;
      process.env.PATH = shimsDir;
      _resetSecretsClientForTest();
      expect(findInPath('secrets')).toBeNull();
      expect(isCliInstalled(builtinSecretsCliManifest())).toBe(false);
    } finally {
      fs.rmSync(shim, { force: true });
    }
  });
});

describe('installSecretsCli', () => {
  const savedPath = process.env.PATH;
  const savedBin = process.env.SECRETS_BIN;

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedBin === undefined) delete process.env.SECRETS_BIN;
    else process.env.SECRETS_BIN = savedBin;
    _resetSecretsClientForTest();
  });

  it('is a no-op when the binary is already present', () => {
    const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-present-')), 'secrets');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.SECRETS_BIN = fake;
    _resetSecretsClientForTest();
    const result = installSecretsCli({ dryRun: true });
    expect(result).toEqual({ ok: true, alreadyInstalled: true, method: null });
  });

  it('prefers a declared clis/secrets.yaml over the builtin npm pin', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-clis-proj-'));
    try {
      const dir = path.join(project, '.agents', 'clis');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'secrets.yaml'),
        [
          'name: secrets',
          'check: secrets --version',
          'install:',
          `  - npm: "${SECRETS_CLI_SPEC}"`,
        ].join('\n') + '\n',
      );
      const resolved = resolveCliManifest('secrets', project);
      expect(resolved?.source).toBe('project');
      const result = installSecretsCli({ cwd: project, dryRun: true });
      expect(result).toEqual({ ok: true, alreadyInstalled: false, method: 'clis' });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  it('falls back to the pinned npm package when no yaml is declared', () => {
    delete process.env.SECRETS_BIN;
    process.env.PATH = '';
    _resetSecretsClientForTest();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-no-yaml-'));
    try {
      const result = installSecretsCli({ cwd, dryRun: true });
      expect(result).toEqual({ ok: true, alreadyInstalled: false, method: 'npm' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('installSecretsCli — real npm prefix install', () => {
  it(`installs ${SECRETS_CLI_SPEC} into an isolated prefix; secrets --version is ${SECRETS_CLI_VERSION}`, () => {
    const savedBin = process.env.SECRETS_BIN;
    const savedPath = process.env.PATH;
    delete process.env.SECRETS_BIN;
    process.env.PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
    _resetSecretsClientForTest();
    const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-npm-prefix-'));
    try {
      const result = installSecretsCli({
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'agents-secrets-npm-cwd-')),
        npmPrefix: prefix,
      });
      expect(result.ok, result.error).toBe(true);
      expect(result.method).toBe('npm');
      const bin = path.join(prefix, 'bin', 'secrets');
      expect(fs.existsSync(bin)).toBe(true);
      const ver = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 });
      expect(ver.status).toBe(0);
      expect((ver.stdout ?? '').trim()).toBe(SECRETS_CLI_VERSION);
    } finally {
      if (savedBin === undefined) delete process.env.SECRETS_BIN;
      else process.env.SECRETS_BIN = savedBin;
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      _resetSecretsClientForTest();
      fs.rmSync(prefix, { recursive: true, force: true });
    }
  }, 4 * 60 * 1000);
});
