import { describe, it, expect } from 'vitest';
import { launchIdentityEnv, launchOrigin } from './launch-identity.js';

describe('launchOrigin — only a run a person started in a tab records that tab', () => {
  it('records the tab for a run launched directly from an editor tab', () => {
    expect(launchOrigin(launchIdentityEnv({ AGENT_TERMINAL_ID: 'cl-A' }))?.terminalId).toBe('cl-A');
  });

  it('records no origin for a worker an agent dispatched, so focusing the worker never lands on its orchestrator tab', () => {
    const inherited = { AGENT_TERMINAL_ID: 'cl-A', AGENTS_ORIGIN_TERMINAL_ID: 'cl-A', AGENTS_ORIGIN_DEVICE: 'zion' };
    expect(launchOrigin(launchIdentityEnv({ ...inherited, AGENTS_RUNTIME: 'terminal' }))).toBeUndefined();
    expect(launchOrigin(launchIdentityEnv({ ...inherited, AGENTS_RUNTIME: 'headless' }))).toBeUndefined();
    expect(launchOrigin(launchIdentityEnv({ ...inherited, AGENTS_RUNTIME: 'teams' }))).toBeUndefined();
  });
});
