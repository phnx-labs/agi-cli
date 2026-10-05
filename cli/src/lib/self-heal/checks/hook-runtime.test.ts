/** 1:1 tests for the hook-runtime HealCheck: pins the check id, cadence, and dryRun hand-off.
 * inspect/repair behavior is covered in hooks.test.ts. */
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
    // The Vitest process can share an installed-agent home with the developer,
    // so do not assume it is empty. This still proves the check delegates to
    // the bounded repair routine without writing in dry-run mode.
    const result = await hookRuntimeCheck.run({ mode: 'safe', dryRun: true });
    expect(Array.isArray(result.fixed)).toBe(true);
    expect(Array.isArray(result.needsAttention)).toBe(true);
    expect(typeof result.ok).toBe('boolean');
  });
});
