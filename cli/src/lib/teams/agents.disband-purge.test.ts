import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-disband-home-'));
process.env.HOME = TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, '.agents', '.history', 'teams'), { recursive: true });

const {
  AgentManager,
  AgentProcess,
  AgentStatus,
} = await import('./agents.js');
const {
  createTeam,
  isTeamDisbanded,
  removeTeam,
  teamExists,
} = await import('./registry.js');

const bases: string[] = [];

function tmpBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-disband-base-'));
  bases.push(base);
  return base;
}

async function makePending(
  base: string,
  team: string,
  id: string,
  name: string,
): Promise<InstanceType<typeof AgentProcess>> {
  const agent = new AgentProcess(
    id,
    team,
    'claude',
    'do a thing',
    null,
    'plan',
    null,
    AgentStatus.PENDING,
    new Date(),
    null,
    base,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    name,
    [],
  );
  await agent.saveMeta();
  return agent;
}

afterEach(async () => {
  const reg = path.join(TEST_HOME, '.agents', '.history', 'teams', 'registry.json');
  const disbanded = path.join(TEST_HOME, '.agents', '.history', 'teams', 'disbanded');
  try { fs.rmSync(reg, { force: true }); } catch {  }
  try { fs.rmSync(`${reg}.lock`, { recursive: true, force: true }); } catch {  }
  try { fs.rmSync(disbanded, { recursive: true, force: true }); } catch {  }
  for (const d of bases.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {  }
  }
});

afterAll(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch {  }
});

describe('disband is terminal (RUSH-2450)', () => {
  it('purgeByTask drops memory + disk; second purge is empty; saveMeta cannot resurrect after disband tombstone', async () => {
    const base = tmpBase();

    await createTeam('daemon-reliability');
    const a = await makePending(base, 'daemon-reliability', 'aaa11111-1111-1111-1111-111111111111', 'decompose');
    const b = await makePending(base, 'daemon-reliability', 'bbb22222-2222-2222-2222-222222222222', 'crash-loop');

    const mgr = new AgentManager(50, base);
    expect(await mgr.listByTask('daemon-reliability')).toHaveLength(2);

    const existed = await removeTeam('daemon-reliability');
    expect(existed).toBe(true);
    expect(await teamExists('daemon-reliability')).toBe(false);
    expect(await isTeamDisbanded('daemon-reliability')).toBe(true);

    const purged = await mgr.purgeByTask('daemon-reliability');
    expect(purged.sort()).toEqual([
      'aaa11111-1111-1111-1111-111111111111',
      'bbb22222-2222-2222-2222-222222222222',
    ].sort());
    expect(await mgr.listByTask('daemon-reliability')).toHaveLength(0);
    expect(fs.readdirSync(base)).toEqual([]);

    const purgedAgain = await mgr.purgeByTask('daemon-reliability');
    expect(purgedAgain).toEqual([]);

    await a.saveMeta();
    await b.saveMeta();
    expect(fs.readdirSync(base)).toEqual([]);

    const fresh = new AgentManager(50, base);
    expect(await fresh.listByTask('daemon-reliability')).toHaveLength(0);
  });

  it('re-creating the team clears the tombstone so new teammates can persist', async () => {
    const base = tmpBase();

    await createTeam('reuse-me');
    await removeTeam('reuse-me');
    expect(await isTeamDisbanded('reuse-me')).toBe(true);

    await createTeam('reuse-me');
    expect(await isTeamDisbanded('reuse-me')).toBe(false);
    expect(await teamExists('reuse-me')).toBe(true);

    await makePending(base, 'reuse-me', 'ccc33333-3333-3333-3333-333333333333', 'fresh');
    expect(fs.existsSync(path.join(base, 'ccc33333-3333-3333-3333-333333333333', 'meta.json'))).toBe(true);
  });
});
