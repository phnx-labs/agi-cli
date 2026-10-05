import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as state from '../state.js';
import { listResources, resolveResource } from '../resources.js';

let tmpDir = '';
let projectAgentsDir = '';
let userAgentsDir = '';
let systemAgentsDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-resource-test-'));
  projectAgentsDir = path.join(tmpDir, 'project', '.agents');
  userAgentsDir = path.join(tmpDir, 'user', '.agents');
  systemAgentsDir = path.join(tmpDir, 'system', '.agents');

  for (const dir of [projectAgentsDir, userAgentsDir, systemAgentsDir]) {
    fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  }

  vi.spyOn(state, 'getProjectAgentsDir').mockReturnValue(projectAgentsDir);
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(userAgentsDir);
  vi.spyOn(state, 'getSystemAgentsDir').mockReturnValue(systemAgentsDir);
  vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveResource', () => {
  it('returns the project resource when the same name exists in every scope', () => {
    fs.writeFileSync(path.join(systemAgentsDir, 'commands', 'shared.md'), 'system');
    fs.writeFileSync(path.join(userAgentsDir, 'commands', 'shared.md'), 'user');
    fs.writeFileSync(path.join(projectAgentsDir, 'commands', 'shared.md'), 'project');

    const resolved = resolveResource('commands', 'shared', tmpDir);

    expect(resolved).toEqual({
      name: 'shared',
      path: path.join(projectAgentsDir, 'commands', 'shared.md'),
      source: 'project',
      repoRoot: projectAgentsDir,
    });
  });

  it('falls back from user to system and returns null when missing', () => {
    fs.writeFileSync(path.join(systemAgentsDir, 'commands', 'system-only.md'), 'system');
    fs.writeFileSync(path.join(userAgentsDir, 'commands', 'user-only.md'), 'user');

    expect(resolveResource('commands', 'user-only', tmpDir)).toEqual({
      name: 'user-only',
      path: path.join(userAgentsDir, 'commands', 'user-only.md'),
      source: 'user',
      repoRoot: userAgentsDir,
    });

    expect(resolveResource('commands', 'system-only', tmpDir)).toEqual({
      name: 'system-only',
      path: path.join(systemAgentsDir, 'commands', 'system-only.md'),
      source: 'system',
      repoRoot: systemAgentsDir,
    });

    expect(resolveResource('commands', 'missing', tmpDir)).toBeNull();
  });
});

describe('resolveResource with extra repos', () => {
  it('labels extra repo resources with the alias, not "system"', () => {
    const rushDir = path.join(tmpDir, 'rush', '.agents');
    fs.mkdirSync(path.join(rushDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(rushDir, 'commands', 'rush-cmd.md'), 'rush');

    vi.spyOn(state, 'getEnabledExtraRepos').mockReturnValue([
      { alias: 'rush', dir: rushDir, url: 'https://example.com/rush' },
    ]);

    const resolved = resolveResource('commands', 'rush-cmd', tmpDir);

    expect(resolved).toEqual({
      name: 'rush-cmd',
      path: path.join(rushDir, 'commands', 'rush-cmd.md'),
      source: 'rush',
      repoRoot: rushDir,
    });
  });
});

describe('listResources', () => {
  it('deduplicates by name while preserving project > user > system precedence', () => {
    fs.writeFileSync(path.join(systemAgentsDir, 'commands', 'shared.md'), 'system');
    fs.writeFileSync(path.join(userAgentsDir, 'commands', 'shared.md'), 'user');
    fs.writeFileSync(path.join(projectAgentsDir, 'commands', 'shared.md'), 'project');
    fs.writeFileSync(path.join(userAgentsDir, 'commands', 'user-only.md'), 'user');
    fs.writeFileSync(path.join(systemAgentsDir, 'commands', 'system-only.md'), 'system');

    const resources = listResources('commands', tmpDir);

    expect(resources).toEqual([
      {
        name: 'shared',
        path: path.join(projectAgentsDir, 'commands', 'shared.md'),
        source: 'project',
        repoRoot: projectAgentsDir,
      },
      {
        name: 'user-only',
        path: path.join(userAgentsDir, 'commands', 'user-only.md'),
        source: 'user',
        repoRoot: userAgentsDir,
      },
      {
        name: 'system-only',
        path: path.join(systemAgentsDir, 'commands', 'system-only.md'),
        source: 'system',
        repoRoot: systemAgentsDir,
      },
    ]);
  });
});
