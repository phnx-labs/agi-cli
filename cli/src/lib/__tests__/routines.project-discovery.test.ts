import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as state from '../state.js';
import { listJobs, readJob } from '../scheduling/routines.js';

let tmpDir = '';
let projectDir = '';
let projectRoutinesDir = '';
let userRoutinesDir = '';
let systemRoutinesDir = '';

function writeRoutine(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), yaml.stringify(body), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-project-test-'));
  projectDir = path.join(tmpDir, 'project');
  projectRoutinesDir = path.join(projectDir, '.agents', 'routines');
  userRoutinesDir = path.join(tmpDir, 'user-routines');
  systemRoutinesDir = path.join(tmpDir, 'system-routines');

  fs.mkdirSync(projectRoutinesDir, { recursive: true });
  fs.mkdirSync(userRoutinesDir, { recursive: true });
  fs.mkdirSync(systemRoutinesDir, { recursive: true });

  vi.spyOn(state, 'getRoutinesDir').mockReturnValue(userRoutinesDir);
  vi.spyOn(state, 'getSystemRoutinesDir').mockReturnValue(systemRoutinesDir);
  vi.spyOn(state, 'getProjectRoutinesDir').mockImplementation((cwd?: string) => {
    if (!cwd) return null;
    if (cwd.startsWith(projectDir)) return projectRoutinesDir;
    return null;
  });
  vi.spyOn(state, 'ensureAgentsDir').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('listJobs project discovery', () => {
  it('returns only user routines when called without cwd (daemon path)', () => {
    writeRoutine(userRoutinesDir, 'user-only', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user',
    });
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });

    const jobs = listJobs();
    const names = jobs.map((j) => j.name).sort();
    expect(names).toEqual(['user-only']);
  });

  it('returns project + user routines when called with project cwd', () => {
    writeRoutine(userRoutinesDir, 'user-only', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user',
    });
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });

    const jobs = listJobs(projectDir);
    const names = jobs.map((j) => j.name).sort();
    expect(names).toEqual(['project-only', 'user-only']);
  });

  it('project wins on name collision', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
    });

    const jobs = listJobs(projectDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe('project-version');
  });

  it('keeps a user-layer devices allowlist when a repo-bound project routine has the same name', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
      repo: 'phnx-labs/agents-cli',
      devices: ['zion'],
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
      repo: 'phnx-labs/agents-cli',
    });

    const jobs = listJobs(projectDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe('project-version');
    expect(jobs[0].devices).toEqual(['zion']);
  });

  it('keeps project-layer devices when same-name user routine has no devices', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
      devices: ['ci-runner'],
    });

    const jobs = listJobs(projectDir);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].prompt).toBe('project-version');
    expect(jobs[0].devices).toEqual(['ci-runner']);
  });
});

describe('readJob project discovery', () => {
  it('falls back to user routines when no project layer is provided', () => {
    writeRoutine(userRoutinesDir, 'user-only', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user',
    });

    const job = readJob('user-only');
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('user');
  });

  it('prefers project routine when both exist', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
    });

    const job = readJob('shared', projectDir);
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('project-version');
  });

  it('overlays user-layer devices onto a project routine of the same name', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
      repo: 'phnx-labs/agents-cli',
      devices: ['zion'],
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
      repo: 'phnx-labs/agents-cli',
    });

    const job = readJob('shared', projectDir);
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('project-version');
    expect(job!.devices).toEqual(['zion']);
  });

  it('keeps project-layer devices when same-name user routine has no devices', () => {
    writeRoutine(userRoutinesDir, 'shared', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'user-version',
    });
    writeRoutine(projectRoutinesDir, 'shared', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project-version',
      devices: ['ci-runner'],
    });

    const job = readJob('shared', projectDir);
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('project-version');
    expect(job!.devices).toEqual(['ci-runner']);
  });

  it('returns null when neither layer has the routine', () => {
    expect(readJob('does-not-exist', projectDir)).toBeNull();
  });
});
