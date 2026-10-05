import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentManager, AgentProcess, AgentStatus } from './agents.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-meta-corruption-'));
}

function writeCorruptMeta(base: string, id: string, content = '{ "worktree_name": "surf'): string {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(metaPath, content);
  return metaPath;
}

async function makeOwner(
  base: string, id: string, task: string, worktree: string, status: AgentStatus,
): Promise<void> {
  const agent = new AgentProcess(
    id, task, 'claude', 'do a thing', null, 'plan',
    null, status, new Date(), status === AgentStatus.PENDING ? null : new Date(), base,
    null, null, null, null, null, null, null, worktree, [],
    null, null, null, null, null, null, worktree,
  );
  await agent.saveMeta();
}

describe('saveMeta() writes atomically, via tmp + rename (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate('a save that cannot complete leaves the previous valid record untouched, never torn', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-1';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
    );
    await agent.saveMeta();
    const agentDir = path.join(base, id);
    const metaPath = path.join(agentDir, 'meta.json');
    const before = fs.readFileSync(metaPath, 'utf-8');
    expect(JSON.parse(before).prompt).toBe('v1');

    agent.prompt = 'v2';
    fs.chmodSync(agentDir, 0o555);
    try {
      await expect(agent.saveMeta()).rejects.toThrow();

      const after = fs.readFileSync(metaPath, 'utf-8');
      expect(after).toBe(before);
      expect(() => JSON.parse(after)).not.toThrow();
      expect(JSON.parse(after).prompt).toBe('v1');
    } finally {
      fs.chmodSync(agentDir, 0o755);
    }

    expect(fs.readdirSync(agentDir)).toEqual(['meta.json']);
  });

  it('leaves no stray tmp file behind on a normal, uninterrupted save', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-2';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
    );
    await agent.saveMeta();

    const entries = fs.readdirSync(path.join(base, id));
    expect(entries).toEqual(['meta.json']);
  });

  it('every repeated save round-trips through loadFromDisk as fully valid JSON', async () => {
    const base = tmpBase();
    dirs.push(base);
    const id = 'atomic-3';

    const agent = new AgentProcess(
      id, 'atomic-team', 'claude', 'v1', null, 'plan', null, AgentStatus.PENDING, new Date(), null, base,
    );
    for (const status of [AgentStatus.PENDING, AgentStatus.RUNNING, AgentStatus.COMPLETED]) {
      agent.status = status;
      if (status === AgentStatus.COMPLETED) agent.completedAt = new Date();
      await agent.saveMeta();
      const reread = await AgentProcess.loadFromDisk(id, base);
      expect(reread?.status).toBe(status);
    }
  });
});

describe('loadFromDisk() quarantines an unreadable meta.json instead of treating it as absent (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a directory with no meta.json at all is genuinely absent — returns null, nothing to quarantine', async () => {
    const base = tmpBase();
    dirs.push(base);
    fs.mkdirSync(path.join(base, 'empty-1'), { recursive: true });

    const result = await AgentProcess.loadFromDisk('empty-1', base);
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(base, 'empty-1', 'meta.json.corrupt'))).toBe(false);
  });

  it('a READ error (not corruption) returns null WITHOUT quarantining — the intact record is preserved for the guard', async () => {
    const base = tmpBase();
    dirs.push(base);
    const agentDir = path.join(base, 'readerr-1');
    const metaPath = path.join(agentDir, 'meta.json');
    fs.mkdirSync(metaPath, { recursive: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await AgentProcess.loadFromDisk('readerr-1', base);
      expect(result).toBeNull();
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(false);
      expect(fs.existsSync(metaPath)).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('an unparseable meta.json is renamed to meta.json.corrupt, warns, and loadFromDisk returns null', async () => {
    const base = tmpBase();
    dirs.push(base);
    const metaPath = writeCorruptMeta(base, 'corrupt-1');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await AgentProcess.loadFromDisk('corrupt-1', base);
      expect(result).toBeNull();
      expect(fs.existsSync(metaPath)).toBe(false);
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(true);
      expect(fs.readFileSync(`${metaPath}.corrupt`, 'utf-8')).toBe('{ "worktree_name": "surf');
      expect(warnSpy).toHaveBeenCalled();
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('quarantined');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a re-read after quarantine sees genuine absence (ENOENT), not "unreadable", so it never re-quarantines', async () => {
    const base = tmpBase();
    dirs.push(base);
    const metaPath = writeCorruptMeta(base, 'corrupt-2');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await AgentProcess.loadFromDisk('corrupt-2', base)).toBeNull();
      warnSpy.mockClear();
      expect(await AgentProcess.loadFromDisk('corrupt-2', base)).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(`${metaPath}.corrupt`)).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('loadExistingAgents (AgentManager construction) quarantines a corrupt sibling while still loading a healthy record', async () => {
    const base = tmpBase();
    dirs.push(base);
    writeCorruptMeta(base, 'corrupt-3');
    await makeOwner(base, 'healthy-1', 'meta-team', 'some-surface', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    const all = await mgr.listAll();

    expect(all.map((a) => a.agentId)).toEqual(['healthy-1']);
    expect(fs.existsSync(path.join(base, 'corrupt-3', 'meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'corrupt-3', 'meta.json.corrupt'))).toBe(true);
  });
});

describe('isWorktreeClaimed() recovers once a corrupt record is quarantined (RUSH-2429)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('a genuine orphan is unclaimed again after the one corrupt record blocking it is quarantined', async () => {
    const base = tmpBase();
    dirs.push(base);
    writeCorruptMeta(base, 'corrupt-4');

    const mgr = new AgentManager(50, base);
    await mgr.rescanFromDisk();

    expect(fs.existsSync(path.join(base, 'corrupt-4', 'meta.json'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'corrupt-4', 'meta.json.corrupt'))).toBe(true);

    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
  });

  it('quarantining the corrupt record does not un-claim a name a healthy sibling genuinely still owns', async () => {
    const base = tmpBase();
    dirs.push(base);
    writeCorruptMeta(base, 'corrupt-5');
    await makeOwner(base, 'live-1', 'meta-team', 'still-claimed', AgentStatus.PENDING);

    const mgr = new AgentManager(50, base);
    await mgr.rescanFromDisk();

    expect(fs.existsSync(path.join(base, 'corrupt-5', 'meta.json.corrupt'))).toBe(true);
    expect(await mgr.isWorktreeClaimed('surface')).toBe(false);
    expect(await mgr.isWorktreeClaimed('still-claimed')).toBe(true);
  });
});
