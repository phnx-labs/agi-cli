import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AgentProcess,
  AgentStatus,
  buildTeammateSpawnEnv,
} from './agents.js';
import { resetActorCache } from '../actor.js';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-actor-test-'));
}

function withFrozenActor(id: string, kind: 'human' | 'agent', run: () => void): void {
  const prevActor = process.env.AGENTS_ACTOR;
  const prevKind = process.env.AGENTS_ACTOR_KIND;
  process.env.AGENTS_ACTOR = id;
  process.env.AGENTS_ACTOR_KIND = kind;
  resetActorCache();
  try {
    run();
  } finally {
    if (prevActor === undefined) delete process.env.AGENTS_ACTOR;
    else process.env.AGENTS_ACTOR = prevActor;
    if (prevKind === undefined) delete process.env.AGENTS_ACTOR_KIND;
    else process.env.AGENTS_ACTOR_KIND = prevKind;
    resetActorCache();
  }
}

afterEach(() => resetActorCache());

describe('local teammate spawn env (frozen actor inheritance)', () => {
  it('stamps AGENTS_ACTOR onto the local teammate env', () => {
    withFrozenActor('alice@example.com', 'human', () => {
      const env = buildTeammateSpawnEnv(null);
      expect(env.AGENTS_ACTOR).toBe('alice@example.com');
      expect(env.AGENTS_ACTOR_KIND).toBe('human');
    });
  });

  it('two teammates under one orchestrator share the SAME actor id', () => {
    withFrozenActor('alice@example.com', 'human', () => {
      const envA = buildTeammateSpawnEnv(null);
      const envB = buildTeammateSpawnEnv({ FOO: 'bar' });
      expect(envA.AGENTS_ACTOR).toBe(envB.AGENTS_ACTOR);
      expect(envB.AGENTS_ACTOR).toBe('alice@example.com');
    });
  });

  it('lets --env overrides win over the actor defaults (precedence)', () => {
    withFrozenActor('alice@example.com', 'human', () => {
      const env = buildTeammateSpawnEnv({ AGENTS_ACTOR: 'override@example.com' });
      expect(env.AGENTS_ACTOR).toBe('override@example.com');
    });
  });
});

describe('teammate record carries the actor', () => {
  it('populates actor from the resolved actor at construction and emits it in toDict', () => {
    withFrozenActor('bob@example.com', 'human', () => {
      const a = new AgentProcess('a1', 't', 'claude', 'do a thing');
      expect(a.actor).toBe('bob@example.com');
      expect(a.toDict().actor).toBe('bob@example.com');
    });
  });

  it('round-trips actor through saveMeta -> loadFromDisk', async () => {
    const base = tmpBase();
    try {
      const id = 'a2';
      fs.mkdirSync(path.join(base, id), { recursive: true });
      await withFrozenActorAsync('carol@example.com', async () => {
        const a = new AgentProcess(
          id, 't', 'claude', 'do a thing',
          null, 'plan', null, AgentStatus.RUNNING, new Date(), null, base,
        );
        expect(a.actor).toBe('carol@example.com');
        await a.saveMeta();
      });

      await withFrozenActorAsync('someone-else@example.com', async () => {
        const loaded = await AgentProcess.loadFromDisk(id, base);
        expect(loaded).not.toBeNull();
        expect(loaded!.actor).toBe('carol@example.com');
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('a legacy teammate without a persisted actor loads with actor=null', async () => {
    const base = tmpBase();
    try {
      const id = 'legacy';
      const dir = path.join(base, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        agent_id: id,
        task_name: 't',
        agent_type: 'claude',
        prompt: 'do a thing',
        mode: 'plan',
        status: 'running',
        started_at: new Date().toISOString(),
      }));
      const loaded = await AgentProcess.loadFromDisk(id, base);
      expect(loaded).not.toBeNull();
      expect(loaded!.actor).toBeNull();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

async function withFrozenActorAsync(id: string, run: () => Promise<void>): Promise<void> {
  const prevActor = process.env.AGENTS_ACTOR;
  const prevKind = process.env.AGENTS_ACTOR_KIND;
  process.env.AGENTS_ACTOR = id;
  process.env.AGENTS_ACTOR_KIND = 'human';
  resetActorCache();
  try {
    await run();
  } finally {
    if (prevActor === undefined) delete process.env.AGENTS_ACTOR;
    else process.env.AGENTS_ACTOR = prevActor;
    if (prevKind === undefined) delete process.env.AGENTS_ACTOR_KIND;
    else process.env.AGENTS_ACTOR_KIND = prevKind;
    resetActorCache();
  }
}
