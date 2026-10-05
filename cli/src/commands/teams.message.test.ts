import { describe, it, expect } from 'vitest';
import { decideTeamMessageRoute } from './teams.js';
import { AgentStatus } from '../lib/teams/agents.js';

describe('decideTeamMessageRoute', () => {
  it('running + message -> steer via mailbox', () => {
    expect(decideTeamMessageRoute(AgentStatus.RUNNING, true)).toEqual({ kind: 'steer' });
  });

  it.each([AgentStatus.COMPLETED, AgentStatus.FAILED, AgentStatus.STOPPED])(
    '%s + message -> resume',
    (status) => {
      expect(decideTeamMessageRoute(status, true)).toEqual({ kind: 'resume' });
    },
  );

  it('pending -> not-started regardless of message (nothing to resume yet)', () => {
    expect(decideTeamMessageRoute(AgentStatus.PENDING, true)).toEqual({ kind: 'not-started' });
    expect(decideTeamMessageRoute(AgentStatus.PENDING, false)).toEqual({ kind: 'not-started' });
  });

  it.each([AgentStatus.RUNNING, AgentStatus.COMPLETED, AgentStatus.FAILED, AgentStatus.STOPPED])(
    '%s + no message -> need-message',
    (status) => {
      expect(decideTeamMessageRoute(status, false)).toEqual({ kind: 'need-message' });
    },
  );
});
