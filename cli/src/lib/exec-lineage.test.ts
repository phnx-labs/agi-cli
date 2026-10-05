import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { buildExecEnv } from './exec.js';

// A sub-agent's events carry a walkable "spawned by" edge only if buildExecEnv stamps the
// spawner's session as AGENTS_PARENT_SESSION_ID. options.sessionId is the child's id, so the
// parent comes from the spawning process's live env. Exercises the real env build and delivery.
describe('AGENTS_PARENT_SESSION_ID lineage', () => {
  const savedParent = process.env.AGENTS_SESSION_ID;
  const savedAgentParent = process.env.AGENT_SESSION_ID;
  const savedLineageParent = process.env.AGENTS_PARENT_SESSION_ID;
  const savedRuntime = process.env.AGENTS_RUNTIME;
  afterEach(() => {
    if (savedParent === undefined) delete process.env.AGENTS_SESSION_ID;
    else process.env.AGENTS_SESSION_ID = savedParent;
    if (savedAgentParent === undefined) delete process.env.AGENT_SESSION_ID;
    else process.env.AGENT_SESSION_ID = savedAgentParent;
    if (savedLineageParent === undefined) delete process.env.AGENTS_PARENT_SESSION_ID;
    else process.env.AGENTS_PARENT_SESSION_ID = savedLineageParent;
    if (savedRuntime === undefined) delete process.env.AGENTS_RUNTIME;
    else process.env.AGENTS_RUNTIME = savedRuntime;
  });

  const PARENT = '11111111-1111-4111-8111-111111111111';
  const CHILD = '22222222-2222-4222-8222-222222222222';

  it('stamps the spawner session as the child parent, and delivers it to the child', () => {
    process.env.AGENTS_RUNTIME = 'headless';
    process.env.AGENTS_SESSION_ID = PARENT;
    delete process.env.AGENT_SESSION_ID;
    const env = buildExecEnv({ agent: 'codex', cwd: process.cwd(), mode: 'auto', effort: 'auto', sessionId: CHILD });
    // The child's own session is CHILD; its recorded parent is the spawner PARENT.
    expect(env.AGENTS_SESSION_ID).toBe(CHILD);
    expect(env.AGENTS_PARENT_SESSION_ID).toBe(PARENT);
    const r = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.AGENTS_PARENT_SESSION_ID || "MISSING")'],
      { env, encoding: 'utf8' },
    );
    expect(r.stdout).toBe(PARENT);
  });

  it('does not name a same-session resume as its own parent', () => {
    process.env.AGENTS_RUNTIME = 'headless';
    process.env.AGENTS_SESSION_ID = CHILD;
    delete process.env.AGENT_SESSION_ID;
    process.env.AGENTS_PARENT_SESSION_ID = PARENT;
    const env = buildExecEnv({ agent: 'codex', cwd: process.cwd(), mode: 'auto', effort: 'auto', sessionId: CHILD });
    expect(env.AGENTS_PARENT_SESSION_ID).toBeUndefined();
  });

  it('preserves the forwarded parent across a transport launcher without claiming its identity', () => {
    delete process.env.AGENTS_SESSION_ID;
    delete process.env.AGENT_SESSION_ID;
    process.env.AGENTS_PARENT_SESSION_ID = PARENT;
    const runtime = process.env.AGENTS_RUNTIME;
    delete process.env.AGENTS_RUNTIME;
    const env = buildExecEnv({ agent: 'codex', cwd: process.cwd(), mode: 'auto', effort: 'auto', sessionId: CHILD });
    if (runtime !== undefined) process.env.AGENTS_RUNTIME = runtime;
    const r = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.AGENTS_SESSION_ID, process.env.AGENTS_PARENT_SESSION_ID]))'], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([CHILD, PARENT]);
  });
});
