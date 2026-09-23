import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { collectAgentsJson, computeAgentRunReady } from './view.js';
import { collectRunCandidates } from '../lib/accounting/rotate.js';
import { viewAgentAccountEligibility } from '../lib/hosts/ready.js';
import { writeClaudeUsageCache, type UsageSnapshot } from '../lib/accounting/usage.js';
import { getVersionsDir } from '../lib/state.js';
import { invalidateInstalledVersionsCache, getVersionHomePath } from '../lib/installations/versions.js';

// The one readiness gate, end to end (PHNX-4116). The 2026-09-23 incident:
// `agents run claude --device auto` refused all 8 workers with "no ready harness
// account" while every worker held a valid setup-token — because the dispatcher
// re-derived a 40-min usage-freshness refusal from the per-version list, which a
// synced-only worker could never satisfy. The fix moves the verdict onto the box
// that runs (`runReady` on `agents view --json`) and has the dispatcher READ it.
// These plant a real signed-in claude home and exercise the actual seam:
// collectRunCandidates → readinessFromCandidate → computeAgentRunReady → JSON →
// viewAgentAccountEligibility. No mocks of own modules.
describe.skipIf(process.platform === 'darwin')('agents view --json runReady — one readiness gate (PHNX-4116)', () => {
  const planted: string[] = [];

  function plantSignedInClaude(version: string) {
    const dir = path.join(getVersionsDir(), 'claude', version);
    planted.push(dir);
    const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `agents-claude-${version}`, private: true }));
    fs.writeFileSync(
      path.join(pkgRoot, 'package.json'),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version, bin: { claude: 'bin/claude-launcher' } }),
    );
    fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'claude'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(pkgRoot, 'bin', 'claude-launcher'), 'REAL BINARY');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: `${version}@example.com`,
          accountUuid: `acct-${version}`,
          organizationUuid: `org-${version}`,
          organizationType: 'claude_max',
        },
      }),
    );
    // The durable worker credential — a present per-version token is what makes
    // the home launchable (isLaunchableSignedIn over credentialPresence).
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 } }),
    );
    return home;
  }

  afterEach(() => {
    for (const dir of planted) fs.rmSync(dir, { recursive: true, force: true });
    planted.length = 0;
    invalidateInstalledVersionsCache('claude');
  });

  it('a signed-in worker with only a 5-day-old SYNCED usage row is runReady, and the dispatcher reads it as signed-in', async () => {
    plantSignedInClaude('2.1.219');
    invalidateInstalledVersionsCache('claude');

    // Seed the exact 5-day-old, source:'sync' row the incident box held — keyed
    // by the candidate's own usageKey so it is genuinely consumed, not ignored.
    const cands = await collectRunCandidates('claude');
    const key = cands.find((c) => c.usageKey)?.usageKey;
    expect(key).toBeTruthy();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 3600 * 1000);
    const synced: UsageSnapshot = {
      source: 'last_seen',
      sourceLabel: 'synced from poller',
      capturedAt: fiveDaysAgo,
      // No resetsAt / windowMinutes so the read-side freshness gate keeps the
      // window (a rolled-over window would be dropped and the row read blind).
      windows: [{ key: 'week', label: 'Weekly', shortLabel: 'W', usedPercent: 40, resetsAt: null, windowMinutes: null }],
      freshness: { source: 'sync', poller: 'zion' },
    };
    writeClaudeUsageCache(key!, synced);

    // computeAgentRunReady runs the router's own enumeration.
    const runReady = await computeAgentRunReady('claude');
    expect(runReady?.ready).toBe(true);
    // reason names a ready account.
    expect(runReady?.reason).toContain('2.1.219@example.com');
    expect(runReady?.accounts.some((a) => a.ready && a.reason === 'ready')).toBe(true);

    // And it rides `agents view --json`.
    const agents = await collectAgentsJson('claude');
    const claude = agents.find((a) => a.agent === 'claude');
    expect(claude?.runReady?.ready).toBe(true);

    // Feed that EXACT JSON to the dispatcher's gate → signed-in, placeable.
    const json = JSON.stringify(agents);
    expect(viewAgentAccountEligibility(json, 'claude')).toEqual({ signedIn: true, pickerEligible: true });
  });

  it('a signed-OUT home is not runReady but stays picker-eligible, and names the reason', async () => {
    const home = plantSignedInClaude('2.1.187');
    // Remove the credential so the home is signed-out (inherits nothing here).
    fs.rmSync(path.join(home, '.claude', '.credentials.json'), { force: true });
    fs.rmSync(path.join(home, '.claude.json'), { force: true });
    invalidateInstalledVersionsCache('claude');

    const runReady = await computeAgentRunReady('claude');
    expect(runReady?.ready).toBe(false);
    expect(runReady?.reason).toContain('signed_out');
    expect(runReady?.accounts.every((a) => !a.ready)).toBe(true);

    const json = JSON.stringify(await collectAgentsJson('claude'));
    expect(viewAgentAccountEligibility(json, 'claude')).toEqual({
      signedIn: false,
      pickerEligible: true,
      reason: runReady?.reason,
    });
  });
});
