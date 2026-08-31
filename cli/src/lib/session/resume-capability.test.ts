import { describe, expect, it } from 'vitest';
import { SESSION_AGENTS, type SessionMeta } from './types.js';
import { isResumableHarness, RESUMABLE_HARNESSES } from './resume-capability.js';
import { buildResumeCommand } from '../../commands/sessions.js';

/**
 * RESUMABLE_HARNESSES is the ONE authority the SessionPicker projection, the
 * watch Previous set (buildPreviousRows), and buildResumeCommand all consult.
 * If they drift, a captured-only harness reappears with a dead Resume — the
 * exact PHNX-3621 regression. Pin the predicate to the real command builder.
 */
describe('isResumableHarness is the single authority behind buildResumeCommand', () => {
  it('agrees with buildResumeCommand for every session harness', () => {
    for (const agent of SESSION_AGENTS) {
      const session = { id: 'x', agent } as SessionMeta;
      expect(isResumableHarness(agent)).toBe(buildResumeCommand(session) !== null);
    }
  });

  it('lists exactly the natively-resumable harnesses', () => {
    expect([...RESUMABLE_HARNESSES].sort()).toEqual(['claude', 'codex', 'muse', 'opencode']);
  });
});
