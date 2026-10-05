// Tests for the hook-manifest check, using the real main-branch-guard failure: a manifest entry
// outside <root>/hooks/ resolves to null and is silently dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const parseHookManifest = vi.fn();
const resolveHookScriptPath = vi.fn();

vi.mock('../../hooks/install.js', () => ({
  parseHookManifest: (...a: unknown[]) => parseHookManifest(...a),
  resolveHookScriptPath: (...a: unknown[]) => resolveHookScriptPath(...a),
}));

const { hookManifestCheck } = await import('./hook-manifest.js');

const ctx = { dryRun: false, mode: 'safe' } as never;

beforeEach(() => {
  parseHookManifest.mockReset();
  resolveHookScriptPath.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('hook-manifest check', () => {
  it('flags the real main-branch-guard failure: a script outside hooks/ resolving to null', async () => {
    parseHookManifest.mockReturnValue({
      'git-guard': { script: 'pre-tool-use/git-guard.sh' },
      'main-branch-guard': {
        script: 'rules/subrules/truly-agentic-git-workflow/main-branch-guard.sh',
      },
    });
    resolveHookScriptPath.mockImplementation((s: string) =>
      s.startsWith('pre-tool-use/') ? '/abs/hooks/' + s : null
    );

    const r = await hookManifestCheck.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.needsAttention).toHaveLength(1);
    expect(r.needsAttention[0]).toContain('main-branch-guard');
    expect(r.needsAttention[0]).toContain('silently never installed');
    expect(r.fixed).toEqual([]);
  });

  it('stays silent when every manifest script resolves', async () => {
    parseHookManifest.mockReturnValue({
      'git-guard': { script: 'pre-tool-use/git-guard.sh' },
      'rm-guard': { script: 'pre-tool-use/rm-guard.sh' },
    });
    resolveHookScriptPath.mockReturnValue('/abs/hooks/pre-tool-use/x.sh');

    const r = await hookManifestCheck.run(ctx);
    expect(r.ok).toBe(true);
    expect(r.needsAttention).toEqual([]);
  });

  it('ignores absolute scripts — subrule-composed hooks bypass the hooks/ resolver', async () => {
    parseHookManifest.mockReturnValue({
      'subrule-hook': { script: '/Users/x/.agents/rules/subrules/a/hook.sh' },
    });
    resolveHookScriptPath.mockReturnValue(null);

    const r = await hookManifestCheck.run(ctx);
    expect(r.ok).toBe(true);
    expect(resolveHookScriptPath).not.toHaveBeenCalled();
  });

  it('ignores explicitly disabled hooks', async () => {
    parseHookManifest.mockReturnValue({
      off: { script: 'nowhere/ghost.sh', enabled: false },
    });
    resolveHookScriptPath.mockReturnValue(null);

    const r = await hookManifestCheck.run(ctx);
    expect(r.ok).toBe(true);
  });

  it('reports rather than throws when the manifest cannot be read', async () => {
    parseHookManifest.mockImplementation(() => {
      throw new Error('bad yaml at line 3');
    });

    const r = await hookManifestCheck.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.needsAttention[0]).toContain('bad yaml at line 3');
  });
});
