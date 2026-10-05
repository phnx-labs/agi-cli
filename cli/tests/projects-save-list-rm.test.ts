
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

function runCli(
  args: string[],
  opts: { stdin?: string } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [tsxCli, entrypoint, ...args], {
      cwd: repoRoot,
      encoding: 'utf-8',
      input: opts.stdin,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        AGENTS_SKIP_MIGRATION: '1',
        AGENTS_PROJECTS_DIR: projectsDir,
      },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-save-home-'));
  projectsDir = path.join(home, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'agents.yaml'), 'agents: {}\n');
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('agents projects list --json', () => {
  it('returns definitions only with no agents field by default', () => {
    fs.writeFileSync(
      path.join(projectsDir, 'rush.yaml'),
      'name: rush\nroot: ~/src/rush\nrepo: phnx-labs/rush\n',
      'utf8',
    );
    const { stdout, status } = runCli(['projects', 'list', '--json']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('rush');
    expect(parsed[0].root).toBe('~/src/rush');
    expect(parsed[0].repo).toBe('phnx-labs/rush');
    expect(parsed[0]).not.toHaveProperty('agents');
  });

  it('adds local agents counts only when --with-agents is passed', () => {
    fs.writeFileSync(path.join(projectsDir, 'solo.yaml'), 'name: solo\nroot: ~/src/solo\n', 'utf8');
    const { stdout, status } = runCli(['projects', 'list', '--json', '--with-agents']);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('solo');
    expect(typeof parsed[0].agents).toBe('number');
  });
});

describe('agents projects save --json', () => {
  it('creates a project from a complete ProjectDef JSON object and returns the saved def', () => {
    const input = JSON.stringify({
      name: 'agents-cli',
      root: path.join(home, 'src', 'agents-cli'),
      repo: 'phnx-labs/agents-cli',
      dispatch: { enabled: true, maxAgents: 2 },
      linear: { projectId: 'lin_1', name: 'Agents CLI' },
    });
    const { stdout, status } = runCli(['projects', 'save', '--json'], { stdin: input });
    expect(status).toBe(0);
    const saved = JSON.parse(stdout) as Record<string, unknown>;
    expect(saved.name).toBe('agents-cli');
    expect(saved.root).toBe('~/src/agents-cli');
    expect(saved.repo).toBe('phnx-labs/agents-cli');
    expect(saved.dispatch).toEqual({ enabled: true, maxAgents: 2 });
    expect(saved.linear).toEqual({ projectId: 'lin_1', name: 'Agents CLI' });

    const onDisk = fs.readFileSync(path.join(projectsDir, 'agents-cli.yaml'), 'utf8');
    expect(onDisk).toContain('name: agents-cli');
    expect(onDisk).toContain('root: ~/src/agents-cli');
    expect(onDisk).toContain('enabled: true');
  });

  it('updates an existing def and rejects invalid JSON / schema loudly', () => {
    fs.writeFileSync(path.join(projectsDir, 'rush.yaml'), 'name: rush\nroot: ~/old\n', 'utf8');
    const ok = runCli(['projects', 'save', '--json'], {
      stdin: JSON.stringify({ name: 'rush', root: '~/src/rush', description: 'updated' }),
    });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).description).toBe('updated');
    expect(fs.readFileSync(path.join(projectsDir, 'rush.yaml'), 'utf8')).toContain('description: updated');

    const badJson = runCli(['projects', 'save', '--json'], { stdin: '{not-json' });
    expect(badJson.status).toBe(1);
    expect(`${badJson.stdout}${badJson.stderr}`).toMatch(/invalid JSON/i);

    const badSchema = runCli(['projects', 'save', '--json'], {
      stdin: JSON.stringify({ name: '../evil', root: '~/x' }),
    });
    expect(badSchema.status).toBe(1);
    expect(`${badSchema.stdout}${badSchema.stderr}`).toMatch(/valid slug|valid "name"/i);
  });

  it('requires --json', () => {
    const { status, stdout, stderr } = runCli(['projects', 'save']);
    expect(status).toBe(1);
    expect(`${stdout}${stderr}`).toContain('--json');
  });
});

describe('agents projects rm --json', () => {
  it('returns machine-readable success and removes the file', () => {
    fs.writeFileSync(path.join(projectsDir, 'gone.yaml'), 'name: gone\n', 'utf8');
    const { stdout, status } = runCli(['projects', 'rm', 'gone', '--json']);
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, name: 'gone', removed: true });
    expect(fs.existsSync(path.join(projectsDir, 'gone.yaml'))).toBe(false);
  });

  it('returns machine-readable error when missing, keeps human path green on success', () => {
    const missing = runCli(['projects', 'rm', 'nope', '--json']);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({
      ok: false,
      name: 'nope',
      error: 'No project named "nope"',
    });

    fs.writeFileSync(path.join(projectsDir, 'human.yaml'), 'name: human\n', 'utf8');
    const human = runCli(['projects', 'rm', 'human']);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('Removed project "human"');
  });
});
