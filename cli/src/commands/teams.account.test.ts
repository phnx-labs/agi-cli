import { describe, expect, it } from 'vitest';
import { parseTeammate } from './teams.js';

describe('teammate account selectors', () => {
  it('uses the shared harness/account/release parser', () => {
    expect(parseTeammate('codex#second')).toMatchObject({ agent: 'codex', account: 'second', version: null });
    expect(parseTeammate('codex@1.2.3#second')).toMatchObject({ agent: 'codex', account: 'second', version: '1.2.3' });
    expect(parseTeammate('codex#person@example.test')).toMatchObject({ agent: 'codex', account: 'person@example.test' });
  });

  it('leaves a release alias unresolved so the execution host resolves it', () => {
    expect(parseTeammate('codex@latest')).toMatchObject({ agent: 'codex', version: 'latest', account: null });
  });
});
