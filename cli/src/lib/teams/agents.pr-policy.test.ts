import { describe, it, expect } from 'vitest';
import { AgentManager, withTeammatePrPolicy } from './agents.js';
import { cloudDispatchOptions } from '../../commands/teams.js';

function argv(opts: {
  agentType?: string;
  prompt?: string;
  mode?: string;
  resume?: { id: string; message: string };
}): string[] {
  const mgr = new AgentManager() as any;
  return mgr.buildRunArgv(
    opts.agentType ?? 'claude',
    opts.prompt ?? 'the original brief',
    opts.mode ?? 'edit',
    null,
    'medium',
    null,
    null,
    opts.resume,
  );
}

const promptOf = (a: string[]): string => a[2];

describe('buildRunArgv — teammate self-merge policy (PHNX-3236)', () => {
  it('appends the no-self-merge policy to a fresh write-capable teammate', () => {
    const p = promptOf(argv({ mode: 'edit', prompt: 'ship the fix' }));
    expect(p).toContain('do NOT merge your OWN PR');
    expect(p).toContain('NON-AUTHOR review verdict');
    expect(p).toContain('merge-guard');
    expect(p).toContain('ship the fix');
    expect(p).toContain('provide a brief summary');
  });

  it('appends the policy to a resumed teammate too (the incident recurred on resume)', () => {
    const p = promptOf(argv({ mode: 'edit', resume: { id: 's1', message: 'keep going' } }));
    expect(p.startsWith('keep going')).toBe(true);
    expect(p).toContain('do NOT merge your OWN PR');
  });

  it('is applied in auto and skip modes as well — any write mode can open a PR', () => {
    for (const mode of ['auto', 'skip']) {
      expect(promptOf(argv({ mode }))).toContain('do NOT merge your OWN PR');
    }
  });

  it('is harness-independent — a codex teammate gets the same policy', () => {
    expect(promptOf(argv({ agentType: 'codex', mode: 'edit' }))).toContain('do NOT merge your OWN PR');
  });

  it('is NOT injected into a read-only plan-mode teammate (it opens no PR)', () => {
    const claudePlan = promptOf(argv({ agentType: 'claude', mode: 'plan', prompt: 'design it' }));
    expect(claudePlan).not.toContain('do NOT merge your OWN PR');
    expect(claudePlan).toContain('HEADLESS PLAN MODE');
    const codexPlan = promptOf(argv({ agentType: 'codex', mode: 'plan' }));
    expect(codexPlan).not.toContain('do NOT merge your OWN PR');
  });
});

describe('withTeammatePrPolicy helper (PHNX-3236)', () => {
  it('appends the policy for write modes and skips plan', () => {
    for (const mode of ['edit', 'auto', 'skip']) {
      expect(withTeammatePrPolicy('brief', mode)).toContain('do NOT merge your OWN PR');
    }
    expect(withTeammatePrPolicy('brief', 'plan')).toBe('brief');
  });
});

describe('cloudDispatchOptions — teammate self-merge policy on the cloud path', () => {
  const base = { prompt: 'ship the fix', agentType: 'claude' as const, cloudRepo: 'o/r', cloudBranch: 'b', model: null };
  it('a write-capable cloud teammate carries the policy in its dispatched prompt', () => {
    const opts = cloudDispatchOptions({ ...base, mode: 'edit' });
    expect(opts.prompt).toContain('do NOT merge your OWN PR');
    expect(opts.prompt).toContain('ship the fix');
  });
  it('a plan-mode cloud teammate does not', () => {
    const opts = cloudDispatchOptions({ ...base, mode: 'plan' });
    expect(opts.prompt).not.toContain('do NOT merge your OWN PR');
  });
});
