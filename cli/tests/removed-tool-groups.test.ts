import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FIXTURE_HOME = path.join(REPO_ROOT, 'src', 'lib', 'startup', 'testdata', 'shadowing-home');
const SYSTEM_PATH = '/usr/bin:/bin';

function makeHome(fixture?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-removed-groups-'));
  if (fixture) fs.cpSync(fixture, home, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  return home;
}

function runAgents(args: string[], home = makeHome(), pathEnv = SYSTEM_PATH) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: pathEnv, AGENTS_SKIP_MIGRATION: '1' },
    encoding: 'utf-8',
  });
}

describe('removed tool groups', () => {
  for (const group of ['browser', 'computer', 'secrets', 'sessions']) {
    it(`agents ${group} --help exits 1 naming the standalone CLI and a shadowing alias`, () => {
      const result = runAgents([group, '--help']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim().split('\n')).toEqual([
        `error: 'agents ${group}' was removed; use the standalone '${group}' CLI (none is on PATH).`,
        `If you typed '${group}', a shell alias or function sends it here; 'type ${group}' shows it.`,
        `If so, remove it from your shell rc file, then run 'unalias ${group}' (or 'unset -f ${group}' for a function).`,
      ]);
    });
  }

  it('names the rc line that aliases browser and the standalone binary by absolute path', () => {
    const home = makeHome(FIXTURE_HOME);
    const bin = path.join(home, 'bin');
    const result = runAgents(['browser', 'show', 'x.html'], home, `${bin}:${SYSTEM_PATH}`);
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split('\n')).toEqual([
      `error: 'agents browser' was removed; use the standalone 'browser' CLI (${path.join(bin, 'browser')} doctor).`,
      "If you typed 'browser', a shell alias or function sends it here; 'type browser' shows it.",
      "~/.zshrc:7 defines it: delete that line, then run 'unalias browser'.",
    ]);
  });

  it('points a moved sessions verb at its new home, past a flag value', () => {
    for (const args of [['sessions', 'resume', 'abc123'], ['sessions', '--device', 'box', 'resume', 'abc123']]) {
      const result = runAgents(args);
      expect(result.status).toBe(1);
      expect(result.stderr.trim()).toBe(
        "error: 'agents sessions resume' was removed; use 'agents run auto --resume <id>'.",
      );
    }
  });
});
