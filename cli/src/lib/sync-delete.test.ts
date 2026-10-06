import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(CLI_ROOT, 'src', 'index.ts');
const FIXTURES = path.join(CLI_ROOT, 'src', 'lib', 'testdata', 'sync-delete');

let home = '';
let versionHome = '';

function run(args: string[]): { out: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: home,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_CLI_DISABLE_AUTO_UPDATE: '1',
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

const agentsDir = () => path.join(home, '.agents');
const commandFile = (name: string) => path.join(versionHome, '.claude', 'commands', `${name}.md`);
const pluginDir = (marketplace: string, name: string) =>
  path.join(versionHome, '.claude', 'plugins', 'marketplaces', marketplace, 'plugins', name);
const trash = (...parts: string[]) => path.join(agentsDir(), '.history', 'trash', ...parts);

function enabledPlugins(): string[] {
  const settings = JSON.parse(fs.readFileSync(path.join(versionHome, '.claude', 'settings.json'), 'utf-8'));
  return Object.keys(settings.enabledPlugins ?? {}).sort();
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delete-'));
  const systemDir = path.join(agentsDir(), '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(systemDir, '.update-check'), JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }));
  fs.cpSync(path.join(FIXTURES, 'user'), agentsDir(), { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'system'), systemDir, { recursive: true });

  const setup = spawnSync('bun', ['--eval', String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { AGENTS } from './src/lib/agents.ts';
    import { getVersionDir, getVersionHomePath, setGlobalDefault } from './src/lib/installations/versions.ts';
    const cfg = AGENTS.claude;
    const pkgRoot = path.join(getVersionDir('claude', '1.0.0'), 'node_modules', cfg.npmPackage);
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ bin: { [cfg.cliCommand]: 'cli.js' } }));
    fs.writeFileSync(path.join(pkgRoot, 'cli.js'), '#!/usr/bin/env node\n');
    setGlobalDefault('claude', '1.0.0');
    console.log(getVersionHomePath('claude', '1.0.0'));
  `], { cwd: CLI_ROOT, encoding: 'utf-8', env: { ...process.env, HOME: home, USERPROFILE: home } });
  if (setup.status !== 0) throw new Error(`fake install failed: ${setup.stderr}`);
  versionHome = setup.stdout.trim();

  const first = run(['sync', 'claude@1.0.0', '--yes']);
  if (first.status !== 0) throw new Error(`initial sync failed:\n${first.out}`);
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents sync --delete', () => {
  it('propagates a repo deletion only on request, and only for what came from that repo', () => {
    expect(fs.existsSync(commandFile('gonecmd'))).toBe(true);
    expect(fs.existsSync(pluginDir('agents-cli', 'gone'))).toBe(true);
    expect(fs.existsSync(pluginDir('agents-system', 'sysgone'))).toBe(true);
    expect(enabledPlugins()).toEqual(['gone@agents-cli', 'sysgone@agents-system']);

    fs.copyFileSync(path.join(FIXTURES, 'handmade', 'mine.md'), commandFile('mine'));
    fs.rmSync(path.join(agentsDir(), 'commands', 'gonecmd.md'));
    fs.rmSync(path.join(agentsDir(), 'plugins', 'gone'), { recursive: true });
    fs.rmSync(path.join(agentsDir(), '.system', 'plugins', 'sysgone'), { recursive: true });
    fs.cpSync(path.join(FIXTURES, 'later', 'skills'), path.join(agentsDir(), 'skills'), { recursive: true });

    const plain = run(['sync', '--local']);
    expect(plain.status, plain.out).toBe(0);
    expect(plain.out).toContain('Skipped resource selection');
    expect(fs.existsSync(commandFile('gonecmd'))).toBe(true);
    expect(fs.existsSync(pluginDir('agents-cli', 'gone'))).toBe(true);
    expect(enabledPlugins()).toEqual(['gone@agents-cli', 'sysgone@agents-system']);

    const bare = run(['sync', '--delete']);
    expect(bare.status).toBe(1);
    expect(bare.out).toContain('--delete needs a repo');

    const preview = run(['sync', 'claude@1.0.0', 'user', '--delete', '--dry-run']);
    expect(preview.status, preview.out).toBe(0);
    expect(preview.out).toContain('Would remove from Claude@1.0.0 (deleted from user): plugin gone, plugin gone--gone-skill, command gonecmd');
    expect(fs.existsSync(commandFile('gonecmd'))).toBe(true);
    expect(fs.existsSync(pluginDir('agents-cli', 'gone'))).toBe(true);

    const del = run(['sync', 'claude@1.0.0', 'user', '--delete', '--yes']);
    expect(del.status, del.out).toBe(0);
    expect(del.out).toContain('Removed from Claude@1.0.0 (deleted from user): plugin gone');
    expect(del.out).toMatch(/kept: \d+ not from user/);

    expect(fs.existsSync(commandFile('gonecmd'))).toBe(false);
    expect(fs.readdirSync(trash('commands', 'claude', '1.0.0', 'gonecmd'))).toHaveLength(1);
    expect(fs.existsSync(pluginDir('agents-cli', 'gone'))).toBe(false);
    expect(fs.readdirSync(trash('plugins', 'claude', '1.0.0', 'gone'))).toHaveLength(1);

    expect(enabledPlugins()).toEqual(['sysgone@agents-system']);
    expect(fs.existsSync(pluginDir('agents-system', 'sysgone'))).toBe(true);
    expect(fs.existsSync(commandFile('mine'))).toBe(true);
    expect(fs.existsSync(commandFile('keepcmd'))).toBe(true);
  });
});
