import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import * as state from '../state.js';
import * as projects from '../projects.js';
import {
  materialiseProjectRoutine,
  findProjectRoutine,
  discoverProjectRoutines,
  syncProjectRoutines,
  syncAllProjectRoutines,
  materialisedProjectRoots,
  expandProjectPath,
} from '../routines-project.js';
import { listJobs, readJob, setJobEnabled, resolveHostStrategy, parseHostStrategy, placementRequiresFiringPin } from '../scheduling/routines.js';
import { resolvePlacementTarget, pickFleetDevice } from '../routines-placement.js';
import type { JobConfig } from '../scheduling/routines.js';

let tmpDir = '';
let projectDir = '';
let projectRoutinesDir = '';
let userRoutinesDir = '';
let systemRoutinesDir = '';
let userAgentsDir = '';

function writeRoutine(dir: string, name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.yml`), yaml.stringify(body), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-project-sync-'));
  projectDir = path.join(tmpDir, 'project');
  projectRoutinesDir = path.join(projectDir, '.agents', 'routines');
  userRoutinesDir = path.join(tmpDir, 'user-routines');
  systemRoutinesDir = path.join(tmpDir, 'system-routines');
  userAgentsDir = path.join(tmpDir, 'user-agents');

  fs.mkdirSync(projectRoutinesDir, { recursive: true });
  fs.mkdirSync(userRoutinesDir, { recursive: true });
  fs.mkdirSync(systemRoutinesDir, { recursive: true });
  fs.mkdirSync(userAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(userAgentsDir, 'agents.yaml'), 'routines: {}\n', 'utf-8');

  vi.spyOn(state, 'getRoutinesDir').mockReturnValue(userRoutinesDir);
  vi.spyOn(state, 'getSystemRoutinesDir').mockReturnValue(systemRoutinesDir);
  vi.spyOn(state, 'getProjectRoutinesDir').mockImplementation((cwd?: string) => {
    if (!cwd) return null;
    if (path.resolve(cwd).startsWith(projectDir) || path.resolve(cwd) === projectDir) {
      return projectRoutinesDir;
    }
    return null;
  });
  vi.spyOn(state, 'getProjectAgentsDir').mockImplementation((start?: string) => {
    const s = path.resolve(start ?? process.cwd());
    if (s === projectDir || s.startsWith(projectDir + path.sep)) {
      return path.join(projectDir, '.agents');
    }
    return null;
  });
  vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(userAgentsDir);
  vi.spyOn(state, 'ensureAgentsDir').mockImplementation(() => {});

  const metaPath = path.join(userAgentsDir, 'agents.yaml');
  vi.spyOn(state, 'readMeta').mockImplementation(() => {
    try {
      return yaml.parse(fs.readFileSync(metaPath, 'utf-8')) ?? {};
    } catch {
      return {};
    }
  });
  vi.spyOn(state, 'writeMeta').mockImplementation((meta) => {
    fs.writeFileSync(metaPath, yaml.stringify(meta), 'utf-8');
  });
  vi.spyOn(state, 'updateMeta').mockImplementation((updates) => {
    const cur = state.readMeta();
    const next = typeof updates === 'function' ? updates(cur) : { ...cur, ...updates };
    state.writeMeta(next);
    return next;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hostStrategy helpers', () => {
  it('resolveHostStrategy defaults to local, infers host from host:', () => {
    expect(resolveHostStrategy({})).toBe('local');
    expect(resolveHostStrategy({ host: 'gpu-box' })).toBe('host');
    expect(resolveHostStrategy({ hostStrategy: 'fleet' })).toBe('fleet');
    expect(resolveHostStrategy({ hostStrategy: 'cloud', host: 'x' })).toBe('cloud');
  });

  it('parseHostStrategy accepts known values and rejects unknowns', () => {
    expect(parseHostStrategy('fleet')).toBe('fleet');
    expect(parseHostStrategy('LOCAL')).toBe('local');
    expect(parseHostStrategy(undefined)).toBeNull();
    expect(() => parseHostStrategy('everywhere')).toThrow(/Invalid placement/);
  });

  it('placementRequiresFiringPin is true for host/fleet/cloud', () => {
    expect(placementRequiresFiringPin('local')).toBe(false);
    expect(placementRequiresFiringPin('host')).toBe(true);
    expect(placementRequiresFiringPin('fleet')).toBe(true);
    expect(placementRequiresFiringPin('cloud')).toBe(true);
  });
});

describe('enable = materialise + device flag (one flag, no allowlist)', () => {
  it('materialiseProjectRoutine writes a user copy with source provenance but does NOT enable it', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *',
      agent: 'claude',
      prompt: 'review the project',
      enabled: true,
    });
    const res = materialiseProjectRoutine(projectDir, 'daily');
    expect('job' in res).toBe(true);

    const job = readJob('daily');
    expect(job).not.toBeNull();
    expect(job!.prompt).toBe('review the project');
    expect(job!.source?.kind).toBe('project');
    expect(job!.source?.projectPath).toBe(expandProjectPath(projectDir));
    expect(job!.enabled).toBe(false);
  });

  it('a materialised-but-not-enabled routine is inert on the daemon path', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'p', enabled: true,
    });
    materialiseProjectRoutine(projectDir, 'daily');
    const job = listJobs().find((j) => j.name === 'daily');
    expect(job).toBeDefined();
    expect(job!.enabled).toBe(false);
  });

  it('setJobEnabled true after materialise is the one thing that turns firing on', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'p',
    });
    materialiseProjectRoutine(projectDir, 'daily');
    expect(readJob('daily')!.enabled).toBe(false);
    setJobEnabled('daily', true);
    expect(readJob('daily')!.enabled).toBe(true);
    setJobEnabled('daily', false);
    expect(readJob('daily')!.enabled).toBe(false);
  });

  it('findProjectRoutine resolves a name via the current project', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'p',
    });
    const found = findProjectRoutine('daily', projectDir);
    expect(found && 'file' in found).toBe(true);
    expect((found as { projectRoot: string }).projectRoot).toBe(expandProjectPath(projectDir));
    expect(findProjectRoutine('nope', projectDir)).toBeNull();
  });

  it('materialiseProjectRoutine refuses to clobber a hand-authored routine of the same name', () => {
    writeRoutine(userRoutinesDir, 'daily', {
      schedule: '0 8 * * *', agent: 'claude', prompt: 'user-owned',
    });
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'project-owned',
    });
    const res = materialiseProjectRoutine(projectDir, 'daily');
    expect('error' in res).toBe(true);
    expect(readJob('daily')!.prompt).toBe('user-owned');
  });
});

describe('sync = definition-only refresh (never changes enablement)', () => {
  it('refreshes an already-materialised copy when project YAML changes', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'v1',
    });
    materialiseProjectRoutine(projectDir, 'daily');
    expect(readJob('daily')!.prompt).toBe('v1');

    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'v2',
    });
    const result = syncProjectRoutines(projectDir);
    expect(result.synced).toEqual(['daily']);
    expect(readJob('daily')!.prompt).toBe('v2');
  });

  it('does NOT materialise a project file that was never enabled', () => {
    writeRoutine(projectRoutinesDir, 'available', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'not chosen',
    });
    const result = syncProjectRoutines(projectDir);
    expect(result.synced).toEqual([]);
    expect(readJob('available')).toBeNull();
  });

  it('a refresh never enables — an enabled routine stays enabled, a disabled one stays disabled', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'v1', enabled: true,
    });
    materialiseProjectRoutine(projectDir, 'daily');
    expect(readJob('daily')!.enabled).toBe(false);
    syncProjectRoutines(projectDir);
    expect(readJob('daily')!.enabled).toBe(false);

    setJobEnabled('daily', true);
    syncProjectRoutines(projectDir);
    expect(readJob('daily')!.enabled).toBe(true);
  });

  it('preserves the original createdAt stamp across refreshes', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'v1',
    });
    materialiseProjectRoutine(projectDir, 'daily');
    const first = readJob('daily')!.createdAt;
    expect(first).toBeTruthy();

    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'v2',
    });
    syncProjectRoutines(projectDir);
    expect(readJob('daily')!.prompt).toBe('v2');
    expect(readJob('daily')!.createdAt).toBe(first);
  });

  it('removes a materialised copy when its project YAML disappears', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'gone soon',
    });
    materialiseProjectRoutine(projectDir, 'daily');
    expect(readJob('daily')).not.toBeNull();

    fs.unlinkSync(path.join(projectRoutinesDir, 'daily.yml'));
    const result = syncProjectRoutines(projectDir);
    expect(result.removed).toContain('daily');
    expect(readJob('daily')).toBeNull();
  });

  it('syncAllProjectRoutines derives roots from materialised routines, not an allowlist', () => {
    writeRoutine(projectRoutinesDir, 'daily', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'p',
    });
    expect(materialisedProjectRoots()).toEqual([]);
    expect(syncAllProjectRoutines().projects).toEqual([]);

    materialiseProjectRoutine(projectDir, 'daily');
    expect(materialisedProjectRoots()).toContain(expandProjectPath(projectDir));
    const all = syncAllProjectRoutines();
    expect(all.projects.map((p) => p.projectRoot)).toContain(expandProjectPath(projectDir));
  });
});

describe('discoverProjectRoutines (from registered projects)', () => {
  it('surfaces not-yet-materialised project routines as disabled, and drops them once materialised', () => {
    writeRoutine(projectRoutinesDir, 'available', {
      schedule: '0 9 * * *', agent: 'claude', prompt: 'p',
    });
    vi.spyOn(projects, 'listProjectDefs').mockReturnValue([{ name: 'proj' } as projects.ProjectDef]);
    vi.spyOn(projects, 'projectDirsAbs').mockReturnValue([projectDir]);

    const discovered = discoverProjectRoutines();
    expect(discovered.map((d) => d.name)).toContain('available');
    expect(discovered.find((d) => d.name === 'available')!.config.enabled).toBe(false);

    materialiseProjectRoutine(projectDir, 'available');
    expect(discoverProjectRoutines().map((d) => d.name)).not.toContain('available');
  });
});

describe('placement resolution', () => {
  it('local stays local; host self is local; host remote is host', async () => {
    const local = await resolvePlacementTarget({
      name: 'a', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'local',
    } as JobConfig);
    expect(local).toEqual({ mode: 'local' });

    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    const hostSelf = await resolvePlacementTarget({
      name: 'b', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
      host: self,
    } as JobConfig);
    expect(hostSelf).toEqual({ mode: 'local' });

    const hostRemote = await resolvePlacementTarget({
      name: 'c', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
      host: 'some-other-box',
    } as JobConfig);
    expect(hostRemote).toEqual({ mode: 'host', host: 'some-other-box' });
  });

  it('cloud resolves to cloud mode', async () => {
    const t = await resolvePlacementTarget({
      name: 'd', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'cloud',
    } as JobConfig);
    expect(t).toEqual({ mode: 'cloud' });
  });

  it('fleet falls back to self when the device registry is empty', () => {
    const picked = pickFleetDevice({ devices: ['some-other-box'] });
    expect(typeof picked).toBe('string');
    expect(picked!.length).toBeGreaterThan(0);
  });

  it('host strategy without host throws', async () => {
    await expect(resolvePlacementTarget({
      name: 'e', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      hostStrategy: 'host',
    } as JobConfig)).rejects.toThrow(/no host/);
  });

  it("fleet host:'auto' routes through the agents-run device picker at fire time (RUSH-2719)", async () => {
    let askedAgent: string | undefined;
    const t = await resolvePlacementTarget({
      name: 'auto-place', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'fleet',
      host: 'auto',
    } as JobConfig, {
      resolveDeviceAuto: async (agent) => {
        askedAgent = agent;
        return { pickedDeviceKey: 'healthy-box' };
      },
    });
    expect(askedAgent).toBe('claude');
    expect(t).toEqual({ mode: 'host', host: 'healthy-box' });
  });

  it("fleet host:'auto' surfaces the picker's no-healthy-device error instead of a generic one", async () => {
    await expect(resolvePlacementTarget({
      name: 'auto-dry', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'fleet',
      host: 'auto',
    } as JobConfig, {
      resolveDeviceAuto: async () => {
        throw new Error('agents: no healthy device can run claude — excluded: box-a (loaded)');
      },
    })).rejects.toThrow(/no healthy device can run claude/);
  });

  it('fleet with a self fire-pin still resolves (devices is not the execution pool)', async () => {
    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    const t = await resolvePlacementTarget({
      name: 'fleet-pin', mode: 'auto', effort: 'auto', timeout: '10m', enabled: true, prompt: 'p',
      agent: 'claude',
      hostStrategy: 'fleet',
      devices: [self],
    } as JobConfig);
    expect(t.mode === 'local' || t.mode === 'host').toBe(true);
  });
});

describe('listJobs still excludes un-materialised project routines from daemon path', () => {
  it('listJobs() without cwd does not see project-only YAML', () => {
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });
    const names = listJobs().map((j) => j.name);
    expect(names).not.toContain('project-only');
  });

  it('after enable materialises it, listJobs() (daemon path) sees the copy', () => {
    writeRoutine(projectRoutinesDir, 'project-only', {
      schedule: '0 10 * * *',
      agent: 'claude',
      prompt: 'project',
    });
    materialiseProjectRoutine(projectDir, 'project-only');
    const names = listJobs().map((j) => j.name);
    expect(names).toContain('project-only');
  });
});
