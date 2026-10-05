import { describe, expect, it } from 'vitest';
import { collectLocalFleetInventory, collectLocalFleetSignIn } from './fleet-inventory.js';
import { listInstalledVersions } from '../installations/versions.js';
import { ALL_AGENT_IDS } from '../agents.js';

// Real-path: exercise the live install, no mocking. The invariants hold for whatever versions the
// dev machine has installed, so the test is deterministic without a fixture home.
describe('collectLocalFleetInventory populates signIn (RUSH-2069)', () => {
  it('emits a signIn entry for every agent that has installed versions, one row per version', async () => {
    const inv = await collectLocalFleetInventory(process.cwd());
    expect(inv.signIn).toBeDefined();
    const signIn = inv.signIn!;

    for (const agent of ALL_AGENT_IDS) {
      const versions = listInstalledVersions(agent);
      if (versions.length === 0) {
        // No versions → no signIn key (keeps the map aligned with agentVersions).
        expect(signIn[agent]).toBeUndefined();
        continue;
      }
      const rows = signIn[agent];
      expect(rows, `signIn should carry ${agent}`).toBeDefined();
      // One row per installed version, versions line up.
      expect(rows.map((r) => r.version).sort()).toEqual([...versions].sort());
      for (const row of rows) {
        expect(typeof row.signedIn).toBe('boolean');
        expect(typeof row.provable).toBe('boolean');
        // A signed-in version is never a provable logout.
        if (row.signedIn) expect(row.provable).toBe(false);
      }
    }
  });

  it('collectLocalFleetSignIn returns the same per-version shape standalone', async () => {
    const signIn = await collectLocalFleetSignIn();
    for (const [agent, rows] of Object.entries(signIn)) {
      const versions = listInstalledVersions(agent as any);
      expect(rows.length).toBe(versions.length);
    }
  });

  it('emits one closed hook-runtime state for every installed version', async () => {
    const inv = await collectLocalFleetInventory(process.cwd());
    expect(inv.hookRuntime).toBeDefined();
    const allowed = new Set(['healthy', 'broken', 'not-applicable']);

    for (const [agent, versions] of Object.entries(inv.agentVersions)) {
      const states = inv.hookRuntime![agent];
      expect(states, `hookRuntime should carry ${agent}`).toBeDefined();
      expect(Object.keys(states).sort()).toEqual([...versions].sort());
      for (const state of Object.values(states)) {
        expect(allowed.has(state)).toBe(true);
      }
    }
  });
});
