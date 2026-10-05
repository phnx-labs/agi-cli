import { describe, it, expect } from 'vitest';
import type { AgentId } from '../types.js';
import { compareVersions } from './primitives.js';
import { AgentSpecError, type VersionProvider } from './types.js';
import { resolveAgentTargets, resolveSingleAgentTarget, resolveVersionFilter, resolveListFilter } from './resolve.js';

function providerOf(state: {
  installed?: Partial<Record<string, string[]>>;
  project?: Partial<Record<string, string>>;
  global?: Partial<Record<string, string>>;
  isolated?: Partial<Record<string, string>>;
}): VersionProvider {
  const installed = state.installed ?? {};
  return {
    listInstalled: (a) => (installed[a] ?? []).slice().sort(compareVersions),
    getProjectVersion: (a) => state.project?.[a] ?? null,
    getGlobalDefault: (a) => state.global?.[a] ?? null,
    getIsolatedDefault: (a) => state.isolated?.[a] ?? null,
    isInstalled: (a, v) => (installed[a] ?? []).includes(v),
  };
}

const CLAUDE = 'claude' as AgentId;

describe('isolated default', () => {
  // An isolated-only agent never has a global default (that is what --isolated guarantees), so the
  // chain must continue or `--agents codex` throws after an explicit `agents use`. resolveVersion
  // did this; the two resolvers had drifted.
  it('bare resolves to the isolated default when there is no global one', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, isolated: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude', p)).toEqual({ agent: CLAUDE, version: '2.1.0', source: 'isolated-default' });
  });

  it('a global default still wins — the isolated one is only a fallback', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, global: { claude: '2.1.1' }, isolated: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude', p).version).toBe('2.1.1');
  });

  it('a project pin still wins over both', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, project: { claude: '2.1.1' }, isolated: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude', p).source).toBe('project-pin');
  });

  it('@default and @pinned reach it too, and report it as isolated', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] }, isolated: { claude: '2.1.0' } });
    for (const spec of ['claude@default', 'claude@pinned']) {
      expect(resolveSingleAgentTarget(spec, p)).toEqual({ agent: CLAUDE, version: '2.1.0', source: 'isolated-default' });
    }
  });

  it('ambiguity is resolved by the isolated default rather than throwing', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, isolated: { claude: '2.1.1' } });
    expect(() => resolveSingleAgentTarget('claude', p)).not.toThrow();
  });
});

describe('bare resolution chain', () => {
  it('project pin wins over global default', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, project: { claude: '2.1.1' }, global: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude', p)).toEqual({ agent: CLAUDE, version: '2.1.1', source: 'project-pin' });
  });

  it('falls to global default when no project pin', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, global: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude', p).source).toBe('global-default');
  });

  it('falls to the sole installed version when no pin/default', () => {
    const p = providerOf({ installed: { claude: ['2.1.5'] } });
    expect(resolveSingleAgentTarget('claude', p)).toEqual({ agent: CLAUDE, version: '2.1.5', source: 'sole-installed' });
  });

  it('throws no-default on ambiguity by default (onAmbiguous:error)', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] } });
    try {
      resolveSingleAgentTarget('claude', p);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AgentSpecError);
      expect((e as AgentSpecError).code).toBe('no-default');
      expect((e as AgentSpecError).installed).toEqual(['2.1.0', '2.1.1']);
    }
  });

  it('picks newest-installed on ambiguity when onAmbiguous:newest (run/exec)', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] } });
    expect(resolveSingleAgentTarget('claude', p, { onAmbiguous: 'newest' })).toEqual({ agent: CLAUDE, version: '2.1.1', source: 'newest-installed' });
  });

  it('returns version:null / none when nothing is installed', () => {
    const p = providerOf({ installed: { claude: [] } });
    expect(resolveAgentTargets('claude', p)).toEqual([{ agent: CLAUDE, version: null, source: 'none' }]);
    expect(() => resolveSingleAgentTarget('claude', p)).toThrow(AgentSpecError);
  });
});

