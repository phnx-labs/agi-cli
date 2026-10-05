import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = process.cwd();
const entrypoint = path.join(repoRoot, 'src/index.ts');

function writeExecutable(filePath: string, body: string): void {
  fs.writeFileSync(filePath, body, 'utf-8');
  fs.chmodSync(filePath, 0o755);
  if (process.platform === 'win32') {
    fs.writeFileSync(filePath + '.cmd', `@echo off\r\nnode "${filePath}" %*\r\n`, 'utf-8');
  }
}

describe('agents run defaults', () => {
  let home: string;
  let binDir: string;
  let projectDir: string;
  let argvPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-run-defaults-test-'));
    binDir = path.join(home, 'bin');
    projectDir = path.join(home, 'project');
    argvPath = path.join(home, 'argv.json');
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const managedBinDir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.45', 'node_modules', '.bin');
    fs.mkdirSync(managedBinDir, { recursive: true });
    const versionHomeDir = path.join(home, '.agents', '.history', 'versions', 'claude', '2.1.45', 'home');
    fs.mkdirSync(path.join(versionHomeDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(versionHomeDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'fixture@example.com' } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(versionHomeDir, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: 1 } }),
      'utf-8',
    );
    const captureArgvScript = [
      '#!/usr/bin/env node',
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
    ].join('\n');
    writeExecutable(path.join(managedBinDir, 'claude'), captureArgvScript);
    writeExecutable(path.join(binDir, 'claude'), captureArgvScript);
    fs.writeFileSync(
      path.join(home, '.agents', 'agents.yaml'),
      [
        'agents:',
        '  claude: "2.1.45"',
        'run:',
        '  claude:',
        '    strategy: pinned',
        '  defaults:',
        '    "claude:*":',
        '      mode: auto',
        '      model: opus',
        '',
      ].join('\n'),
      'utf-8',
    );
    writeExecutable(path.join(binDir, 'claude@2.1.45'), captureArgvScript);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('applies configured mode and model when flags are omitted', () => {
    execFileSync('bun', [entrypoint, 'run', 'claude', 'hello', '--quiet', '--headless'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf-8')) as string[];
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
    expect(argv).toContain('--print');
    expect(argv).toContain('hello');
  });

  it('lets project-local defaults override user defaults field by field', () => {
    fs.writeFileSync(
      path.join(projectDir, 'agents.yaml'),
      [
        'run:',
        '  defaults:',
        '    "claude:2.1.45":',
        '      mode: plan',
        '',
      ].join('\n'),
      'utf-8',
    );

    execFileSync('bun', [entrypoint, 'run', 'claude', 'hello', '--quiet', '--headless'], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_NO_AUTOPULL: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf-8')) as string[];
    expect(argv).toContain('--permission-mode');
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('opus');
  });
});
