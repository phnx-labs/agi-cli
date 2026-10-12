import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runAgents(args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-removed-groups-'));
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, AGENTS_SKIP_MIGRATION: '1' },
    encoding: 'utf-8',
  });
}

describe('removed tool groups', () => {
  for (const group of ['browser', 'computer', 'secrets', 'sessions']) {
    it(`agents ${group} --help exits 1 with one line naming the standalone CLI`, () => {
      const result = runAgents([group, '--help']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toEqual([
        `error: 'agents ${group}' was removed; use the standalone '${group}' CLI (${group} --help).`,
      ]);
    });
  }

  it('points a moved sessions verb at its new home', () => {
    const result = runAgents(['sessions', 'resume', 'abc123']);
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "error: 'agents sessions resume' was removed; use 'agents run auto --resume <id>'.",
    );
  });
});
