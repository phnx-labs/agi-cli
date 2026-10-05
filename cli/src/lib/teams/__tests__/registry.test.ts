import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-teams-registry-test-'));
process.env.HOME = TEST_HOME;

const { createTeam, loadTeams } = await import('../registry.js');

function registryPath(): string {
  return path.join(TEST_HOME, '.agents', '.history', 'teams', 'registry.json');
}

beforeAll(async () => {
  await fsp.mkdir(path.join(TEST_HOME, '.agents', '.history', 'teams'), { recursive: true });
});

beforeEach(async () => {
  await fsp.rm(registryPath(), { force: true });
  await fsp.rm(`${registryPath()}.lock`, { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('teams registry concurrency', () => {
  it('serializes 5 concurrent createTeam calls so all land', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const results = await Promise.allSettled(
      names.map((n) => createTeam(n, { description: `desc-${n}` }))
    );

    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    const reg = await loadTeams();
    expect(Object.keys(reg).sort()).toEqual([...names].sort());
    for (const n of names) {
      expect(reg[n].description).toBe(`desc-${n}`);
      expect(typeof reg[n].created_at).toBe('string');
    }
  });
});

describe('teams registry corruption surfacing', () => {
  it('throws when the registry is unparseable instead of silently returning {}', async () => {
    await fsp.mkdir(path.dirname(registryPath()), { recursive: true });
    fs.writeFileSync(registryPath(), '{ this is not json');

    await expect(loadTeams()).rejects.toThrow(/Team registry corrupted/);
  });

  it('returns {} only when the file truly does not exist', async () => {
    expect(fs.existsSync(registryPath())).toBe(false);
    const reg = await loadTeams();
    expect(reg).toEqual({});
  });
});
