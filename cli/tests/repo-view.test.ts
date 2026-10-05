import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string };

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-repo-view-'));
  tempHomes.push(home);

  const userDir = path.join(home, '.agents');
  const systemDir = path.join(userDir, '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION.version }),
  );

  fs.writeFileSync(path.join(systemDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(systemDir, 'skills', 'demo-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, 'skills', 'demo-skill', 'SKILL.md'),
    '---\ndescription: A demo skill\n---\n\n# demo-skill\n',
  );

  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(userDir, 'skills', 'user-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(userDir, 'skills', 'user-skill', 'SKILL.md'),
    '---\ndescription: A user skill\n---\n\n# user-skill\n',
  );

  return home;
}

function runAgents(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', ...extraEnv },
    encoding: 'utf-8',
  });
}

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;]*m/g, '');
}

afterEach(() => {
  while (tempHomes.length > 0) {
    const home = tempHomes.pop()!;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('agents repo view', () => {
  it('renders a named repo summary with its resource section', () => {
    const home = makeTempHome();
    const result = runAgents(home, ['repo', 'view', 'system']);
    expect(result.status).toBe(0);
    const out = strip(result.stdout);
    expect(out).toContain('system');
    expect(out).toContain('[dotagents repo]');
    expect(out).toContain('Resources');
    expect(out).toContain('demo-skill');
  });

  it('exposes the same output under the `repos` alias', () => {
    const home = makeTempHome();
    const viaRepo = strip(runAgents(home, ['repo', 'view', 'system']).stdout);
    const viaRepos = strip(runAgents(home, ['repos', 'view', 'system']).stdout);
    expect(viaRepos).toBe(viaRepo);
  });

  it('errors on an unknown repo name', () => {
    const home = makeTempHome();
    const result = runAgents(home, ['repo', 'view', 'nope']);
    expect(result.status).not.toBe(0);
    expect(strip(result.stdout) + strip(result.stderr)).toContain('Unknown repo "nope"');
  });

  it('errors with a hint when no name is given in a non-interactive terminal', () => {
    const home = makeTempHome();
    const result = runAgents(home, ['repo', 'view']);
    expect(result.status).not.toBe(0);
    expect(strip(result.stdout)).toContain('not an interactive terminal');
  });
});
