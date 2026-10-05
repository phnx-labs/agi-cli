
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entrypoint = path.join(repoRoot, 'src', 'index.ts');

let home: string;
let projectsDir: string;

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [tsxCli, entrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', AGENTS_SKIP_MIGRATION: '1', AGENTS_PROJECTS_DIR: projectsDir },
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

const def = (name: string) => fs.readFileSync(path.join(projectsDir, `${name}.yaml`), 'utf8');

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-set-home-'));
  projectsDir = path.join(home, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\nbeta:\n  enabled:\n    - projects\n');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents projects set', () => {
  it('changes one field and preserves every other', () => {
    fs.writeFileSync(
      path.join(projectsDir, 'agents-cli.yaml'),
      'name: agents-cli\nroot: ~/src/agents-cli\nrepo: me/agents-cli\ndescription: the CLI\nlinear:\n  projectId: lin_1\n',
    );
    const { stdout, status } = runCli(['projects', 'set', 'agents-cli', '--repo', 'phnx-labs/agents-cli']);
    expect(status).toBe(0);
    expect(stdout).toContain('Updated agents-cli');
    const y = def('agents-cli');
    expect(y).toContain('repo: phnx-labs/agents-cli');
    expect(y).toContain('projectId: lin_1');
    expect(y).toContain('description: the CLI');
    expect(y).toContain('root: ~/src/agents-cli');
  });

  it('refuses --path when the def has no root, instead of writing an absolute path', () => {
    fs.writeFileSync(path.join(projectsDir, 'rootless.yaml'), 'name: rootless\nlinear:\n  projectId: abc\n');
    const { stdout, status } = runCli(['projects', 'set', 'rootless', '--path', 'apps/cli']);
    expect(status).toBe(1);
    expect(stdout).toContain('has no root, so --path has nothing to resolve against');
    expect(def('rootless')).not.toContain('defaultPath');
  });

  it('accepts --path when a root comes along in the same call', () => {
    fs.writeFileSync(path.join(projectsDir, 'rootless.yaml'), 'name: rootless\nlinear:\n  projectId: abc\n');
    const { status } = runCli(['projects', 'set', 'rootless', '--root', '~/src/x', '--path', 'apps/cli']);
    expect(status).toBe(0);
    expect(def('rootless')).toContain('defaultPath: ~/src/x/apps/cli');
  });

  it('errors on an unknown project and on no fields, writing nothing', () => {
    expect(runCli(['projects', 'set', 'nope', '--repo', 'a/b']).stdout).toContain('No project named "nope"');
    fs.writeFileSync(path.join(projectsDir, 'p.yaml'), 'name: p\nrepo: a/b\n');
    const { stdout, status } = runCli(['projects', 'set', 'p']);
    expect(status).toBe(1);
    expect(stdout).toContain('Nothing to set');
    expect(def('p')).toBe('name: p\nrepo: a/b\n');
  });
});
