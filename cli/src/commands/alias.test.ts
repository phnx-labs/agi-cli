/**
 * RUSH-2965 — top-level `agents alias` moved under `agents setup alias`.
 * Pins both directions: the nested path still writes shims, and the old
 * top-level name is gone (not a silent auto-correct).
 *
 * Tree assertions use `buildFullCommandTree` (no mocks). The CLI spawn
 * tests drive `src/index.ts` against a disposable HOME.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { registerSetupCommand } from './setup.js';
import { buildFullCommandTree } from '../cli/command-registry.js';
import {
  isKnownTopLevelCommand,
  RETIRED_TOP_LEVEL_COMMANDS,
} from '../lib/startup/command-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string | undefined;

afterEach(() => {
  if (testHome) {
    fs.rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function guardedHome(): string {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-setup-alias-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  return testHome;
}

function run(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOME: home,
      AGENTS_NO_UPDATE_CHECK: '1',
      AGENTS_SECRETS_PASSPHRASE: '',
    },
  });
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  };
}

describe('the nested `agents setup alias` surface', () => {
  it('registers alias under setup, not at the root', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('alias');
    expect(names).toContain('setup');

    const setup = program.commands.find((c) => c.name() === 'setup');
    expect(setup).toBeDefined();
    expect(setup!.commands.map((c) => c.name())).toContain('alias');
    const alias = setup!.commands.find((c) => c.name() === 'alias')!;
    expect(alias.commands.map((c) => c.name()).sort()).toEqual(['add', 'list', 'remove']);
  });

  it('keeps add / list / remove on the nested command', () => {
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);
    const alias = program.commands.find((c) => c.name() === 'setup')!
      .commands.find((c) => c.name() === 'alias');
    expect(alias).toBeDefined();
    expect(alias!.commands.map((c) => c.name()).sort()).toEqual(['add', 'list', 'remove']);
  });

  it('is not a known top-level command, and is RETIRED so it cannot auto-correct', () => {
    expect(isKnownTopLevelCommand('alias')).toBe(false);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('alias')).toBe(true);
  });

  it('`agents setup alias add` writes a shim and `list` shows it', () => {
    const home = guardedHome();
    const added = run(['setup', 'alias', 'add', 'teams'], home);
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/Created.*teams.*agents teams/s);

    const shim = path.join(home, '.agents', '.cache', 'shims', 'teams');
    expect(fs.existsSync(shim)).toBe(true);
    const body = fs.readFileSync(shim, 'utf-8');
    expect(body).toContain('# Alias shim: teams -> agents teams');
    expect(body).toContain('exec agents teams "$@"');

    const listed = run(['setup', 'alias', 'list'], home);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toMatch(/teams/);
    expect(listed.stdout).toMatch(/agents teams/);
  });

  it('`agents setup alias remove` deletes the shim', () => {
    const home = guardedHome();
    expect(run(['setup', 'alias', 'add', 'teams'], home).status).toBe(0);
    const removed = run(['setup', 'alias', 'remove', 'teams'], home);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toMatch(/Removed.*teams/);
    expect(fs.existsSync(path.join(home, '.agents', '.cache', 'shims', 'teams'))).toBe(false);

    const listed = run(['setup', 'alias', 'list'], home);
    expect(listed.stdout).toMatch(/No aliases/);
  });

  it('refuses a name that collides with an agent CLI', () => {
    const home = guardedHome();
    const r = run(['setup', 'alias', 'add', 'claude'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reserved/);
  });

  it('refuses `secrets`, the standalone CLI name the shims dir would shadow (PHNX-3989)', () => {
    const home = guardedHome();
    const r = run(['setup', 'alias', 'add', 'secrets'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/reserved/);
    expect(fs.existsSync(path.join(home, '.agents', '.cache', 'shims', 'secrets'))).toBe(false);
  });
});

describe('the retired top-level `agents alias`', () => {
  it('is no longer registered on the real command tree', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('alias');
  });

  it('a bare `agents alias` is an unknown command, not an auto-correct', () => {
    const home = guardedHome();
    const r = run(['alias'], home);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown command/i);
  });
});
