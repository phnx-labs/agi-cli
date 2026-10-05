import { describe, it, expect } from 'vitest';
import {
  runCloudConflicts,
  cloudFlagsWithoutCloud,
  cloudCapableAgentIds,
  resolveRunCloudProvider,
  resolveRunCloudAgent,
  RunCloudError,
} from './run-cloud.js';

describe('cloudCapableAgentIds', () => {
  it('is exactly the agents with a native cloudProvider in the registry', () => {
    expect(cloudCapableAgentIds()).toEqual(['antigravity', 'claude', 'codex', 'cursor', 'droid']);
  });
});

describe('resolveRunCloudProvider', () => {
  it('routes each capable agent to its native cloud', () => {
    expect(resolveRunCloudProvider('claude').id).toBe('rush');
    expect(resolveRunCloudProvider('codex').id).toBe('codex');
    expect(resolveRunCloudProvider('droid').id).toBe('factory');
    expect(resolveRunCloudProvider('antigravity').id).toBe('antigravity');
    expect(resolveRunCloudProvider('cursor').id).toBe('cursor');
  });

  it('fails loud for agents with no native cloud, naming the capable set', () => {
    for (const agent of ['kimi', 'grok', 'opencode']) {
      expect(() => resolveRunCloudProvider(agent)).toThrow(RunCloudError);
      expect(() => resolveRunCloudProvider(agent)).toThrow(/has no native cloud/);
      expect(() => resolveRunCloudProvider(agent)).toThrow(/claude/);
    }
  });

  it('lets an explicit --provider override the missing native cloud', () => {
    expect(resolveRunCloudProvider('kimi', 'rush').id).toBe('rush');
  });

  it('lets an explicit --provider override the native routing', () => {
    expect(resolveRunCloudProvider('claude', 'codex').id).toBe('codex');
  });
});

describe('resolveRunCloudAgent', () => {
  it('rejects the auto harness-pick keyword', () => {
    expect(() => resolveRunCloudAgent('auto')).toThrow(/auto harness-pick is a local-run feature/);
    expect(() => resolveRunCloudAgent('auto@2.0')).toThrow(RunCloudError);
  });

  it('rejects version pins — the provider runs its own version', () => {
    expect(() => resolveRunCloudAgent('claude@2.1.0')).toThrow(/Version pins.*do not apply to --cloud/);
  });

  it('rejects unknown agents with the capable list', () => {
    expect(() => resolveRunCloudAgent('not-an-agent')).toThrow(/Unknown agent: not-an-agent/);
  });

  it('resolves registry ids for real agents', () => {
    expect(resolveRunCloudAgent('claude')).toBe('claude');
    expect(resolveRunCloudAgent('codex')).toBe('codex');
  });
});

describe('runCloudConflicts', () => {
  it('is empty for a plain cloud run', () => {
    expect(runCloudConflicts({ cloud: true, timeout: '30m', model: 'best', json: true })).toEqual([]);
  });

  it('flags local-run knobs that cannot ride a cloud dispatch', () => {
    expect(runCloudConflicts({ terminal: true })).toContain('--terminal');
    expect(runCloudConflicts({ interactive: true })).toContain('--interactive');
    expect(runCloudConflicts({ acp: true })).toContain('--acp');
    expect(runCloudConflicts({ loop: true })).toContain('--loop');
    expect(runCloudConflicts({ maxIterations: '5' })).toContain('--max-iterations');
    expect(runCloudConflicts({ budget: '100k' })).toContain('--budget');
    expect(runCloudConflicts({ resume: 'abc123' })).toContain('--resume');
    expect(runCloudConflicts({ sessionId: 'uuid' })).toContain('--session-id');
    expect(runCloudConflicts({ secrets: ['prod'] })).toContain('--secrets');
    expect(runCloudConflicts({ copyCreds: true })).toContain('--copy-creds');
    expect(runCloudConflicts({ fallback: 'codex' })).toContain('--fallback');
    expect(runCloudConflicts({ strategy: 'balanced' })).toContain('--strategy');
    expect(runCloudConflicts({ balanced: true })).toContain('--balanced');
    expect(runCloudConflicts({ cwd: '/tmp/x' })).toContain('--cwd');
    expect(runCloudConflicts({ env: ['A=B'] })).toContain('--env');
    expect(runCloudConflicts({ notify: true })).toContain('--notify');
    expect(runCloudConflicts({ name: 'nightly' })).toContain('--name');
  });

  it('flags an explicit non-default --effort (no provider consumes it)', () => {
    expect(runCloudConflicts({ effort: 'xhigh' })).toContain('--effort');
    expect(runCloudConflicts({ effort: 'auto' })).toEqual([]);
    expect(runCloudConflicts({})).toEqual([]);
  });

  it('does not flag unset or empty-valued options', () => {
    expect(runCloudConflicts({ secrets: [], env: [], addDir: [], terminal: false, resume: false })).toEqual([]);
  });

  it('reports every conflict at once, not just the first', () => {
    const conflicts = runCloudConflicts({ loop: true, resume: 'x', secrets: ['prod'] });
    expect(conflicts).toEqual(['--loop', '--resume', '--secrets']);
  });
});

describe('cloudFlagsWithoutCloud', () => {
  it('flags cloud refinement flags passed without --cloud', () => {
    expect(cloudFlagsWithoutCloud({ provider: 'rush' })).toEqual(['--provider']);
    expect(cloudFlagsWithoutCloud({ repo: ['a/b'], branch: 'main', cloudEnv: 'env_1' }))
      .toEqual(['--repo', '--branch', '--cloud-env']);
  });

  it('is empty when nothing cloud-specific was passed', () => {
    expect(cloudFlagsWithoutCloud({ repo: [], timeout: '30m' })).toEqual([]);
  });
});
