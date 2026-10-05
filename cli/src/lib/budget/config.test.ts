import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-config-home-'));
process.env.HOME = fakeHome;
fs.mkdirSync(path.join(fakeHome, '.agents'), { recursive: true });

const { resolveBudgetConfig, hasAnyCap } = await import('./config.js');
const { getUserAgentsDir } = await import('../state.js');
const userAgentsDir = getUserAgentsDir();
fs.mkdirSync(userAgentsDir, { recursive: true });
const userYaml = path.join(userAgentsDir, 'agents.yaml');

let mtimeTick = 0;
function writeUserYaml(body: string): void {
  fs.writeFileSync(userYaml, body);
  const future = Date.now() / 1000 + ++mtimeTick;
  fs.utimesSync(userYaml, future, future);
}

afterAll(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

let projectDir: string;

beforeEach(() => {
  writeUserYaml('');
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-config-proj-'));
});

describe('resolveBudgetConfig', () => {
  it('reads the user-global budget when no project block exists', () => {
    writeUserYaml('budget:\n  per_run: 5\n  per_day: 50\n  on_exceed: block\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(5);
    expect(cfg.per_day).toBe(50);
    expect(cfg.on_exceed).toBe('block');
  });

  it('project block OVERRIDES user on set fields, INHERITS unset ones', () => {
    writeUserYaml('budget:\n  per_run: 5\n  per_day: 50\n  per_project: 100\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: 1\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(1);
    expect(cfg.per_day).toBe(50);
    expect(cfg.per_project).toBe(100);
  });

  it('nearest project agents.yaml wins over an ancestor project agents.yaml', () => {
    const child = path.join(projectDir, 'sub');
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: 10\n');
    fs.writeFileSync(path.join(child, 'agents.yaml'), 'budget:\n  per_run: 2\n');
    const cfg = resolveBudgetConfig(child);
    expect(cfg.per_run).toBe(2);
  });

  it('merges per_agent maps key-by-key (project adds a key without wiping user keys)', () => {
    writeUserYaml('budget:\n  per_agent:\n    claude: 30\n    codex: 20\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_agent:\n    codex: 5\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_agent).toEqual({ claude: 30, codex: 5 });
  });

  it('defaults on_exceed to block (fail-closed) when nothing sets it', () => {
    writeUserYaml('budget:\n  per_run: 5\n');
    expect(resolveBudgetConfig(projectDir).on_exceed).toBe('block');
  });

  it('ignores a malformed project agents.yaml and keeps the user budget', () => {
    writeUserYaml('budget:\n  per_run: 5\n');
    fs.writeFileSync(path.join(projectDir, 'agents.yaml'), 'budget:\n  per_run: [this: is: broken\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBe(5);
  });

  it('drops a cap whose value is the wrong type (string instead of number)', () => {
    writeUserYaml('budget:\n  per_run: "lots"\n  per_day: 50\n');
    const cfg = resolveBudgetConfig(projectDir);
    expect(cfg.per_run).toBeUndefined();
    expect(cfg.per_day).toBe(50);
  });
});

describe('hasAnyCap', () => {
  it('is false for an empty config (feature dormant)', () => {
    expect(hasAnyCap({ on_exceed: 'block' })).toBe(false);
  });
  it('is true when any cap is set', () => {
    expect(hasAnyCap({ per_run: 5 })).toBe(true);
    expect(hasAnyCap({ per_agent: { claude: 1 } })).toBe(true);
  });
});
