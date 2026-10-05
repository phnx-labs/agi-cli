import { describe, expect, it } from 'vitest';
import { AGENT_CLI_COMMANDS } from './agent-cli-commands.js';
import { AGENTS, ALL_AGENT_IDS } from './agents.js';

describe('AGENT_CLI_COMMANDS', () => {
  it('matches every AGENTS[*].cliCommand exactly (set equality)', () => {
    const fromAgents = new Set(ALL_AGENT_IDS.map((id) => AGENTS[id].cliCommand));
    const fromLeaf = new Set(AGENT_CLI_COMMANDS);
    expect(fromLeaf).toEqual(fromAgents);
  });

  it('has no duplicates', () => {
    expect(new Set(AGENT_CLI_COMMANDS).size).toBe(AGENT_CLI_COMMANDS.length);
  });

  it('does not reserve the agents / ag binaries (those are added by brand.ts)', () => {
    expect(AGENT_CLI_COMMANDS).not.toContain('agents');
    expect(AGENT_CLI_COMMANDS).not.toContain('ag');
  });
});
