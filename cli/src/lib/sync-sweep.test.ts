import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(CLI_ROOT, 'src', 'index.ts');
const FIXTURES = path.join(CLI_ROOT, 'src', 'lib', 'testdata', 'sync-sweep');
const VERSION = '0.130.0';
const OLDER = '0.129.0';

let home = '';
let versionHome = '';
let olderHome = '';

function run(args: string[]): { out: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: home,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
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

const pluginDir = () => path.join(home, '.agents', '.system', 'plugins', 'swarm');
const skill = (name: string, home = versionHome) => path.join(home, '.codex', 'skills', name);
const trashed = (name: string) => path.join(home, '.agents', '.history', 'trash', 'skills', 'codex', VERSION, name);

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sweep-'));
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(systemDir, '.update-check'), JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }));
  fs.cpSync(path.join(FIXTURES, 'system'), systemDir, { recursive: true });

  const setup = spawnSync('bun', ['--eval', String.raw`
    import * as fs from 'fs';
    import * as path from 'path';
    import { AGENTS } from './src/lib/agents.ts';
    import { getVersionDir, getVersionHomePath, setGlobalDefault } from './src/lib/installations/versions.ts';
    const cfg = AGENTS.codex;
    for (const v of ['${OLDER}', '${VERSION}']) {
      const pkgRoot = path.join(getVersionDir('codex', v), 'node_modules', cfg.npmPackage);
      fs.mkdirSync(pkgRoot, { recursive: true });
      fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ bin: { [cfg.cliCommand]: 'cli.js' } }));
      fs.writeFileSync(path.join(pkgRoot, 'cli.js'), '#!/usr/bin/env node\n');
      console.log(getVersionHomePath('codex', v));
    }
    setGlobalDefault('codex', '${VERSION}');
  `], { cwd: CLI_ROOT, encoding: 'utf-8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60_000 });
  if (setup.status !== 0) throw new Error(`fake install failed: ${setup.stderr}`);
  [olderHome, versionHome] = setup.stdout.trim().split('\n');

  for (const v of [VERSION, OLDER]) {
    const first = run(['sync', `codex@${v}`, '--yes']);
    if (first.status !== 0) throw new Error(`initial sync of ${v} failed:\n${first.out}`);
  }
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents sync removes only what it installed (flattened plugin skills)', () => {
  it('removes skills a plugin dropped, and never a skill the user added by hand', () => {
    for (const name of ['keep', 'dropped-a', 'dropped-b', 'swarm-run', 'swarm-plan']) {
      expect(fs.existsSync(skill(name)), name).toBe(true);
    }
    fs.cpSync(path.join(FIXTURES, 'handmade', 'mine'), skill('mine'), { recursive: true });

    fs.rmSync(path.join(pluginDir(), 'skills', 'dropped-a'), { recursive: true });
    fs.rmSync(path.join(pluginDir(), 'commands', 'run.md'));
    const del = run(['sync', `codex@${VERSION}`, 'system', '--delete', '--yes']);
    expect(del.status, del.out).toBe(0);
    expect(del.out).toContain('skill dropped-a');
    expect(del.out).toContain('skill swarm-run');
    expect(fs.existsSync(skill('dropped-a'))).toBe(false);
    expect(fs.readdirSync(trashed('dropped-a'))).toHaveLength(1);
    expect(fs.existsSync(skill('swarm-run'))).toBe(false);
    expect(fs.existsSync(skill('keep'))).toBe(true);
    expect(fs.existsSync(skill('mine'))).toBe(true);

    fs.rmSync(path.join(pluginDir(), 'skills', 'dropped-b'), { recursive: true });
    fs.appendFileSync(path.join(pluginDir(), 'skills', 'keep', 'SKILL.md'), '\nEdited upstream.\n');
    const full = run(['sync', `codex@${VERSION}`, '--yes']);
    expect(full.status, full.out).toBe(0);
    expect(fs.existsSync(skill('dropped-b'))).toBe(false);
    expect(fs.readdirSync(trashed('dropped-b'))).toHaveLength(1);
    expect(fs.readFileSync(path.join(skill('keep'), 'SKILL.md'), 'utf-8')).toContain('Edited upstream.');
    expect(fs.existsSync(path.join(skill('mine'), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(skill('swarm-plan'))).toBe(true);
    expect(fs.existsSync(trashed('swarm-plan'))).toBe(false);
  });
});

describe('agents sync installs only real resources and leaves the source repos alone', () => {
  it('does not rewrite a plugin manifest in the source repo', () => {
    const manifest = path.join(pluginDir(), '.claude-plugin', 'plugin.json');
    const bare = JSON.stringify({ name: 'swarm', version: '1.0.0', description: 'fixture plugin', commands: ['plan'] }, null, 2);
    fs.writeFileSync(manifest, bare);
    const r = run(['sync', `codex@${VERSION}`, '--yes', '--force']);
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(manifest, 'utf-8')).toBe(bare);
  });

  it('reaches every synced version without --yes, not just the default', () => {
    fs.appendFileSync(path.join(pluginDir(), 'skills', 'keep', 'SKILL.md'), '\nSecond upstream edit.\n');
    const r = run(['sync', '--local']);
    expect(r.status, r.out).toBe(0);
    for (const home of [versionHome, olderHome]) {
      expect(fs.readFileSync(path.join(skill('keep', home), 'SKILL.md'), 'utf-8'), r.out).toContain('Second upstream edit.');
    }
  });
});

describe('agents use --yes on a never-synced version', () => {
  it('runs a full sync that records what it installed and skips folder docs, so a later --delete can work', () => {
    const fresh = '0.128.0';
    const setup = spawnSync('bun', ['--eval', String.raw`
      import * as fs from 'fs';
      import * as path from 'path';
      import { AGENTS } from './src/lib/agents.ts';
      import { getVersionDir } from './src/lib/installations/versions.ts';
      const cfg = AGENTS.codex;
      const pkgRoot = path.join(getVersionDir('codex', '${fresh}'), 'node_modules', cfg.npmPackage);
      fs.mkdirSync(pkgRoot, { recursive: true });
      fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ bin: { [cfg.cliCommand]: 'cli.js' } }));
      fs.writeFileSync(path.join(pkgRoot, 'cli.js'), '#!/usr/bin/env node\n');
    `], { cwd: CLI_ROOT, encoding: 'utf-8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60_000 });
    expect(setup.status, setup.stderr).toBe(0);
    const manifest = path.join(home, '.agents', '.history', 'versions', 'codex', fresh, 'home', '.sync-manifest.json');
    expect(fs.existsSync(manifest)).toBe(false);

    const r = run(['use', `codex@${fresh}`, '--yes']);
    expect(r.status, r.out).toBe(0);
    expect(fs.existsSync(manifest), r.out).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf-8')).writtenCommands).toContain('hello');
    const freshSkills = path.join(path.dirname(manifest), '.codex', 'skills');
    expect(fs.existsSync(path.join(freshSkills, 'hello', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(freshSkills, 'README')), 'a folder README.md is not a command').toBe(false);
    expect(fs.existsSync(path.join(freshSkills, 'AGENTS'))).toBe(false);
  });

  it('installs a newly added skill on the next use --yes without picking up folder docs as commands', () => {
    const fresh = '0.128.0';
    const added = path.join(home, '.agents', '.system', 'skills', 'newly-added');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'SKILL.md'), '---\nname: newly-added\ndescription: added upstream\n---\nNew.\n');
    const r = run(['use', `codex@${fresh}`, '--yes']);
    expect(r.status, r.out).toBe(0);
    const freshSkills = path.join(home, '.agents', '.history', 'versions', 'codex', fresh, 'home', '.codex', 'skills');
    expect(fs.existsSync(path.join(freshSkills, 'newly-added', 'SKILL.md')), r.out).toBe(true);
    expect(fs.existsSync(path.join(freshSkills, 'README')), r.out).toBe(false);
    expect(fs.existsSync(path.join(freshSkills, 'AGENTS'))).toBe(false);
  });
});