describe('qualifiers', () => {
  it('@latest / @oldest pick ends of the numeric range', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.10', '2.1.2'] } });
    expect(resolveSingleAgentTarget('claude@latest', p)).toMatchObject({ version: '2.1.10', source: 'alias-latest' });
    expect(resolveSingleAgentTarget('claude@oldest', p)).toMatchObject({ version: '2.1.0', source: 'alias-oldest' });
  });

  it('@latest / @oldest honor OpenClaw date + -N ordering', () => {
    const p = providerOf({ installed: { openclaw: ['2026.3.8', '2026.5.7', '2026.2.19-2', '2026.2.19-1'] } });
    expect(resolveSingleAgentTarget('openclaw@latest', p).version).toBe('2026.5.7');
    expect(resolveSingleAgentTarget('openclaw@oldest', p).version).toBe('2026.2.19-1');
  });

  it('@pinned and @default are synonyms for the global default', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] }, global: { claude: '2.1.0' } });
    expect(resolveSingleAgentTarget('claude@pinned', p).source).toBe('global-default(@pinned)');
    expect(resolveSingleAgentTarget('claude@default', p).source).toBe('global-default(@pinned)');
  });

  it('@default throws no-default when none is set', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] } });
    expect(() => resolveSingleAgentTarget('claude@default', p)).toThrow(/No default/);
  });

  it('@all expands to every installed version and is rejected by single-target', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] } });
    expect(resolveAgentTargets('claude@all', p).map((t) => t.version)).toEqual(['2.1.0', '2.1.1']);
    try {
      resolveSingleAgentTarget('claude@all', p);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AgentSpecError).code).toBe('multi-not-allowed');
    }
  });

  it('exact installed passes through as explicit', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] } });
    expect(resolveSingleAgentTarget('claude@2.1.0', p)).toEqual({ agent: CLAUDE, version: '2.1.0', source: 'explicit' });
  });

  it('exact not-installed throws with an installed hint', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] } });
    try {
      resolveSingleAgentTarget('claude@9.9.9', p);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AgentSpecError).code).toBe('not-installed');
      expect((e as AgentSpecError).installed).toEqual(['2.1.0']);
    }
  });
});

describe('validation & malformed input', () => {
  it('rejects a traversal version before touching the provider', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] } });
    try {
      resolveSingleAgentTarget('claude@../../etc', p);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AgentSpecError).code).toBe('invalid-version');
    }
  });

  it('rejects empty spec, trailing @, and unknown agent', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'] } });
    expect(() => resolveAgentTargets('', p)).toThrow(/Empty/);
    try { resolveAgentTargets('claude@', p); } catch (e) { expect((e as AgentSpecError).code).toBe('missing-version'); }
    try { resolveAgentTargets('nope', p); } catch (e) { expect((e as AgentSpecError).code).toBe('unknown-agent'); }
  });

  it('resolves comma-separated multi-specs', () => {
    const p = providerOf({ installed: { claude: ['2.1.0'], openclaw: ['2026.5.7'] } });
    const targets = resolveAgentTargets('claude@2.1.0,openclaw@latest', p);
    expect(targets.map((t) => `${t.agent}@${t.version}`)).toEqual(['claude@2.1.0', 'openclaw@2026.5.7']);
  });
});

describe('resolveVersionFilter (read/list commands)', () => {
  const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, global: { claude: '2.1.0' } });

  it('bare / @any → no filter (show all)', () => {
    expect(resolveVersionFilter(CLAUDE, undefined, p)).toEqual({ version: null, source: 'all-versions' });
    expect(resolveVersionFilter(CLAUDE, 'any', p)).toEqual({ version: null, source: 'all-versions' });
  });

  it('@default and @pinned uniformly → the default sentinel', () => {
    expect(resolveVersionFilter(CLAUDE, 'default', p)).toEqual({ version: 'default', source: 'default' });
    expect(resolveVersionFilter(CLAUDE, 'pinned', p)).toEqual({ version: 'default', source: 'default' });
  });

  it('@latest / exact → a concrete version', () => {
    expect(resolveVersionFilter(CLAUDE, 'latest', p).version).toBe('2.1.1');
    expect(resolveVersionFilter(CLAUDE, '2.1.0', p).version).toBe('2.1.0');
  });

  it('a bad exact filter throws', () => {
    expect(() => resolveVersionFilter(CLAUDE, '9.9.9', p)).toThrow(AgentSpecError);
  });
});

describe('resolveListFilter (list commands — concrete version, not the sentinel)', () => {
  it('bare / @any → undefined (show all installed)', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, global: { claude: '2.1.0' } });
    expect(resolveListFilter(CLAUDE, undefined, p)).toBeUndefined();
    expect(resolveListFilter(CLAUDE, 'any', p)).toBeUndefined();
  });

  it('@default / @pinned → the configured default VERSION (the behavior change)', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] }, global: { claude: '2.1.0' } });
    expect(resolveListFilter(CLAUDE, 'default', p)).toBe('2.1.0');
    expect(resolveListFilter(CLAUDE, 'pinned', p)).toBe('2.1.0');
  });

  it('@default with no default set → undefined (falls back to show-all, never errors)', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] } });
    expect(resolveListFilter(CLAUDE, 'default', p)).toBeUndefined();
  });

  it('@latest / exact → a concrete version; bad exact throws', () => {
    const p = providerOf({ installed: { claude: ['2.1.0', '2.1.1'] } });
    expect(resolveListFilter(CLAUDE, 'latest', p)).toBe('2.1.1');
    expect(resolveListFilter(CLAUDE, '2.1.0', p)).toBe('2.1.0');
    expect(() => resolveListFilter(CLAUDE, '9.9.9', p)).toThrow(AgentSpecError);
  });
});
