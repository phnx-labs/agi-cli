
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
let binDir: string;
let srcRoot: string;

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [tsxCli, entrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${binDir}:${process.env.PATH}`,
        NO_COLOR: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_PROJECTS_DIR: projectsDir,
      },
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${err.stdout ?? ''}${err.stderr ?? ''}`, status: err.status ?? 1 };
  }
}

const defined = () =>
  fs
    .readdirSync(projectsDir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();

function makeCheckout(name: string, slug: string): void {
  const dir = path.join(srcRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', `git@github.com:${slug}.git`], { cwd: dir });
}

function stubLinearCli(projects: unknown[]): void {
  const script = `#!/bin/sh\n[ "$1" = "projects" ] || exit 1\ncat <<'JSON'\n${JSON.stringify(projects, null, 2)}\nJSON\n`;
  const p = path.join(binDir, 'linear');
  fs.writeFileSync(p, script);
  fs.chmodSync(p, 0o755);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-import-home-'));
  projectsDir = path.join(home, 'projects');
  binDir = path.join(home, 'bin');
  srcRoot = path.join(home, 'src');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(srcRoot, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agents', 'agents.yaml'),
    `agents: {}\nprojectRoot: ${srcRoot}\nbeta:\n  enabled:\n    - projects\n`,
  );
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents projects import source flags', () => {
  it('requires --from-linear and rejects the removed --from-factory flag', () => {
    expect(runCli(['projects', 'import']).stdout).toContain('Pick an import source');
    const unknown = runCli(['projects', 'import', '--from-factory']);
    expect(unknown.status).not.toBe(0);
    expect(defined()).toEqual([]);
  });
});

describe('agents projects import --from-linear', () => {
  const def = (name: string) => fs.readFileSync(path.join(projectsDir, `${name}.yaml`), 'utf8');

  it.skipIf(process.platform === 'win32')('binds an exact local checkout and leaves the rest to name + link', () => {
    makeCheckout('agents-cli', 'muqsitnawaz/agents-cli');
    makeCheckout('web', 'someone/web');
    stubLinearCli([
      { id: 'lin_1', name: 'Agents CLI', url: 'https://linear.app/w/project/agents-cli' },
      { id: 'lin_2', name: 'Marketing Site' },
      { id: 'lin_3', name: 'Rush / Web' },
    ]);
    const { stdout, status } = runCli(['projects', 'import', '--from-linear']);
    expect(status).toBe(0);
    expect(stdout).toContain('Imported 3 projects');
    expect(defined()).toEqual(['agents-cli', 'marketing-site', 'rush-web']);

    expect(def('agents-cli')).toContain('root: ~/src/agents-cli');
    expect(def('agents-cli')).toContain('repo: muqsitnawaz/agents-cli');
    expect(def('agents-cli')).toContain('projectId: lin_1');
    expect(def('agents-cli')).toContain('url: https://linear.app/w/project/agents-cli');

    for (const unbound of ['marketing-site', 'rush-web']) {
      expect(def(unbound)).not.toContain('root:');
      expect(def(unbound)).not.toContain('repo:');
    }
    expect(def('rush-web')).toContain('projectId: lin_3');
  });

  it.skipIf(process.platform === 'win32')('preserves hand-set fields and refuses to relink a bound def without --force', () => {
    makeCheckout('agents-cli', 'muqsitnawaz/agents-cli');
    stubLinearCli([{ id: 'lin_1', name: 'Agents CLI' }]);
    runCli(['projects', 'import', '--from-linear']);
    fs.appendFileSync(path.join(projectsDir, 'agents-cli.yaml'), 'description: the CLI\n');

    const { stdout } = runCli(['projects', 'import', '--from-linear']);
    expect(stdout).toContain('skip agents-cli: existing def already has root/repo — pass --force to relink');
    expect(def('agents-cli')).toContain('description: the CLI');

    stubLinearCli([{ id: 'lin_9', name: 'Agents CLI' }]);
    runCli(['projects', 'import', '--from-linear', '--force']);
    expect(def('agents-cli')).toContain('projectId: lin_9');
    expect(def('agents-cli')).toContain('description: the CLI');
  });

  it('fails loudly when the linear CLI is missing, writing nothing', () => {
    const { stdout, status } = runCli(['projects', 'import', '--from-linear']);
    expect(status).toBe(1);
    expect(stdout).toContain('is the `linear` CLI installed and logged in?');
    expect(defined()).toEqual([]);
  });
});
