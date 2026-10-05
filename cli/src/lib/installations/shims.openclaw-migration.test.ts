import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TEST_VERSIONS_DIR = '';
let TEST_BACKUPS_DIR = '';

vi.mock('../state.js', async () => {
  const actual = await vi.importActual<typeof import('../state.js')>('../state.js');
  return {
    ...actual,
    getVersionsDir: () => TEST_VERSIONS_DIR,
    getBackupsDir: () => TEST_BACKUPS_DIR,
    ensureAgentsDir: () => {},
  };
});

import { switchConfigSymlink } from './shims.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-migrate-test-'));
  tempDirs.push(root);
  TEST_VERSIONS_DIR = path.join(root, '.agents', 'versions');
  TEST_BACKUPS_DIR = path.join(root, '.agents', 'backups');
  fs.mkdirSync(TEST_VERSIONS_DIR, { recursive: true });
  process.env.AGENTS_REAL_HOME = root;
  return root;
}

function seedOpenclawData(versionHome: string): void {
  const dir = path.join(versionHome, '.openclaw');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'openclaw.json'), '{"daemon":{"port":7777}}');
  fs.writeFileSync(path.join(dir, 'openclaw.db'), 'SQLITE');
  fs.mkdirSync(path.join(dir, 'jeff'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'jeff', 'AGENTS.md'), '# Jeff\nChief of Staff');
  fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', '2026-05-30.md'), 'tasked with X');
}

afterEach(() => {
  delete process.env.AGENTS_REAL_HOME;
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('switchConfigSymlink — openclaw cross-version data migration (#23)', () => {
  let home: string;
  let v1Home: string;
  let v2Home: string;
  let configLink: string;

  beforeEach(() => {
    home = makeTempHome();
    v1Home = path.join(TEST_VERSIONS_DIR, 'openclaw', '1.0.0', 'home');
    v2Home = path.join(TEST_VERSIONS_DIR, 'openclaw', '1.0.1', 'home');
    fs.mkdirSync(v1Home, { recursive: true });
    fs.mkdirSync(v2Home, { recursive: true });
    configLink = path.join(home, '.openclaw');
  });

  it('carries openclaw.json, db, agent workspaces, and memory across a version switch', async () => {
    seedOpenclawData(v1Home);
    fs.symlinkSync(path.join(v1Home, '.openclaw'), configLink);

    const result = await switchConfigSymlink('openclaw', '1.0.1');
    expect(result.success).toBe(true);

    const newTarget = fs.readlinkSync(configLink);
    expect(path.resolve(path.dirname(configLink), newTarget)).toBe(path.join(v2Home, '.openclaw'));

    const v2Dir = path.join(v2Home, '.openclaw');
    expect(fs.readFileSync(path.join(v2Dir, 'openclaw.json'), 'utf8')).toBe('{"daemon":{"port":7777}}');
    expect(fs.readFileSync(path.join(v2Dir, 'openclaw.db'), 'utf8')).toBe('SQLITE');
    expect(fs.readFileSync(path.join(v2Dir, 'jeff', 'AGENTS.md'), 'utf8')).toContain('Chief of Staff');
    expect(fs.readFileSync(path.join(v2Dir, 'memory', '2026-05-30.md'), 'utf8')).toBe('tasked with X');

    expect(fs.existsSync(path.join(v1Home, '.openclaw', 'openclaw.json'))).toBe(true);
  });

  it('does NOT clobber files the new version already shipped (keep-dest)', async () => {
    seedOpenclawData(v1Home);
    fs.mkdirSync(path.join(v2Home, '.openclaw'), { recursive: true });
    fs.writeFileSync(path.join(v2Home, '.openclaw', 'openclaw.json'), '{"v2-default":true}');

    fs.symlinkSync(path.join(v1Home, '.openclaw'), configLink);
    const result = await switchConfigSymlink('openclaw', '1.0.1');
    expect(result.success).toBe(true);

    expect(fs.readFileSync(path.join(v2Home, '.openclaw', 'openclaw.json'), 'utf8')).toBe('{"v2-default":true}');
    expect(fs.readFileSync(path.join(v2Home, '.openclaw', 'openclaw.db'), 'utf8')).toBe('SQLITE');
    expect(fs.readFileSync(path.join(v2Home, '.openclaw', 'jeff', 'AGENTS.md'), 'utf8')).toContain('Chief of Staff');
  });

  it('does NOT migrate cross-version data for non-openclaw agents (Claude, etc.)', async () => {
    const claudeV1 = path.join(TEST_VERSIONS_DIR, 'claude', '2.0.0', 'home');
    const claudeV2 = path.join(TEST_VERSIONS_DIR, 'claude', '2.1.0', 'home');
    fs.mkdirSync(claudeV1, { recursive: true });
    fs.mkdirSync(claudeV2, { recursive: true });
    fs.mkdirSync(path.join(claudeV1, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(claudeV1, '.claude', 'should-not-migrate.txt'), 'v1 data');

    const claudeLink = path.join(home, '.claude');
    fs.symlinkSync(path.join(claudeV1, '.claude'), claudeLink);

    const result = await switchConfigSymlink('claude', '2.1.0');
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(claudeV2, '.claude', 'should-not-migrate.txt'))).toBe(false);
  });
});
