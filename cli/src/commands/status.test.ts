/** RUSH-2864: top-level `agents status` moved under `agents sync status`. Pins both directions: the
 * nested path exists with the same flags and JSON contract, and the old name is gone (no silent
 * auto-correct). Tree via `buildFullCommandTree`; spawns use a disposable HOME. */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { registerSyncCommand } from './sync.js';
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
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-sync-status-'));
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

describe('the nested `agents sync status` surface', () => {
  it('registers status under sync, not at the root', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('status');
    expect(names).toContain('sync');

    const sync = program.commands.find((c) => c.name() === 'sync');
    expect(sync).toBeDefined();
    expect(sync!.commands.map((c) => c.name())).toContain('status');
  });

  it('keeps the same flags the former top-level command had', () => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommand(program);
    const status = program.commands.find((c) => c.name() === 'sync')!
      .commands.find((c) => c.name() === 'status');
    expect(status).toBeDefined();
    const longs = (status!.options ?? []).map((o) => o.long);
    expect(longs).toContain('--json');
    expect(longs).toContain('--yes');
    expect(longs).toContain('--cwd');
  });

  it('is not a known top-level command, and is RETIRED so it cannot auto-correct', () => {
    expect(isKnownTopLevelCommand('status')).toBe(false);
    expect(RETIRED_TOP_LEVEL_COMMANDS.has('status')).toBe(true);
  });

  it('`agents sync status --json` emits UnifiedSyncStatus, not umbrella sync JSON', () => {
    const home = guardedHome();
    const { stdout, stderr, status } = run(['sync', 'status', '--json'], home);
    expect(stderr).not.toMatch(/unknown command/i);
    expect(stderr).not.toMatch(/unknown agent/i);
    expect(stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout.trim()) as {
      system: unknown;
      agents: unknown;
      totals: { drifted: number; missing: number; orphan: number };
      mode?: string;
    };
    // The umbrella sync JSON is `{ ok, mode: 'umbrella', ... }`. If commander
    // fed "status" to the parent action, this would not be UnifiedSyncStatus.
    expect(parsed.mode).toBeUndefined();
    expect(parsed.system).toBeDefined();
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.totals).toEqual(expect.objectContaining({
      drifted: expect.any(Number),
      missing: expect.any(Number),
      orphan: expect.any(Number),
    }));
    expect(status === 0 || status === 1).toBe(true);
  });
});

describe('the retired top-level `agents status`', () => {
  it('is no longer registered on the real command tree', async () => {
    const program = await buildFullCommandTree();
    const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
    expect(names).not.toContain('status');
    expect(isKnownTopLevelCommand('status')).toBe(false);
  });

  it('a bare `agents status` is an unknown command, not an auto-correct', () => {
    const home = guardedHome();
    const { stderr, status } = run(['status'], home);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/unknown command/i);
  });

  it('top-level help does not list a status command', () => {
    const home = guardedHome();
    const { stdout, status } = run(['--help'], home);
    expect(status).toBe(0);
    // `status` retired to `sync status`; the compact root help never lists it
    // as a top-level command.
    expect(stdout).not.toMatch(/^\s+status\s+Sync\/drift/m);
  });
});
