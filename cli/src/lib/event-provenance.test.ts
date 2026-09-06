import { afterEach, describe, expect, it } from 'vitest';
import { resetActorCache } from './actor.js';
import { resetEventProvenanceForTest, stampProvenance } from './event-provenance.js';

afterEach(() => {
  delete process.env.AGENTS_ACTOR;
  delete process.env.AGENTS_ACTOR_KIND;
  resetActorCache();
  resetEventProvenanceForTest();
});

describe('stampProvenance', () => {
  it('combines actor identity with the execution lineage env', () => {
    process.env.AGENTS_ACTOR = 'ada@example.com';
    process.env.AGENTS_ACTOR_KIND = 'human';
    resetActorCache();
    resetEventProvenanceForTest();

    const provenance = stampProvenance({
      AGENTS_SESSION_ID: 'child-session',
      AGENTS_AGENT_NAME: 'codex',
      AGENT_LAUNCH_ID: 'launch-1',
      AGENTS_PARENT_SESSION_ID: 'parent-session',
      AGENTS_PARENT_LAUNCH_ID: 'parent-launch',
      AGENTS_ORIGIN_TERMINAL_ID: 'origin-tab',
    });

    expect(provenance).toMatchObject({
      actor: 'ada@example.com',
      kind: 'human',
      sessionId: 'child-session',
      agent: 'codex',
      launchId: 'launch-1',
      parentSessionId: 'parent-session',
      parentLaunchId: 'parent-launch',
      originTerminalId: 'origin-tab',
    });
  });
});
