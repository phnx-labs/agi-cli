/** Real-CLI subprocess tests for `agents packages materialize` (PHNX-3838), no mocks, writing only
 * under a temp output home. A thin front door over agent-spec/materialize.ts, so they prove the
 * wiring (receipt, resources) and the guards (harness allowlist, live-home refusal, path escape). */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_HARNESSES, type MaterializationReceipt } from './packages-materialize.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'testdata',
  'portable-agent-package',
);

const tempDirs: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-packages-materialize-home-'));
  tempDirs.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return home;
}

function runCli(
  home: string,
  args: string[],
): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_SKIP_MIGRATION: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_NO_UPDATE_CHECK: '1',
    },
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agents packages materialize help', () => {
  it('teaches the Factory workflow before the flag list', () => {
    const home = makeHome();
    const { stdout, stderr, status } = runCli(home, ['packages', 'materialize', '--help']);
    const help = `${stdout}${stderr}`;
    expect(status).toBe(0);
    expect(help).toContain('--json');
    expect(help).toMatch(/Factory/);
    expect(help).toContain('--harness');
    expect(help).toContain('--output-home');
    expect(help).toContain('claude');
    expect(help).toContain('codex');
    expect(help).toContain('opencode');
    const examplesAt = help.indexOf('Examples:');
    const optionsAt = help.indexOf('Options:');
    expect(examplesAt).toBeGreaterThan(-1);
    expect(optionsAt).toBeGreaterThan(-1);
    expect(examplesAt).toBeLessThan(optionsAt);
    expect(help).toContain('schema_version');
    expect(help).not.toContain('schemaVersion');
  });
});

describe('agents packages materialize', () => {
  it.each(PORTABLE_HARNESSES)('emits a canonical receipt for %s without touching the live home', (harness) => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), `agents-mat-${harness}-`));
    tempDirs.push(outputHome);

    const { stdout, stderr, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      harness,
      '--harness-version',
      '1.2.3',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status, stderr).toBe(0);
    const receipt = JSON.parse(stdout) as MaterializationReceipt;
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.agent.ref).toMatch(/^reviewer@[a-f0-9]{12}$/);
    expect(receipt.agent.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.harness).toEqual({ id: harness, version: '1.2.3' });

    const kinds = receipt.resources.map((r) => r.kind).sort();
    expect(kinds).toEqual(['instructions', 'skills']);
    for (const entry of receipt.resources) {
      expect(fs.existsSync(path.join(outputHome, entry.target)), `${entry.kind}:${entry.name}`).toBe(true);
    }

    const onDisk = fs.readFileSync(path.join(outputHome, 'materialization-receipt.json'), 'utf-8');
    expect(JSON.parse(onDisk)).toEqual(receipt);

    expect(fs.existsSync(path.join(home, `.${harness}`))).toBe(false);
    expect(stderr).not.toMatch(/secret/i);
  });

  it('rejects an invalid package', () => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-invalid-'));
    tempDirs.push(outputHome);
    const bogus = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-not-a-pkg-'));
    tempDirs.push(bogus);

    const { stdout, stderr, status } = runCli(home, [
      'packages',
      'materialize',
      bogus,
      '--harness',
      'claude',
      '--harness-version',
      '1.0.0',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/agent\.yaml not found/i);
    expect(stderr + stdout).toMatch(/agent\.yaml not found/i);
  });

  it('rejects an unsupported harness', () => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-unsup-'));
    tempDirs.push(outputHome);

    const { stdout, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      'gemini',
      '--harness-version',
      '1.0.0',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Unsupported capability/i);
    expect(payload.error).toMatch(/gemini/);
  });

  it('refuses to write into the live ~/.claude home', () => {
    const home = makeHome();
    const live = path.join(home, '.claude');
    fs.mkdirSync(live);

    const { stdout, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      'claude',
      '--harness-version',
      '1.0.0',
      '--output-home',
      live,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Path escape/i);
    expect(fs.existsSync(path.join(live, 'agent.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(live, 'materialization-receipt.json'))).toBe(false);
  });

  it('refuses a package whose hook name traverses out of the hooks dir, writing nothing outside', () => {
    const home = makeHome();
    const outputHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-hookname-'));
    tempDirs.push(outputHome);

    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-evilhook-pkg-'));
    tempDirs.push(pkg);
    fs.writeFileSync(
      path.join(pkg, 'agent.yaml'),
      [
        'schema_version: 3',
        'name: Evil',
        'slug: evil',
        'execution:',
        '  mode: cloud',
        '  harnesses:',
        '    default: claude',
        '    supported: [claude]',
        '  instructions: instructions.md',
        '  hooks:',
        '    - hooks/evil.yaml',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(pkg, 'instructions.md'), '# Evil\n');
    fs.mkdirSync(path.join(pkg, 'hooks'));
    fs.writeFileSync(
      path.join(pkg, 'hooks', 'evil.yaml'),
      'name: ../../../../pwned\nscript: evil.sh\nevents:\n  - PostToolUse\n',
    );
    fs.writeFileSync(path.join(pkg, 'hooks', 'evil.sh'), '#!/bin/sh\necho pwned\n');

    const { stdout, status } = runCli(home, [
      'packages',
      'materialize',
      pkg,
      '--harness',
      'claude',
      '--harness-version',
      '2.1.0',
      '--output-home',
      outputHome,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/not a safe single path segment/i);
    expect(fs.existsSync(path.join(path.dirname(outputHome), 'pwned.sh'))).toBe(false);
    expect(fs.existsSync(path.join(outputHome, 'materialization-receipt.json'))).toBe(false);
  });

  it('rejects an output-path escape', () => {
    const home = makeHome();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mat-escape-'));
    tempDirs.push(sandbox);
    const outputHome = path.join(sandbox, 'home');
    fs.mkdirSync(outputHome);
    const escaped = `${outputHome}/../outside`;

    const { stdout, status } = runCli(home, [
      'packages',
      'materialize',
      FIXTURE,
      '--harness',
      'claude',
      '--harness-version',
      '1.0.0',
      '--output-home',
      escaped,
      '--json',
    ]);

    expect(status).not.toBe(0);
    const payload = JSON.parse(stdout) as { error: string };
    expect(payload.error).toMatch(/Path escape/i);
    expect(fs.existsSync(path.join(sandbox, 'outside', 'materialization-receipt.json'))).toBe(false);
  });
});
