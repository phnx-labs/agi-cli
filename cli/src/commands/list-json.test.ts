import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';


const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(REPO_ROOT, 'src', 'index.ts');
const ANSI_ESCAPE = String.fromCharCode(27);

let testHome: string;

afterEach(() => {
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

function guardedHome(): void {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-listjson-home-'));
  const systemDir = path.join(testHome, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: 4102444800000, latestVersion: '0.0.0' }),
  );
}

function run(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('bun', [INDEX, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: testHome, AGENTS_NO_UPDATE_CHECK: '1' },
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('list commands emit valid JSON with --json (not the human table)', () => {
  it('repos list --json prints a JSON array with no ANSI color leaking in', () => {
    guardedHome();
    const { stdout } = run(['repos', 'list', '--json']);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(stdout).not.toContain(ANSI_ESCAPE);
  });

  it('plugins list --json prints a JSON array — the flag reaches the subcommand action', () => {
    guardedHome();
    const { stdout } = run(['plugins', 'list', '--json']);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(stdout.trimStart().startsWith('[')).toBe(true);
  });

  for (const cmd of ['skills', 'commands', 'mcp', 'subagents']) {
    it(`${cmd} list --json prints a clean JSON array (flag reaches the subcommand)`, () => {
      guardedHome();
      const { stdout, status } = run([cmd, 'list', '--json']);
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(stdout.trimStart().startsWith('[')).toBe(true);
      expect(stdout).not.toContain(ANSI_ESCAPE);
    });
  }
});
