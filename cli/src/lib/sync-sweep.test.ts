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

let home = '';
let versionHome = '';

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
const skill = (name: string) => path.join(versionHome, '.codex', 'skills', name);
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
    const pkgRoot = path.join(getVersionDir('codex', '${VERSION}'), 'node_modules', cfg.npmPackage);
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ bin: { [cfg.cliCommand]: 'cli.js' } }));
    fs.writeFileSync(path.join(pkgRoot, 'cli.js'), '#!/usr/bin/env node\n');
    setGlobalDefault('codex', '${VERSION}');
    console.log(getVersionHomePath('codex', '${VERSION}'));
  `], { cwd: CLI_ROOT, encoding: 'utf-8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60_000 });
  if (setup.status !== 0) throw new Error(`fake install failed: ${setup.stderr}`);
  versionHome = setup.stdout.trim();

  const first = run(['sync', `codex@${VERSION}`, '--yes']);
  if (first.status !== 0) throw new Error(`initial sync failed:\n${first.out}`);
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
