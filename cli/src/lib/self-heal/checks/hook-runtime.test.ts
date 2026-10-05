import { describe, expect, it } from 'vitest';
import { hookRuntimeCheck } from './hook-runtime.js';
import { HEAL_CHECKS } from '../registry.js';

describe('hookRuntimeCheck', () => {
  it('is registered once with a stable id and frequent cadence', () => {
    expect(hookRuntimeCheck.id).toBe('hook-runtime');
    expect(hookRuntimeCheck.cadence).toBe('frequent');
    expect(HEAL_CHECKS.filter((c) => c.id === 'hook-runtime')).toHaveLength(1);
  });

  it('returns a standard check result in dry-run mode', async () => {
    const result = await hookRuntimeCheck.run({ mode: 'safe', dryRun: true });
    expect(Array.isArray(result.fixed)).toBe(true);
    expect(Array.isArray(result.needsAttention)).toBe(true);
    expect(typeof result.ok).toBe('boolean');
  });
});
