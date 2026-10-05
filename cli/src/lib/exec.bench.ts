/** Benchmark of the agent-execution hot path: buildExecEnv, buildExecCommand and execAgent, against
 * the real ~/.agents layout and `claude` binary (no mocks). Headline: a logged-in version pays
 * ~150ms scrypt in resolveClaudeSetupToken, cached since RUSH-2317; logged-out ~0.07ms. */
import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildExecEnv, buildExecCommand, execAgent } from './exec.js';
import type { ExecOptions } from './exec.js';
import { resetActorCache } from './actor.js';
import { getUserAgentsDir, getHistoryDir } from './state.js';
import { listInstalledVersions } from './installations/versions.js';

function execOpts(over: Partial<ExecOptions> & { agent: ExecOptions['agent'] }): ExecOptions {
  return { mode: 'plan', effort: 'auto', cwd: process.cwd(), ...over } as ExecOptions;
}

// Discovered from the real version-home layout so the bench runs unmodified on any dev box (or
// degrades when nothing is installed); it is not wired into `vitest run` (vitest.config.ts:9).
const installedClaudeVersions = listInstalledVersions('claude');
const installedCodex = listInstalledVersions('codex').at(-1);

/** Whether a claude version's home has a resolvable oauth account email (claude-account-token.ts:29
 * `readClaudeAccountEmail`'s own check), reading only the plaintext `.claude.json` marker, never a
 * secret, so it is safe as bench setup. */
function hasResolvableAccount(version: string): boolean {
  const home = path.join(getHistoryDir(), 'versions', 'claude', version, 'home');
  for (const p of [path.join(home, '.claude', '.claude.json'), path.join(home, '.claude.json')]) {
    try {
      const email = (JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        oauthAccount?: { emailAddress?: unknown };
      }).oauthAccount?.emailAddress;
      if (typeof email === 'string' && email.trim().length > 0) return true;
    } catch { /* try the next candidate path */ }
  }
  return false;
}

const loggedInClaudeVersion = installedClaudeVersions.find(hasResolvableAccount);
const loggedOutClaudeVersion = installedClaudeVersions.find((v) => !hasResolvableAccount(v));

const metaFile = path.join(getUserAgentsDir(), 'agents.yaml');

/** Force the next buildExecEnv call to pay full cold-start cost: clear the actor cache and bump
 * agents.yaml's mtime so readMeta() misses. vitest's bench `setup` fires once per task, not per
 * sample, so cold benches use `{ iterations: 1 }` to measure a truly cold call. */
function invalidateCaches(_task: unknown, mode: 'warmup' | 'run'): void {
  if (mode !== 'run') return;
  resetActorCache();
  try {
    const now = new Date();
    fs.utimesSync(metaFile, now, now);
  } catch {
    // No ~/.agents/agents.yaml on this box -- readMeta() has nothing cached
    // to invalidate either, so the cold/warm distinction collapses; proceed.
  }
}

/** Bench options for a single, genuinely-cold sample — see invalidateCaches doc. */
const COLD_SAMPLE_OPTS = { setup: invalidateCaches, iterations: 1, time: 1, warmupIterations: 0, warmupTime: 0 } as const;

describe.skipIf(!loggedInClaudeVersion || !loggedOutClaudeVersion)(
  'buildExecEnv — resolveClaudeSetupToken cost split (exec.ts:424, claude-account-token.ts:51): same code path, signed-in vs not',
  () => {
    bench('pinned version WITH a signed-in account (first call decrypts; unchanged calls hit the token cache)', () => {
      buildExecEnv(execOpts({ agent: 'claude', version: loggedInClaudeVersion, sessionId: randomUUID() }));
    });

    bench('pinned version WITHOUT a signed-in account (readClaudeAccountEmail short-circuits, claude-account-token.ts:56)', () => {
      buildExecEnv(execOpts({ agent: 'claude', version: loggedOutClaudeVersion, sessionId: randomUUID() }));
    });
  },
);

describe('buildExecEnv — warm cache (steady state: loop.ts/teams/runner calling it repeatedly in one process)', () => {
  bench('claude, auto-resolved version (resolveVersion + isVersionInstalled + resolveClaudeSetupToken chain)', () => {
    buildExecEnv(execOpts({ agent: 'claude', sessionId: randomUUID() }));
  });

  bench('codex, explicit pinned version (no claude-account-token path at all)', () => {
    buildExecEnv(execOpts({ agent: 'codex', version: installedCodex ?? '0.146.0', sessionId: randomUUID() }));
  });

  bench('codex, auto-resolved version', () => {
    buildExecEnv(execOpts({ agent: 'codex', sessionId: randomUUID() }));
  });
});

describe('buildExecEnv — cold cache (single sample: the first call in a fresh `agents run` process)', () => {
  bench('claude, auto-resolved version', () => {
    buildExecEnv(execOpts({ agent: 'claude', sessionId: randomUUID() }));
  }, COLD_SAMPLE_OPTS);

  bench.skipIf(!loggedOutClaudeVersion)('claude, pinned version WITHOUT a signed-in account (isolates readMeta+actor cold cost from the scrypt cost above)', () => {
    buildExecEnv(execOpts({ agent: 'claude', version: loggedOutClaudeVersion, sessionId: randomUUID() }));
  }, COLD_SAMPLE_OPTS);
});

describe('buildExecCommand — argv assembly (runs immediately before spawn in spawnAgent, exec.ts:1745)', () => {
  bench('claude headless, explicit pinned version', () => {
    buildExecCommand(execOpts({
      agent: 'claude', version: loggedOutClaudeVersion ?? installedClaudeVersions.at(-1) ?? '2.1.221', prompt: 'benchmark prompt', sessionId: randomUUID(),
    }));
  });

  bench('claude headless, auto-resolved version + model tier (re-walks resolveVersion a second time, exec.ts:972)', () => {
    buildExecCommand(execOpts({
      agent: 'claude', prompt: 'benchmark prompt', model: 'sonnet', sessionId: randomUUID(),
    }));
  });
});

describe.skipIf(!loggedOutClaudeVersion)('execAgent — real subprocess spawn (real claude binary; --version passthrough keeps it network-free)', () => {
  bench('claude headless spawn, pinned version without a signed-in account (isolates spawn overhead from the scrypt cost above)', async () => {
    await execAgent(execOpts({
      agent: 'claude',
      version: loggedOutClaudeVersion,
      prompt: 'benchmark prompt',
      passthroughArgs: ['--version'],
    }));
  }, { time: 3000, iterations: 15 });
});
