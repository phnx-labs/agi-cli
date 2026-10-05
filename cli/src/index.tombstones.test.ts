import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Tombstone notices stay on stderr; replacements preserve flags/exits, and removed hq tolerates stale args.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');

let testHome: string;
let projectDir: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
  if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
});

function seedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tombstone-home-'));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tombstone-proj-'));

  const userDir = path.join(testHome, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');

  const binDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(binDir, 'claude'), 0o755);

  const commandsDir = path.join(userDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(path.join(commandsDir, 'demo.md'), '---\ndescription: demo\n---\n\n# demo\n');
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bun', [INDEX, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: testHome,
      AGENTS_NO_AUTOPULL: '1',
      AGENTS_DEVICES_DIR: path.join(testHome, '.agents', '.history', 'devices'),
    },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('removed-command tombstones (RUSH-1234)', () => {
  it('`agents check` forwards to `doctor --check`: notice on stderr, JSON on stdout, exit code preserved', () => {
    seedHome();

    const r = run('check', '--json', '--cwd', projectDir);

    expect(r.stderr).toContain('Deprecated');
    expect(r.stderr).toContain('doctor --check');
    expect(r.stdout).not.toContain('Deprecated');

    const parsed = JSON.parse(r.stdout);
    expect(parsed).toHaveProperty('hasDrift');
    expect(parsed.hasDrift).toBe(true);
    expect(r.status).not.toBe(0);
  });

  it('`agents resources` forwards to `view --merged`: notice on stderr, merged table on stdout', () => {
    seedHome();

    const r = run('resources');

    expect(r.stderr).toContain('Deprecated');
    expect(r.stderr).toContain('view --merged');
    expect(r.stderr).toContain('inspect');
    expect(r.stdout).not.toContain('Deprecated');
    expect(r.stdout.toLowerCase()).toContain('merged');
    expect(r.status).toBe(0);
  });

  it('neither removed name appears as "unknown command"', () => {
    seedHome();
    for (const name of ['check', 'resources']) {
      const r = run(name, '--help');
      expect(r.stderr).not.toContain(`unknown command '${name}'`);
    }
  });
});

describe('removed `hq` command (no replacement)', () => {
  it('`agents hq` prints a removal notice on stderr and exits non-zero', () => {
    seedHome();

    const r = run('hq');

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('agents hq');
    expect(r.stderr).toContain('removed');
    expect(r.stdout).not.toContain('removed');
  });

  it('a stale `agents hq floor --json` invocation also hits the tombstone', () => {
    seedHome();

    const r = run('hq', 'floor', '--json');

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('removed');
  });

  it('`agents hq` does not appear as "unknown command"', () => {
    seedHome();
    const r = run('hq', '--help');
    expect(r.stderr).not.toContain("unknown command 'hq'");
  });
});
