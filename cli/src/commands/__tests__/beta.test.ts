import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';

const cliEntry = path.resolve('src/index.ts');
const tsxBin = path.resolve('node_modules/.bin/tsx');
const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8')) as { version: string };

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-beta-'));
  tempDirs.push(dir);
  return dir;
}

function writeUpdateCache(home: string): void {
  const cacheDir = path.join(home, '.agents', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: packageJson.version }),
    'utf-8'
  );
  fs.mkdirSync(path.join(home, '.agents', '.system', '.git'), { recursive: true });
}

function runAgents(args: string[], home: string) {
  return spawnSync(tsxBin, [cliEntry, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      AGENTS_SKIP_MIGRATION: '1',
      NODE_NO_WARNINGS: '1',
    },
    encoding: 'utf-8',
  });
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agents setup beta', () => {
  it('blocks beta-gated commands until enabled', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    const factory = runAgents(['factory', 'submit', 'EXAMPLE-1'], home);

    expect(factory.status).toBe(1);
    expect(outputOf(factory)).toContain('agents factory is in beta.');
    expect(outputOf(factory)).toContain('agents setup beta enable factory');
  });

  it('stores beta flags in ~/.agents/agents.yaml when no personal repo exists', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    const enable = runAgents(['setup', 'beta', 'enable', 'factory'], home);
    const list = runAgents(['setup', 'beta', 'list'], home);

    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('beta:');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- factory');
    expect(outputOf(list)).toContain(path.join(home, '.agents', 'agents.yaml'));
  });

  it('stores beta flags in ~/.agents/agents.yaml when a personal repo exists', () => {
    const home = makeTempHome();
    writeUpdateCache(home);
    fs.mkdirSync(path.join(home, '.agents'), { recursive: true });

    const enable = runAgents(['setup', 'beta', 'enable', 'factory'], home);
    const list = runAgents(['setup', 'beta', 'list'], home);
    const factory = runAgents(['factory', 'submit', 'EXAMPLE-1'], home);

    expect(enable.status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('beta:');
    expect(fs.readFileSync(path.join(home, '.agents', 'agents.yaml'), 'utf-8')).toContain('- factory');
    expect(outputOf(list)).toContain(path.join(home, '.agents', 'agents.yaml'));
    expect(factory.status).toBe(1);
    expect(outputOf(factory)).toContain('FACTORY_FLOOR_URL is not set.');
  });

  it('treats a graduated feature (projects) as a friendly no-op, not an error', () => {
    const home = makeTempHome();
    writeUpdateCache(home);

    const enable = runAgents(['setup', 'beta', 'enable', 'projects'], home);
    expect(enable.status).toBe(0);
    expect(outputOf(enable)).toContain('graduated out of beta');
    const yamlPath = path.join(home, '.agents', 'agents.yaml');
    if (fs.existsSync(yamlPath)) {
      expect(fs.readFileSync(yamlPath, 'utf-8')).not.toContain('- projects');
    }

    const typo = runAgents(['setup', 'beta', 'enable', 'factroy'], home);
    expect(typo.status).toBe(1);
    expect(outputOf(typo)).toContain('Unknown beta feature');
  });

  it('top-level `agents beta` is an unknown command', () => {
    const home = makeTempHome();
    writeUpdateCache(home);
    const r = runAgents(['beta'], home);
    expect(r.status).not.toBe(0);
    expect(outputOf(r)).toMatch(/unknown command/i);
  });
});
