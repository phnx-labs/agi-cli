import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newFixture, writeFile, removeFile,
  build, isStale,
  type Fixture,
} from './_fixtures.js';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const HARNESS = path.join(__dirname, '_harness.ts');


function buildRaw(fx: Fixture, env: Record<string, string> = {}): { permissions: { groups: Record<string, unknown>; permissionPreset: string | null } } {
  const out = execFileSync('bun', [HARNESS, JSON.stringify({
    cmd: 'build', agent: 'claude', version: '0.0.0-test', cwd: fx.projectRoot
  })], { env: { ...process.env, HOME: fx.home, ...env }, encoding: 'utf-8' });
  return JSON.parse(out).manifest;
}

function isStaleEnv(fx: Fixture, env: Record<string, string> = {}): boolean {
  const out = execFileSync('bun', [HARNESS, JSON.stringify({
    cmd: 'isStale', agent: 'claude', version: '0.0.0-test', cwd: fx.projectRoot
  })], { env: { ...process.env, HOME: fx.home, ...env }, encoding: 'utf-8' });
  return JSON.parse(out).stale;
}

function detectCopilotPermissions(fx: Fixture, versionHome: string, cwd: string): string[] {
  const out = execFileSync('bun', [HARNESS, JSON.stringify({
    cmd: 'detectPermissions',
    agent: 'copilot',
    version: '0.0.0-test',
    versionHome,
    cwd,
  })], { env: { ...process.env, HOME: fx.home }, encoding: 'utf-8' });
  return JSON.parse(out).names;
}

const yaml = (allow: string[] = []) =>
  `allow:\n${allow.map(r => `  - ${JSON.stringify(r)}`).join('\n')}\n`;

describe('staleness e2e: permissions', () => {
  let fx: Fixture;
  beforeEach(() => { fx = newFixture('perm'); });
  afterEach(()  => fx.cleanup());

  it('empty -> clean', () => {
    build(fx);
    expect(isStale(fx)).toBe(false);
  });

  it('manifest records every group across user + system (merged, not first-wins shadowed)', () => {
    writeFile(fx, 'system', 'permissions/groups/base.yaml',   yaml(['Bash(ls)']));
    writeFile(fx, 'user',   'permissions/groups/extra.yaml',  yaml(['Bash(pwd)']));
    const built = buildRaw(fx);
    expect(new Set(Object.keys(built.permissions.groups))).toEqual(new Set(['base', 'extra']));
  });

  it('user shadows system on name collision (first-wins user > system)', () => {
    writeFile(fx, 'system', 'permissions/groups/shared.yaml', yaml(['Bash(sys)']));
    writeFile(fx, 'user',   'permissions/groups/shared.yaml', yaml(['Bash(user)']));
    build(fx);
    writeFile(fx, 'system', 'permissions/groups/shared.yaml', yaml(['Bash(sys-v2)']));
    expect(isStale(fx)).toBe(false);
    writeFile(fx, 'user',   'permissions/groups/shared.yaml', yaml(['Bash(user-v2)']));
    expect(isStale(fx)).toBe(true);
  });

  it('group added -> stale', () => {
    writeFile(fx, 'system', 'permissions/groups/a.yaml', yaml(['Bash(ls)']));
    build(fx);
    writeFile(fx, 'system', 'permissions/groups/b.yaml', yaml(['Bash(pwd)']));
    expect(isStale(fx)).toBe(true);
  });

  it('group removed -> stale', () => {
    writeFile(fx, 'system', 'permissions/groups/a.yaml', yaml(['Bash(ls)']));
    writeFile(fx, 'system', 'permissions/groups/b.yaml', yaml(['Bash(pwd)']));
    build(fx);
    removeFile(fx, 'system', 'permissions/groups/b.yaml');
    expect(isStale(fx)).toBe(true);
  });

  it('AGENTS_PERMISSION_PRESET env change -> stale (preset selection changes which groups apply)', () => {
    writeFile(fx, 'system', 'permissions/groups/a.yaml', yaml(['Bash(ls)']));
    build(fx);
    expect(isStaleEnv(fx, { AGENTS_PERMISSION_PRESET: 'strict' })).toBe(true);
  });

  it('PROJECT permissions/groups/ ignored (current sync writer reads user+system only)', () => {
    writeFile(fx, 'project', 'permissions/groups/project-only.yaml', yaml(['Bash(scope)']));
    const built = buildRaw(fx);
    expect(built.permissions.groups['project-only']).toBeUndefined();
    expect(isStale(fx)).toBe(false);
  });

  it('non-yaml files in groups/ are ignored', () => {
    writeFile(fx, 'user', 'permissions/groups/note.txt', 'no');
    writeFile(fx, 'user', 'permissions/groups/ok.yaml', yaml(['Bash(echo)']));
    const built = buildRaw(fx);
    expect(Object.keys(built.permissions.groups)).toEqual(['ok']);
  });

  it('Copilot detector only reports permissions for the current project location', () => {
    writeFile(fx, 'system', 'permissions/groups/copilot-group.yaml', yaml(['Bash(ls)']));
    const versionHome = path.join(fx.home, 'copilot-home');
    const projA = path.join(fx.home, 'proj-a');
    const projB = path.join(fx.home, 'proj-b');
    const configPath = path.join(versionHome, '.copilot', 'permissions-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      locations: {
        [path.resolve(projA)]: {
          tool_approvals: [{ kind: 'read' }],
        },
      },
    }, null, 2));

    expect(detectCopilotPermissions(fx, versionHome, projA)).toEqual(['copilot-group']);
    expect(detectCopilotPermissions(fx, versionHome, projB)).toEqual([]);
  });
});
