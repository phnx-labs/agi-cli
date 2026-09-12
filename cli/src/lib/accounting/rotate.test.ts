import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rotationFailoverChain,
  shouldArmRotationFailover,
  DEFAULT_ROTATION_FAILOVER_LIMIT,
  pickBalancedCandidate,
  pickAvailableCandidate,
  pickHarnessWeighted,
  classifyHarnessCandidates,
  formatHarnessPickBanner,
  formatNoHealthyAccountError,
  formatNoHealthyHarnessError,
  formatNoVerifiedUsageError,
  hasStaleUsage,
  earliestResetAcross,
  readinessFromCandidate,
  isSignInRecoverable,
  signInRecoverableCandidates,
  matchAccountVersion,
  matchAccountCandidate,
  candidateAccountKey,
  isUsageVerified,
  buildRotationDecisionEvent,
  isLaunchableSignedIn,
  isVersionLaunchableHere,
  capacityWeight,
  PROJECTION_HORIZON_MIN,
  resolveRunVersion,
  type RotateCandidate,
  type RotateResult,
  type FailoverArmingContext,
} from './rotate.js';
import { emit, _resetForTest } from '../feed/events.js';
import { getVersionsDir } from '../state.js';
import { invalidateInstalledVersionsCache, getVersionHomePath } from '../installations/versions.js';
import { runWithFallback } from '../exec.js';
import type { AgentId } from '../types.js';
import {
  deriveUsageStatusFromSnapshot,
  mergeClaudeUsageCacheWindows,
  noteClaudeSessionLimit,
  noteClaudeModelRefusal,
  claudeModelRefusalKey,
  readClaudeUsageCache,
  setClaudeUsageCachePathForTest,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowKey,
} from './usage.js';

/**
 * Build a healthy RotateCandidate (signed in, no live snapshot
 * => unverified, drawing the low UNVERIFIED_WEIGHT — never full capacity,
 * PHNX-3392). Pass overrides — e.g. `usageStatus:
 * 'rate_limited'` — to make it unhealthy.
 */
function candidate(over: Partial<RotateCandidate> & { version: string }): RotateCandidate {
  return {
    agent: 'claude',
    accountKey: `claude:account=${over.version}`,
    accountLabel: `${over.version}@example.com`,
    email: `${over.version}@example.com`,
    usageKey: `claude:org=${over.version}`,
    usageStatus: 'available',
    usageSnapshot: null,
    usageError: null,
    usageMinutesToLimit: null,
    plan: 'Max',
    signedIn: true,
    authVerdict: null,
    lastActive: null,
    ...over,
  };
}

/** A RotateResult with `healthy` in the given order and `picked` = healthy[pickedIdx]. */
function rotation(healthy: RotateCandidate[], pickedIdx = 0): RotateResult {
  return { picked: healthy[pickedIdx], healthy, excluded: [] };
}

describe('slot verdict eligibility (PHNX-3940 T5)', () => {
  it('balanced excludes a missing/expired/revoked slot even when signedIn looks true', () => {
    const live = candidate({ version: 'main', nativeAccount: 'work', fromSlot: true, authVerdict: 'live' });
    const expired = candidate({ version: 'main', nativeAccount: 'old', fromSlot: true, authVerdict: 'expired', signedIn: true });
    const revoked = candidate({ version: 'main', nativeAccount: 'dead', fromSlot: true, authVerdict: 'revoked', signedIn: true });
    const missing = candidate({ version: 'main', nativeAccount: 'gone', fromSlot: true, authVerdict: 'unconfigured', signedIn: true });
    const result = pickBalancedCandidate([live, expired, revoked, missing]);
    expect(result?.picked.nativeAccount).toBe('work');
    expect(result?.excluded.map((c) => c.nativeAccount).sort()).toEqual(['dead', 'gone', 'old']);
  });

  it('available also refuses verdicts outside live/unverified', () => {
    const unverified = candidate({ version: 'main', nativeAccount: 'tok', fromSlot: true, authVerdict: 'unverified' });
    const expired = candidate({ version: 'main', nativeAccount: 'old', fromSlot: true, authVerdict: 'expired' });
    const result = pickAvailableCandidate([unverified, expired]);
    expect(result?.picked.nativeAccount).toBe('tok');
    expect(result?.excluded.map((c) => c.nativeAccount)).toEqual(['old']);
  });
});

describe('isLaunchableSignedIn (per-version credential floor for rotation)', () => {
  // getAccountInfo falls back to the active HOME credential so `agents view`
  // still labels empty version homes. Rotation must NOT treat that as launchable —
  // GROK_HOME (and peers) isolate to the version home, so spawn dies "Not signed in".
  it('rejects a signedIn signal when the known credential is only on the active home', () => {
    expect(
      isLaunchableSignedIn(true, { knownLocation: true, perVersion: false }),
    ).toBe(false);
  });

  it('accepts a signedIn signal when the credential lives in this version home', () => {
    expect(
      isLaunchableSignedIn(true, { knownLocation: true, perVersion: true }),
    ).toBe(true);
  });

  it('rejects when not signed in, regardless of credential presence', () => {
    expect(
      isLaunchableSignedIn(false, { knownLocation: true, perVersion: true }),
    ).toBe(false);
    expect(
      isLaunchableSignedIn(false, { knownLocation: true, perVersion: false }),
    ).toBe(false);
  });

  it('trusts signedIn when we do not know where the credential lives', () => {
    // keychain-only / unmapped agents — no file path to require
    expect(
      isLaunchableSignedIn(true, { knownLocation: false, perVersion: false }),
    ).toBe(true);
  });
});

describe('isVersionLaunchableHere (per-version signed-in probe for the run.launch event)', () => {
  // The incident: `--device auto` guarantees SOME account is ready on the box,
  // not that the SPECIFIC version launched is signed in there. A version whose
  // home carries no per-version credential is NOT launchable — this is exactly
  // the gate collectRunCandidates applies, surfaced for the pre-launch event.
  it('reports a version with no per-version credential home as NOT launchable, email null', async () => {
    // A version that was never installed has no version home on disk, so
    // getAccountInfo finds no per-version credential and credentialPresence's
    // perVersion is false — launchable is false for claude (a known-location
    // agent) regardless of any active/global login on the test box.
    const state = await isVersionLaunchableHere('claude', '0.0.0-never-installed');
    expect(state.launchable).toBe(false);
    expect(state.email).toBeNull();
  });

  it('returns a well-formed { launchable, email } shape (best-effort, never throws)', async () => {
    const state = await isVersionLaunchableHere('claude', '0.0.0-never-installed');
    expect(typeof state.launchable).toBe('boolean');
    // email is null whenever the version is not launchable-signed-in here.
    expect(state.launchable ? typeof state.email : state.email).toBeDefined();
    if (!state.launchable) expect(state.email).toBeNull();
  });

  // These plant a real version-home fixture under the actual versions dir (the
  // path getVersionHomePath resolves to) so the FULL wiring runs —
  // getVersionHomePath -> getAccountInfo -> credentialPresence -> isLaunchableSignedIn —
  // not just the composition. Each uses a unique version and is removed after.
  describe('against a real installed version home', () => {
    const plantedVersionDirs: string[] = [];
    afterEach(() => {
      for (const d of plantedVersionDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    function plantHome(version: string): string {
      const home = getVersionHomePath('claude', version);
      // The version dir is the parent of `home`; clean the whole thing up.
      plantedVersionDirs.push(path.dirname(home));
      fs.mkdirSync(home, { recursive: true });
      return home;
    }

    it('an installed-but-LOGGED-OUT home (config present, no oauthAccount) is NOT launchable — the yosemite-m3 shape', async () => {
      const version = `0.0.0-loggedout-${Date.now()}`;
      const home = plantHome(version);
      // The home exists (installed) and carries a `.claude.json`, but with no
      // oauthAccount it is signed out — exactly 2.1.219 on yosemite-m3.
      fs.writeFileSync(path.join(home, '.claude.json'), '{}', 'utf-8');
      const state = await isVersionLaunchableHere('claude', version);
      expect(state.launchable).toBe(false);
      expect(state.email).toBeNull();
    });

    it('an installed and SIGNED-IN home (oauthAccount + intact credentials) is launchable, with the email', async () => {
      const version = `0.0.0-signedin-${Date.now()}`;
      const home = plantHome(version);
      fs.writeFileSync(
        path.join(home, '.claude.json'),
        JSON.stringify({ oauthAccount: { accountUuid: 'acc-1', organizationUuid: 'org-1', emailAddress: 'muqsit@example.com', organizationType: 'claude_max' } }),
        'utf-8',
      );
      // Off macOS getAccountInfo requires a real credential file (PHNX-2685);
      // plant the token pair so the verdict is signed-in cross-platform.
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 } }),
        'utf-8',
      );
      const state = await isVersionLaunchableHere('claude', version);
      expect(state.launchable).toBe(true);
      expect(state.email).toBe('muqsit@example.com');
    });
  });
});

describe('matchAccountVersion (RUSH-1957 — pin a routine to an account by identity)', () => {
  it('prefers the recorded account home only when that home still has the same connected identity', () => {
    const homes = [
      candidate({ version: 'legacy', accountKey: 'identity-a', signedIn: true }),
      candidate({ version: 'connected-home', accountKey: 'identity-a', signedIn: true }),
      candidate({ version: 'someone-else', accountKey: 'identity-b', signedIn: true }),
    ];
    expect(matchAccountVersion(homes, 'identity-a', 'connected-home')).toBe('connected-home');
    expect(matchAccountVersion(homes, 'identity-a', 'someone-else')).toBe('legacy');
    homes[1].signedIn = false;
    expect(matchAccountVersion(homes, 'identity-a', 'connected-home')).toBe('legacy');
  });
  const gmail = candidate({ version: '2.1.186', email: 'muqsitnawaz@gmail.com' });
  const trp = candidate({ version: '2.1.207', email: 'muqsit@trp.so' });
  const signedOut = candidate({ version: '2.1.180', email: 'stale@example.com', signedIn: false });
  const pool = [gmail, trp, signedOut];

  it('resolves a login email to its installed version slot (case-insensitive)', () => {
    expect(matchAccountVersion(pool, 'muqsit@trp.so')).toBe('2.1.207');
    expect(matchAccountVersion(pool, 'MUQSIT@TRP.SO')).toBe('2.1.207');
    expect(matchAccountVersion(pool, '  muqsitnawaz@gmail.com  ')).toBe('2.1.186');
  });

  it('resolves an account key as well as an email', () => {
    expect(matchAccountVersion(pool, 'claude:account=2.1.207')).toBe('2.1.207');
  });

  it('never returns a signed-out slot even when its identity matches', () => {
    expect(matchAccountVersion(pool, 'stale@example.com')).toBeNull();
  });

  it('returns null for an unknown account or an empty string, so the caller falls back and warns', () => {
    expect(matchAccountVersion(pool, 'nobody@nowhere.dev')).toBeNull();
    expect(matchAccountVersion(pool, '   ')).toBeNull();
    expect(matchAccountVersion([], 'muqsit@trp.so')).toBeNull();
  });

  it('disambiguates two slots that share one managed binary version by nativeAccount name', () => {
    const work = candidate({
      version: 'main',
      nativeAccount: 'work',
      accountKey: 'claude:account=work',
      email: 'work@example.com',
      fromSlot: true,
    });
    const personal = candidate({
      version: 'main',
      nativeAccount: 'personal',
      accountKey: 'claude:account=personal',
      email: 'personal@example.com',
      fromSlot: true,
    });
    const slots = [work, personal];
    expect(matchAccountVersion(slots, 'claude:account=work')).toBe('main');
    expect(matchAccountCandidate(slots, 'work')?.nativeAccount).toBe('work');
    expect(matchAccountCandidate(slots, 'personal')?.nativeAccount).toBe('personal');
    expect(matchAccountCandidate(slots, 'claude:account=personal')?.email).toBe('personal@example.com');
  });
});

describe('rotationFailoverChain (#348 — synthesize a same-agent failover chain)', () => {
  it('turns the other healthy accounts into fallback entries, skipping the picked one', () => {
    const a = candidate({ version: '1.0.0' });
    const b = candidate({ version: '2.0.0' });
    const c = candidate({ version: '3.0.0' });
    // A is the account picked pre-flight; B and C are the healthy alternatives.
    const chain = rotationFailoverChain(rotation([a, b, c], 0), a.version);
    expect(chain).toEqual([
      { agent: 'claude', version: '2.0.0' },
      { agent: 'claude', version: '3.0.0' },
    ]);
  });

  it('preserves rotation.healthy order (freshest account first) and never re-lists the primary', () => {
    const healthy = [
      candidate({ version: '1.0.0' }),
      candidate({ version: '2.0.0' }),
      candidate({ version: '3.0.0' }),
    ];
    // Primary is the middle account; failover keeps the other two in order.
    const chain = rotationFailoverChain(rotation(healthy, 1), '2.0.0');
    expect(chain.map(e => e.version)).toEqual(['1.0.0', '3.0.0']);
    expect(chain.some(e => e.version === '2.0.0')).toBe(false);
  });

  it('bounds the chain to the failover limit', () => {
    const healthy = Array.from({ length: 6 }, (_, i) => candidate({ version: `${i}.0.0` }));
    const chain = rotationFailoverChain(rotation(healthy, 0), '0.0.0');
    expect(chain.length).toBe(DEFAULT_ROTATION_FAILOVER_LIMIT);
    const custom = rotationFailoverChain(rotation(healthy, 0), '0.0.0', 2);
    expect(custom.length).toBe(2);
  });

  it('returns [] for a non-rotation run (pinned strategy => null rotation) — behavior unchanged', () => {
    expect(rotationFailoverChain(null, '1.0.0')).toEqual([]);
  });

  it('returns [] when the picked account is the only healthy one (single-account user)', () => {
    const only = candidate({ version: '1.0.0' });
    expect(rotationFailoverChain(rotation([only], 0), '1.0.0')).toEqual([]);
  });

  it('consumes the healthy set produced by the real pickBalancedCandidate (rate-limited account is never a failover target)', () => {
    const healthyA = candidate({ version: '1.0.0' });
    const healthyB = candidate({ version: '2.0.0' });
    const limited = candidate({ version: '3.0.0', usageStatus: 'rate_limited' });
    const result = pickBalancedCandidate([healthyA, healthyB, limited]);
    expect(result).not.toBeNull();
    const chain = rotationFailoverChain(result, result!.picked.version);
    // Exactly one alternative (the other healthy account); the picked and the
    // already-rate-limited account are both absent.
    expect(chain.length).toBe(1);
    expect(chain[0].version).not.toBe(result!.picked.version);
    expect(chain.some(e => e.version === '3.0.0')).toBe(false);
    expect(['1.0.0', '2.0.0']).toContain(chain[0].version);
  });
});

describe('shouldArmRotationFailover (#348 — arming gate; must not trip --acp/--loop guards)', () => {
  // The eligible baseline: a real rotation picked a version, there is a prompt,
  // and the run is a plain headless prompt run.
  const armable: FailoverArmingContext = {
    hasRotation: true,
    hasVersion: true,
    hasPrompt: true,
    interactive: false,
    acp: false,
    loop: false,
    resumeCheckpoint: false,
  };

  it('arms for a plain headless rotation run with alternatives', () => {
    expect(shouldArmRotationFailover(armable)).toBe(true);
  });

  // The regression this guards: arming injected into `fallback` before the
  // --acp / --loop guards made those runs hard-exit on a flag never passed.
  it('does NOT arm for --acp runs (they reject a non-empty fallback array)', () => {
    expect(shouldArmRotationFailover({ ...armable, acp: true })).toBe(false);
  });

  it('does NOT arm for --loop runs (they reject a non-empty fallback array)', () => {
    expect(shouldArmRotationFailover({ ...armable, loop: true })).toBe(false);
  });

  it('does NOT arm for --resume-checkpoint runs (they take the loop path)', () => {
    expect(shouldArmRotationFailover({ ...armable, resumeCheckpoint: true })).toBe(false);
  });

  it('does NOT arm for interactive or no-prompt runs', () => {
    expect(shouldArmRotationFailover({ ...armable, interactive: true })).toBe(false);
    expect(shouldArmRotationFailover({ ...armable, hasPrompt: false })).toBe(false);
  });

  // An explicit --fallback no longer disarms rotation failover: the same-agent
  // accounts are unshifted ahead of the cross-agent entries (gh-monitor heal
  // bug — `--fallback codex,droid` pinned every run to one capped account).
  // The armable baseline above is the explicit-fallback case too: the gate has
  // no explicitFallback input anymore.

  it('does NOT arm for pinned / non-rotation runs (no rotation or no picked version)', () => {
    expect(shouldArmRotationFailover({ ...armable, hasRotation: false })).toBe(false);
    expect(shouldArmRotationFailover({ ...armable, hasVersion: false })).toBe(false);
  });
});

// End-to-end proof that a synthesized chain actually recovers a 429 through the
// SAME runWithFallback engine: a real child process (no mocking of the code under
// test) 429s on the first ("account A") dispatch and succeeds on the re-dispatch
// ("account B"). A non-rate-limit failure must NOT cascade.
describe('runWithFallback re-dispatch on a mid-run 429 (the reused failover path)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Write a stateful fake `amp` on a temp PATH; returns its bin dir + state file. */
  function fakeAmp(): { binDir: string; stateFile: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-failover-'));
    tmpDirs.push(root);
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const stateFile = path.join(root, 'calls');
    const script = `#!/usr/bin/env node
const fs = require('fs');
const stateFile = process.env.AGENTS_TEST_STATE;
const mode = process.env.AGENTS_TEST_MODE;
let n = 0;
try { n = parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0; } catch {}
n += 1;
fs.writeFileSync(stateFile, String(n));
if (mode === 'plain-fail') {
  process.stderr.write('Error: compile failure — not a limit\\n');
  process.exit(1);
}
if (mode === 'stdout-spend-limit-then-ok') {
  // Claude prints billing refusals to STDOUT, not stderr — the cascade must
  // still detect them (via the SpawnResult stdout tail).
  if (n === 1) {
    process.stdout.write("You've hit your org's monthly spend limit \\u00b7 run /usage-credits to raise it\\n");
    process.exit(1);
  }
  process.stdout.write('done\\n');
  process.exit(0);
}
if (n === 1) {
  process.stderr.write('API request failed: 429 Too Many Requests (rate limit exceeded)\\n');
  process.exit(1);
}
process.stdout.write('done\\n');
process.exit(0);
`;
    const bin = path.join(binDir, 'amp');
    fs.writeFileSync(bin, script);
    fs.chmodSync(bin, 0o755);
    if (process.platform === 'win32') {
      // cmd.exe can't exec a shebang script. spawnAgent goes through the shell
      // on Windows (needsWindowsShell), which resolves `amp` via PATHEXT — so
      // the runnable fake must be a `.cmd` that hands the script to node.
      fs.writeFileSync(path.join(binDir, 'amp.js'), script);
      fs.writeFileSync(path.join(binDir, 'amp.cmd'), `@node "%~dp0amp.js" %*\r\n`);
    }
    return { binDir, stateFile };
  }

  it('a 429 on the primary account re-dispatches on the next account and succeeds', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'ratelimit-then-ok',
        AGENTS_TEST_STATE: stateFile,
      },
      // The synthesized "next healthy account" entry (same agent, different account).
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(0);
    // Primary 429'd (call 1), re-dispatched once and succeeded (call 2).
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('2');
  });

  it('a billing refusal on STDOUT (spend limit) also cascades — the gh-monitor heal bug', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'stdout-spend-limit-then-ok',
        AGENTS_TEST_STATE: stateFile,
      },
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('2');
  });

  it('a non-rate-limit failure does NOT re-dispatch (only 429s cascade)', async () => {
    const { binDir, stateFile } = fakeAmp();
    const code = await runWithFallback({
      agent: 'amp',
      prompt: 'do the task',
      mode: 'edit',
      effort: 'auto',
      headless: true,
      cwd: binDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        AGENTS_TEST_MODE: 'plain-fail',
        AGENTS_TEST_STATE: stateFile,
      },
      fallback: [{ agent: 'amp' }],
    });
    expect(code).toBe(1);
    // Ran the primary exactly once — a plain failure is surfaced, not retried.
    expect(fs.readFileSync(stateFile, 'utf8')).toBe('1');
  });
});

describe('balanced excludes an account refused by Claude session quota (RUSH-2858)', () => {
  it('uses the persisted real-run state instead of treating missing bars as 0%', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-session-limit-'));
    const previous = setClaudeUsageCachePathForTest(path.join(root, 'usage.json'));
    try {
      const limitedKey = 'claude:org=limited';
      noteClaudeSessionLimit(limitedKey, new Date(Date.now() + 60 * 60 * 1000));
      const limited = candidate({
        version: '2.1.221',
        usageKey: limitedKey,
        usageSnapshot: readClaudeUsageCache(limitedKey),
      });
      const healthy = candidate({ version: '2.1.222' });

      const result = pickBalancedCandidate([limited, healthy]);

      expect(result?.picked.version).toBe('2.1.222');
      expect(result?.excluded.map((entry) => entry.version)).toEqual(['2.1.221']);
    } finally {
      setClaudeUsageCachePathForTest(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('balanced excludes a weekly-exhausted account once the week window is cached (PHNX-3392, GWT-E5c)', () => {
  // Fix C (claude-statusline.ts `ingestClaudeStatusLineUsage`) persists a
  // 7d-100% `week` window when a run hits its weekly limit — via
  // `mergeClaudeUsageCacheWindows`, the exact write path exercised here against
  // a real cache file. Once that row exists, `hasUsageAvailable` (rotate.ts)
  // reads the snapshot as rate_limited and the account is INELIGIBLE — the
  // next `collectRunCandidates` → `pickBalancedCandidate` cannot return it.
  it('a real 7d-100% week window in the cache makes the account ineligible, not merely down-weighted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-week-limit-'));
    const previous = setClaudeUsageCachePathForTest(path.join(root, 'usage.json'));
    try {
      const exhaustedKey = 'claude:org=exhausted';
      mergeClaudeUsageCacheWindows(exhaustedKey, {
        source: 'live',
        sourceLabel: 'Claude response rate limits',
        capturedAt: new Date(),
        windows: [{
          key: 'week',
          label: 'Current week',
          shortLabel: 'W',
          usedPercent: 100,
          resetsAt: new Date(Date.now() + 24 * 3600 * 1000),
          windowMinutes: 10_080,
        }],
      });
      const exhausted = candidate({
        version: '2.1.223',
        usageKey: exhaustedKey,
        usageSnapshot: readClaudeUsageCache(exhaustedKey),
      });
      expect(exhausted.usageSnapshot).not.toBeNull();
      const healthy = candidate({ version: '2.1.224' });

      const result = pickBalancedCandidate([exhausted, healthy]);

      expect(result?.picked.version).toBe('2.1.224');
      expect(result?.excluded.map((entry) => entry.version)).toEqual(['2.1.223']);
      expect(result?.healthy.map((entry) => entry.version)).toEqual(['2.1.224']);
    } finally {
      setClaudeUsageCachePathForTest(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Build a UsageSnapshot from `[key, usedPercent]` pairs. */
function snapshot(windows: Array<{ key: UsageWindowKey; usedPercent: number }>): UsageSnapshot {
  return {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: null,
    windows: windows.map((w) => ({
      key: w.key,
      label: w.key,
      shortLabel: w.key,
      usedPercent: w.usedPercent,
      resetsAt: null,
      windowMinutes: null,
    })),
  };
}

describe('candidateAccountKey (PHNX-3940 — native id wins over the org-shared usageKey)', () => {
  it('prefers a stable native account id over usageKey/accountKey/email', () => {
    const c = candidate({ version: '1.0.0', nativeAccountId: 'acct-1', usageKey: 'claude:org=shared' });
    expect(candidateAccountKey(c)).toBe('native:acct-1');
  });

  it('two sibling accounts under the same org usageKey stay distinct once nativeAccountId is known', () => {
    const a = candidate({ version: '1.0.0', nativeAccountId: 'acct-a', usageKey: 'claude:org=shared' });
    const b = candidate({ version: '1.0.1', nativeAccountId: 'acct-b', usageKey: 'claude:org=shared' });
    expect(candidateAccountKey(a)).not.toBe(candidateAccountKey(b));
  });

  it('falls back to providerAccount, then usageKey, when no native id is known', () => {
    const provider = candidate({ version: '1.0.0', nativeAccountId: undefined, usageKey: null, providerAccount: 'setup-token-1' });
    expect(candidateAccountKey(provider)).toBe('provider:setup-token-1');
    const orgOnly = candidate({ version: '1.0.0', nativeAccountId: undefined, providerAccount: undefined, usageKey: 'claude:org=shared' });
    expect(candidateAccountKey(orgOnly)).toBe('claude:org=shared');
  });
});

describe('readinessFromCandidate / pickBalancedCandidate — per-model refusal (PHNX-3940)', () => {
  let root: string;
  let previous: string | null;

  afterEach(() => {
    setClaudeUsageCachePathForTest(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('A/Fable is blocked while A/Sonnet and B/Fable (same org) stay eligible', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-model-refusal-'));
    previous = setClaudeUsageCachePathForTest(path.join(root, 'usage.json'));

    const a = candidate({ version: '1.0.0', nativeAccountId: 'acct-a', usageKey: 'claude:org=shared' });
    const b = candidate({ version: '1.0.1', nativeAccountId: 'acct-b', usageKey: 'claude:org=shared' });
    noteClaudeModelRefusal(claudeModelRefusalKey(a.nativeAccountId)!, 'claude-fable-5-1', { family: 'Fable' });

    // Generic (model-unaware) readiness is completely unaffected by the
    // model-only marker — a caller that never opts in never sees it.
    expect(readinessFromCandidate(a)).toEqual({ ready: true });

    // A's Fable is blocked...
    expect(readinessFromCandidate(a, Date.now(), 'claude-fable-5-1')).toEqual({
      ready: false, reason: 'model_limited', email: a.email,
    });
    // ...but A's Sonnet is untouched...
    expect(readinessFromCandidate(a, Date.now(), 'claude-sonnet-5')).toEqual({ ready: true });
    // ...and B's Fable — a SIBLING account sharing the same org usageKey — is
    // untouched too, proving the marker never poisoned the shared org bucket.
    expect(readinessFromCandidate(b, Date.now(), 'claude-fable-5-1')).toEqual({ ready: true });

    const result = pickBalancedCandidate([a, b], Date.now(), 'claude-fable-5-1');
    expect(result?.picked.version).toBe('1.0.1');
    expect(result?.excluded.map((c) => c.version)).toEqual(['1.0.0']);

    // Without the model filter, both remain eligible.
    const unfiltered = pickBalancedCandidate([a, b]);
    expect(unfiltered?.healthy.map((c) => c.version).sort()).toEqual(['1.0.0', '1.0.1']);
  });

  it.each(['balanced', 'available'] as const)('production %s routing excludes a refused model', async (strategy) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-model-route-'));
    previous = setClaudeUsageCachePathForTest(path.join(root, 'usage.json'));
    const a = candidate({ version: '1.0.0', nativeAccountId: 'acct-a' });
    const b = candidate({ version: '1.0.1', nativeAccountId: 'acct-b' });
    noteClaudeModelRefusal(claudeModelRefusalKey(a.nativeAccountId)!, 'claude-fable-5-1', { family: 'Fable' });
    const result = await resolveRunVersion('claude', strategy, root, async () => [a, b], 'claude-fable-5-1');
    expect(result.rotation?.picked.nativeAccountId).toBe('acct-b');
  });

  it('a model refusal with a future reset expires on its own clock', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotate-model-refusal-reset-'));
    previous = setClaudeUsageCachePathForTest(path.join(root, 'usage.json'));

    const a = candidate({ version: '1.0.0', nativeAccountId: 'acct-a' });
    const resetsAt = new Date(Date.now() + 60_000);
    noteClaudeModelRefusal(claudeModelRefusalKey(a.nativeAccountId)!, 'claude-fable-5-1', { family: 'Fable', resetsAt });

    expect(readinessFromCandidate(a, Date.now(), 'claude-fable-5-1').ready).toBe(false);
    expect(readinessFromCandidate(a, resetsAt.getTime() + 1, 'claude-fable-5-1').ready).toBe(true);
  });
});

describe('readinessFromCandidate (pre-flight warning for version-pinned teammates)', () => {
  it('healthy account (auth ok, no snapshot, cached available) is ready', () => {
    expect(readinessFromCandidate(candidate({ version: '1.0.0' }))).toEqual({ ready: true });
  });

  it('no live snapshot + cached rate_limited => not ready, reason rate_limited', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', usageStatus: 'rate_limited' })),
    ).toEqual({ ready: false, reason: 'rate_limited', email: '1.0.0@example.com' });
  });

  it('no live snapshot + cached out_of_credits => not ready, reason out_of_credits', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', usageStatus: 'out_of_credits' })),
    ).toEqual({ ready: false, reason: 'out_of_credits', email: '1.0.0@example.com' });
  });

  it('live snapshot with the 5h session window maxed => not ready (session-inclusive, matches the badge)', () => {
    // usageStatus stays the default `available`; the live snapshot must still
    // exclude it — this is the exact drift #757 fixed and the warning must mirror.
    const c = candidate({ version: '1.0.0', usageSnapshot: snapshot([{ key: 'session', usedPercent: 100 }]) });
    expect(readinessFromCandidate(c)).toEqual({ ready: false, reason: 'rate_limited', email: '1.0.0@example.com' });
  });

  it('live snapshot showing capacity WINS over a stale cached out_of_credits => ready', () => {
    // Mirrors hasUsageAvailable: a present live snapshot overrides the coarse
    // cache, so we do not warn about an account that is actually serving.
    const c = candidate({
      version: '1.0.0',
      usageStatus: 'out_of_credits',
      usageSnapshot: snapshot([{ key: 'session', usedPercent: 20 }, { key: 'week', usedPercent: 40 }]),
    });
    expect(readinessFromCandidate(c)).toEqual({ ready: true });
  });

  it('only the Sonnet-weekly window is maxed => ready (sonnet_week never blocks when a real window is present)', () => {
    const c = candidate({
      version: '1.0.0',
      usageSnapshot: snapshot([{ key: 'session', usedPercent: 50 }, { key: 'sonnet_week', usedPercent: 100 }]),
    });
    expect(readinessFromCandidate(c)).toEqual({ ready: true });
  });

  it('opaque signed-in credential without an email remains ready', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', email: null })),
    ).toEqual({ ready: true });
  });

  it('signed-out credential is rejected even with usage headroom', () => {
    expect(
      readinessFromCandidate(candidate({ version: '1.0.0', signedIn: false })),
    ).toEqual({ ready: false, reason: 'signed_out', email: '1.0.0@example.com' });
  });

  it('does not let a stale revoked probe veto a currently present credential forever', () => {
    const now = 1_000_000_000;
    const stale = candidate({ version: '1.0.0', authVerdict: 'revoked', authCheckedAt: now - 21 * 60_000 });
    const fresh = candidate({ version: '1.0.0', authVerdict: 'revoked', authCheckedAt: now - 60_000 });
    expect(readinessFromCandidate(stale, now)).toEqual({ ready: true });
    expect(readinessFromCandidate(fresh, now)).toEqual({ ready: false, reason: 'revoked', email: '1.0.0@example.com' });
  });
});

describe('isSignInRecoverable / signInRecoverableCandidates (RUSH-2334)', () => {
  it('an auth exclusion is recoverable — a login clears it', () => {
    expect(isSignInRecoverable({ ready: false, reason: 'signed_out', email: null })).toBe(true);
    expect(isSignInRecoverable({ ready: false, reason: 'revoked', email: null })).toBe(true);
  });

  it('a throttle exclusion is NOT recoverable — launching it hammers an exhausted account (RUSH-2132)', () => {
    expect(isSignInRecoverable({ ready: false, reason: 'rate_limited', email: null })).toBe(false);
    expect(isSignInRecoverable({ ready: false, reason: 'out_of_credits', email: null })).toBe(false);
  });

  it('a ready account is not "recoverable" — there is nothing to recover', () => {
    expect(isSignInRecoverable({ ready: true })).toBe(false);
  });

  it('selects only the auth-excluded accounts out of a mixed exhausted set', () => {
    const signedOut = candidate({ version: '1.0.0', signedIn: false });
    const revoked = candidate({ version: '2.0.0', authVerdict: 'revoked' });
    const limited = candidate({ version: '3.0.0', usageStatus: 'rate_limited' });
    const broke = candidate({ version: '4.0.0', usageStatus: 'out_of_credits' });

    expect(signInRecoverableCandidates([signedOut, revoked, limited, broke]).map((c) => c.version))
      .toEqual(['1.0.0', '2.0.0']);
  });

  it('an all-throttled exhausted set yields nothing, so the caller still fails loud', () => {
    expect(signInRecoverableCandidates([
      candidate({ version: '1.0.0', usageStatus: 'rate_limited' }),
      candidate({ version: '2.0.0', usageStatus: 'out_of_credits' }),
    ])).toEqual([]);
  });
});

/** A snapshot stamped with a real capture time, for the freshness gate. */
function snapshotAt(
  capturedAt: Date,
  windows: Array<{ key: UsageWindowKey; usedPercent: number }>,
): UsageSnapshot {
  return { ...snapshot(windows), capturedAt };
}

describe('routing refuses to decide on usage it cannot verify', () => {
  // The real incident: yosemite-s1's usage cache sat 26h–2.7d old with a
  // failing refresh, so balanced read muqsit@getrush.ai as 48% used and
  // launched into it. The account was actually at its weekly cap and the
  // session answered "You've hit your weekly limit" on its first turn.
  const NOW = Date.UTC(2026, 7, 3, 6, 57);
  const fresh = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);
  const dayOld = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent }]);

  it('a last-known window the VIEW renders (staleWindows) stays unverified and never rate-limits routing', () => {
    // The display fix (last-known + age in `agents view`) must not leak into
    // routing. A snapshot whose only reading is an expired 100% session window —
    // moved to `staleWindows` so the view can show "S: █████ 100% · 6h old" —
    // must read to the router exactly as a blind snapshot did before: unverified,
    // not stale (no number in `windows`), and NOT rate-limited by that 100%.
    const staleSession: UsageWindow = {
      key: 'session',
      label: 'Session',
      shortLabel: 'S',
      usedPercent: 100,
      resetsAt: new Date(NOW - 60 * 60 * 1000),
      windowMinutes: 300,
    };
    const viewOnly: UsageSnapshot = {
      source: 'last_seen',
      sourceLabel: 'cached',
      capturedAt: new Date(NOW - 6 * 60 * 60 * 1000),
      windows: [],
      staleWindows: [staleSession],
    };
    const c = candidate({ version: '2.1.181', usageSnapshot: viewOnly });

    // Routing gate: no fresh number to trust.
    expect(isUsageVerified(c, NOW)).toBe(false);
    expect(hasStaleUsage(c, NOW)).toBe(false);
    // The expired 100% must not make the account read as rate-limited/ineligible —
    // deriveUsageStatusFromSnapshot only ever consults `windows`.
    expect(deriveUsageStatusFromSnapshot(viewOnly)).toBeNull();
    expect(readinessFromCandidate(c)).toEqual({ ready: true });

    // And it is never PICKED as verified when a genuinely fresh account exists.
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });
    const result = pickBalancedCandidate([c, verified], NOW)!;
    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
  });

  it('never picks a day-old candidate while a verified one exists — even when the stale one looks emptier', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickBalancedCandidate([stale, verified], NOW)!;

    // 48% "used" would outweigh 90% under pure capacity weighting; unverified
    // loses to verified regardless, because the 48% is not evidence.
    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
    // ...but the stale account stays in `healthy`, because that array also feeds
    // rotationFailoverChain. Refusing to PICK it is not the same call as refusing
    // to fail over to it once the primary has already hit a 429.
    expect(result.healthy.map((c) => c.version).sort()).toEqual(['2.1.181', '2.1.219']);
    expect(result.excluded.map((c) => c.version)).not.toContain('2.1.181');
  });

  it('still launches when NOTHING can be verified, and says the pick was unverified', () => {
    // A box with a broken refresh must not become unlaunchable — but the
    // operator has to learn the route was blind, not silently inherit it.
    const a = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: dayOld(70) });

    const result = pickBalancedCandidate([a, b], NOW)!;

    expect(result.usageUnverified).toBe(true);
    expect(result.healthy.length).toBe(2);
    expect(['2.1.181', '2.1.207']).toContain(result.picked.version);
  });

  it('flags noVerifiedUsage when EVERY account is stale-but-present (PHNX-2526)', () => {
    // The all-stale pool the initial route must refuse: a real number on each
    // account, all of it too old to trust. `picked`/`healthy` stay populated
    // (for failover); the flag is what tells resolveRunVersion not to launch it.
    const a = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: dayOld(70) });

    const result = pickBalancedCandidate([a, b], NOW)!;

    expect(result.noVerifiedUsage).toBe(true);
    expect(result.healthy.length).toBe(2);
    expect(result.picked.version).toBeDefined();
  });

  it('does NOT flag noVerifiedUsage when a verified account exists', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickBalancedCandidate([stale, verified], NOW)!;

    expect(result.noVerifiedUsage).toBe(false);
    expect(result.picked.version).toBe('2.1.219');
  });

  it('does NOT flag noVerifiedUsage for a BLIND pool with no snapshots — the worker-box case still draws a pick', () => {
    // A worker whose usage endpoint 403s carries NO snapshot at all (RUSH-2392).
    // That is not a misleading number, so it must not fail loud — it still picks.
    const a = candidate({ version: '2.1.181' });
    const b = candidate({ version: '2.1.207' });

    const result = pickBalancedCandidate([a, b], NOW)!;

    expect(result.noVerifiedUsage).toBe(false);
    expect(['2.1.181', '2.1.207']).toContain(result.picked.version);
  });

  it('does NOT flag noVerifiedUsage for a meterless plan-only pool (grok has no windows to be stale)', () => {
    const planOnly = snapshotAt(new Date(NOW - 3 * 24 * 3600 * 1000), []);
    planOnly.plan = 'SuperGrok Heavy';
    const a = candidate({ version: '0.2.118', usageSnapshot: planOnly });

    const result = pickBalancedCandidate([a], NOW)!;

    expect(result.noVerifiedUsage).toBe(false);
  });

  it('hasStaleUsage distinguishes a stale-present snapshot from a blind/meterless one', () => {
    expect(hasStaleUsage(candidate({ version: '1.0.0', usageSnapshot: dayOld(10) }), NOW)).toBe(true);
    expect(hasStaleUsage(candidate({ version: '1.0.0', usageSnapshot: fresh(10) }), NOW)).toBe(false);
    expect(hasStaleUsage(candidate({ version: '1.0.0' }), NOW)).toBe(false);
    const meterless = snapshotAt(new Date(NOW - 26 * 3600 * 1000), []);
    expect(hasStaleUsage(candidate({ version: '1.0.0', usageSnapshot: meterless }), NOW)).toBe(false);
  });

  it('two-tier freshness: a budget-paced idle reading is unverified but NOT refusal-stale', () => {
    // The daemon paces proactive refreshes under a per-provider budget, so a
    // healthy IDLE account is deliberately refreshed on a stretched round-robin
    // cadence. A 25-min-old reading is one of those: too old to WEIGHT on (the
    // 5-min decision bar), but nowhere near the hours-old broken-refresh staleness
    // the NO_VERIFIED_USAGE refusal exists to catch (40-min bar).
    const paced = snapshotAt(new Date(NOW - 25 * 60_000), [{ key: 'week', usedPercent: 30 }]);
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: paced }), NOW)).toBe(false);
    expect(hasStaleUsage(candidate({ version: '1.0.0', usageSnapshot: paced }), NOW)).toBe(false);
    // A genuinely broken refresh (past the 40-min refusal bar) IS refusal-stale.
    const broken = snapshotAt(new Date(NOW - 45 * 60_000), [{ key: 'week', usedPercent: 30 }]);
    expect(hasStaleUsage(candidate({ version: '1.0.0', usageSnapshot: broken }), NOW)).toBe(true);
  });

  it('does NOT refuse a pool where every account is merely budget-paced (10–30 min), only genuinely stale ones', () => {
    // The BLOCKER: budget pacing + a 5-min refusal bar collapsed an all-idle fleet
    // to NO_VERIFIED_USAGE. With the wider refusal bar, a fleet of paced-but-not-
    // broken readings still routes (drawing on the floored weights).
    const pacedA = candidate({ version: '2.1.181', usageSnapshot: snapshotAt(new Date(NOW - 12 * 60_000), [{ key: 'week', usedPercent: 20 }]) });
    const pacedB = candidate({ version: '2.1.207', usageSnapshot: snapshotAt(new Date(NOW - 28 * 60_000), [{ key: 'week', usedPercent: 40 }]) });
    const result = pickBalancedCandidate([pacedA, pacedB], NOW)!;
    expect(result.noVerifiedUsage).toBe(false);
    expect(['2.1.181', '2.1.207']).toContain(result.picked.version);
  });

  it('a verified MINORITY does not capture every launch — the 429-throttled regime', () => {
    // The 2026-08-20 incident: the usage endpoint 429-throttles a machine, so
    // each refresh cycle confirms exactly one account. Narrowing to verified
    // made `choose` run over a one-element list — the same account picked on
    // every launch, which kept refreshing its own snapshot and locked the loop
    // in. One fresh account among eight stale ones must not be a pin.
    const fresh1 = candidate({ version: '2.1.219', usageSnapshot: fresh(10) });
    const stale = ['2.1.181', '2.1.207', '2.1.217', '2.1.218', '2.1.220', '2.1.221', '2.1.222']
      .map((version) => candidate({ version, usageSnapshot: dayOld(0) }));

    const picks = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const result = pickBalancedCandidate([fresh1, ...stale], NOW)!;
      picks.add(result.picked.version);
      // usageUnverified reports the PICK, not the pool: a stale pick out of a
      // mixed pool must say so (the reviewer's truthfulness finding).
      expect(result.usageUnverified).toBe(result.picked.version !== '2.1.219');
    }

    // Weighted-random over the whole pool: with near-equal weights, 200 draws
    // landing on one account has probability ~(1/8)^199 — a distribution with
    // a single member means the narrowing collapse is back.
    expect(picks.size).toBeGreaterThan(1);
  });

  it('in the 429-throttled regime, the one verified account wins the draw over emptier-looking stale ones (PHNX-3479)', () => {
    // A verified MINORITY (1 of 8) does not narrow the pool, so the stale
    // accounts still compete — but an unverified snapshot must weight as the
    // floor, not by its frozen "0% used". Before this fix, seven stale-0%
    // accounts (weight 100 each) outweighed the one fresh-40% account
    // (weight 60) ~92% to 8%, so balanced kept launching into stale accounts
    // that were really at their weekly cap on a worker whose refresh had
    // stalled. Now the verified account wins the vast majority of draws.
    const freshHealthy = candidate({ version: '2.1.219', usageSnapshot: fresh(40) });
    const stale = ['2.1.181', '2.1.207', '2.1.217', '2.1.218', '2.1.220', '2.1.221', '2.1.222']
      .map((version) => candidate({ version, usageSnapshot: dayOld(0) }));

    let freshPicks = 0;
    const ROLLS = 2000;
    for (let i = 0; i < ROLLS; i++) {
      if (pickBalancedCandidate([freshHealthy, ...stale], NOW)!.picked.version === '2.1.219') freshPicks++;
    }
    // weights: fresh(40) → 60; each unverified stale → UNVERIFIED_WEIGHT (1);
    // 7 stale → 7. Fresh share ≈ 60/67 ≈ 0.90 — assert a robust floor.
    expect(freshPicks / ROLLS).toBeGreaterThan(0.8);
  });

  it('verified coverage of half the pool still narrows to the verified set', () => {
    // ceil(4/2) = 2 verified of 4: representative — stale candidates must not
    // dilute a majority-confirmed picture.
    const verifiedA = candidate({ version: '2.1.219', usageSnapshot: fresh(10) });
    const verifiedB = candidate({ version: '2.1.220', usageSnapshot: fresh(20) });
    const staleA = candidate({ version: '2.1.181', usageSnapshot: dayOld(0) });
    const staleB = candidate({ version: '2.1.207', usageSnapshot: dayOld(0) });

    for (let i = 0; i < 50; i++) {
      const result = pickBalancedCandidate([staleA, verifiedA, staleB, verifiedB], NOW)!;
      expect(['2.1.219', '2.1.220']).toContain(result.picked.version);
      expect(result.usageUnverified).toBe(false);
    }
  });

  it('a verified rate-limited account is still excluded outright, not merely deprioritized', () => {
    const limited = candidate({ version: '2.1.170', usageSnapshot: fresh(100) });
    const ok = candidate({ version: '2.1.219', usageSnapshot: fresh(20) });

    const result = pickBalancedCandidate([limited, ok], NOW)!;

    expect(result.picked.version).toBe('2.1.219');
    expect(result.excluded.map((c) => c.version)).toContain('2.1.170');
  });

  it('isUsageVerified: a snapshot with no capture time is unverified, not assumed current', () => {
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: fresh(10) }), NOW)).toBe(true);
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: dayOld(10) }), NOW)).toBe(false);
    // snapshot() leaves capturedAt null — an undated number proves nothing.
    expect(isUsageVerified(candidate({ version: '1.0.0', usageSnapshot: snapshot([{ key: 'week', usedPercent: 10 }]) }), NOW)).toBe(false);
    expect(isUsageVerified(candidate({ version: '1.0.0' }), NOW)).toBe(false);
  });

  it('isUsageVerified: a fresh snapshot with no windows verifies nothing', () => {
    // Grok reports a subscription tier and no meters, so its cached row is
    // plan-only. Freshness alone must not make it "verified": it carries no
    // utilization to route on.
    const planOnly = snapshotAt(new Date(NOW - 60_000), []);
    planOnly.plan = 'SuperGrok Heavy';

    expect(isUsageVerified(candidate({ version: '0.2.118', usageSnapshot: planOnly }), NOW)).toBe(false);
  });

  it('a meterless pool stays spread instead of pinning to the most recently logged account', () => {
    // Both accounts are plan-only; one's billing log was touched a minute ago,
    // the other's three days ago — the normal steady state for grok. If the
    // recent one counted as verified, preferVerified would narrow to it every
    // draw, and running it would refresh its log and pin it permanently.
    const recent = snapshotAt(new Date(NOW - 60_000), []);
    recent.plan = 'SuperGrok Heavy';
    const older = snapshotAt(new Date(NOW - 3 * 24 * 3600 * 1000), []);
    older.plan = 'X Premium+';

    const picks = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const result = pickBalancedCandidate(
        [
          candidate({ version: '0.2.118', usageSnapshot: recent }),
          candidate({ version: '0.2.101', usageSnapshot: older }),
        ],
        NOW,
      )!;
      picks.add(result.picked.version);
    }

    expect([...picks].sort()).toEqual(['0.2.101', '0.2.118']);
  });
});

describe('--strategy available applies the same freshness rule as balanced', () => {
  // The reviewer's catch: collectRunCandidates caps staleness for EVERY caller,
  // so `available` paid the new live-fetch cost while keeping the exact bug —
  // it sorts by apparent headroom and takes the front, so an unconfirmed "48%
  // used" outranked an accurate "90% used" just as it did under balanced.
  const NOW = Date.UTC(2026, 7, 3, 6, 57);
  const fresh = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);
  const dayOld = (usedPercent: number) =>
    snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent }]);

  it('does not route to the emptier-looking stale account over a verified one', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickAvailableCandidate([stale, verified], null, NOW)!;

    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
  });

  it('flags the pick when nothing could be verified, and still launches', () => {
    const a = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: dayOld(70) });

    const result = pickAvailableCandidate([a, b], null, NOW)!;

    expect(result.usageUnverified).toBe(true);
    expect(result.picked.version).toBe('2.1.181'); // still the headroom sort
  });

  it('a verified MINORITY still wins the deterministic pick — no whole-pool relaxation here', () => {
    // The reviewer's catch on the first cut of the RUSH-2858 fix: relaxing the
    // verified-first narrowing for a verified minority is only safe for a
    // WEIGHTED-RANDOM chooser (it spreads load). `available` picks the front of
    // the headroom sort deterministically, so a whole-pool fallback would hand
    // the slot to an unconfirmed stale "5% used" over an accurate 95% — the
    // original yosemite-s1 inversion. One verified account among eight must
    // still be the pick.
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(95) });
    const stale = ['2.1.181', '2.1.207', '2.1.217', '2.1.218', '2.1.220', '2.1.221', '2.1.222']
      .map((version) => candidate({ version, usageSnapshot: dayOld(5) }));

    const result = pickAvailableCandidate([...stale, verified], null, NOW)!;

    expect(result.picked.version).toBe('2.1.219');
    expect(result.usageUnverified).toBe(false);
  });

  it('an explicit version preference is an instruction and still wins', () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: dayOld(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: fresh(90) });

    const result = pickAvailableCandidate([stale, verified], '2.1.181', NOW)!;

    expect(result.picked.version).toBe('2.1.181');
  });
});

describe('capacityWeight — deprioritizes an account projected to cap soon', () => {
  it('is weekly headroom when there is no projection', () => {
    // A null snapshot is UNVERIFIED, not full capacity (PHNX-3392, GWT-E5c) —
    // the dedicated fail-closed contract lives in capacity.test.ts.
    expect(capacityWeight(null, null)).toBe(1);
    expect(capacityWeight(50, null)).toBe(50);
    expect(capacityWeight(90, null)).toBe(10);
  });

  it('keeps full weight for an account comfortably far from its cap', () => {
    // >= the horizon (or unknown) => factor 1, weight unchanged.
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN)).toBe(50);
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN * 3)).toBe(50);
  });

  it('scales the weight down as the projected cap approaches', () => {
    // Half the horizon => half the weight; a few minutes out => near the floor.
    expect(capacityWeight(50, PROJECTION_HORIZON_MIN / 2)).toBeCloseTo(25, 5);
    expect(capacityWeight(50, 3)).toBeCloseTo(5, 5);
    // Projected to cap right now (minutesToLimit 0) => floored at 1, not 0.
    expect(capacityWeight(50, 0)).toBe(1);
  });

  it('makes a fast-burning account strictly less likely than an idle one at the SAME usage', () => {
    // The whole point: two accounts read 50% used, but one is racing toward its
    // 5h cap. It must weigh less so balanced routing avoids it.
    const burningFast = capacityWeight(50, 3);
    const idle = capacityWeight(50, null);
    expect(burningFast).toBeLessThan(idle);
  });
});

/** A candidate for a specific harness (the `candidate` helper above is claude-only). */
function harnessAcct(agent: AgentId, version: string, over: Partial<RotateCandidate> = {}): RotateCandidate {
  return {
    ...candidate({ version, ...over }),
    agent,
    accountKey: `${agent}:account=${version}`,
    accountLabel: `${version}@${agent}.example.com`,
    email: `${version}@${agent}.example.com`,
    usageKey: `${agent}:org=${version}`,
  };
}

describe('pickHarnessWeighted (run auto — the cross-harness layer, RUSH-2132)', () => {
  const NOW = Date.UTC(2026, 7, 3, 7, 0);
  const freshSnap = (usedPercent: number): UsageSnapshot =>
    snapshotAt(new Date(NOW - 60_000), [{ key: 'week', usedPercent }]);

  it('excludes a zero-healthy harness outright — it is never picked, not down-weighted', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' })]],
      ['codex', [harnessAcct('codex', '0.116.0')]],
    ]);
    for (let i = 0; i < 50; i++) {
      const result = pickHarnessWeighted(byHarness, NOW)!;
      expect(result.picked.agent).toBe('codex');
    }
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(result.healthy.map((s) => s.agent)).toEqual(['codex']);
    expect(result.excluded.map((s) => s.agent)).toEqual(['claude']);
    expect(result.excluded[0].exclusionReasons).toEqual(['1 rate_limited']);
  });

  it('weights harnesses by their BEST account headroom, sharing the account layer sampler', () => {
    // claude's best account is at 0% used (weight 100), codex's at 90% (weight
    // 10) — claude should win ~91% of rolls. 2000 rolls makes <80% statistically
    // impossible under the correct weighting.
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageSnapshot: freshSnap(0) })]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(90) })]],
    ]);
    let claudePicks = 0;
    const ROLLS = 2000;
    for (let i = 0; i < ROLLS; i++) {
      if (pickHarnessWeighted(byHarness, NOW)!.picked.agent === 'claude') claudePicks++;
    }
    expect(claudePicks / ROLLS).toBeGreaterThan(0.8);
  });

  it('capacity comes from the best account (min used), not the average — an exhausted sibling does not drag the harness down', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageSnapshot: freshSnap(95) }),
        harnessAcct('claude', '2.1.186', { usageSnapshot: freshSnap(10) }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(50) })]],
    ]);
    const summaries = classifyHarnessCandidates(byHarness, NOW);
    const claude = summaries.find((s) => s.agent === 'claude')!;
    expect(claude.best!.version).toBe('2.1.186');
    expect(claude.bestUsedPercent).toBe(10);
    // Weights 90 vs 50 → claude ~64% of rolls.
    let claudePicks = 0;
    const ROLLS = 2000;
    for (let i = 0; i < ROLLS; i++) {
      if (pickHarnessWeighted(byHarness, NOW)!.picked.agent === 'claude') claudePicks++;
    }
    expect(claudePicks / ROLLS).toBeGreaterThan(0.55);
  });

  it('a stale snapshot never becomes the harness representative while a verified account exists', () => {
    const stale = snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent: 5 }]);
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.181', { usageSnapshot: stale }),
        harnessAcct('claude', '2.1.219', { usageSnapshot: freshSnap(80) }),
      ]],
    ]);
    const [summary] = classifyHarnessCandidates(byHarness, NOW);
    // The day-old "5% used" is not evidence; the verified 80% account represents.
    expect(summary.best!.version).toBe('2.1.219');
  });

  it('a verified minority of a large pool still represents the harness — deterministic, no relaxation', () => {
    // Mirror of the `available` minority test: classify's `from[0]` chooser
    // must keep verified-first narrowing even when verified accounts are a
    // minority, or a stale-looking-empty account becomes the representative.
    const stale = snapshotAt(new Date(NOW - 26 * 3600 * 1000), [{ key: 'week', usedPercent: 5 }]);
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        ...['2.1.181', '2.1.207', '2.1.217', '2.1.218', '2.1.220', '2.1.221', '2.1.222']
          .map((version) => harnessAcct('claude', version, { usageSnapshot: stale })),
        harnessAcct('claude', '2.1.219', { usageSnapshot: freshSnap(80) }),
      ]],
    ]);
    const [summary] = classifyHarnessCandidates(byHarness, NOW);
    expect(summary.best!.version).toBe('2.1.219');
  });

  it('single-harness degenerate case: the only healthy harness is always picked', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207')]],
    ]);
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(result.picked.agent).toBe('claude');
    expect(result.healthy.length).toBe(1);
    expect(result.excluded.length).toBe(0);
    expect(formatHarnessPickBanner(result)).toBe(
      '[agents] auto picked claude (best account headroom unknown, 1 of 1 harnesses healthy)',
    );
  });

  it('returns null when every harness is exhausted; classify carries the exclusion detail', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' }),
        harnessAcct('claude', '2.1.186', { signedIn: false }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageStatus: 'out_of_credits' })]],
    ]);
    expect(pickHarnessWeighted(byHarness, NOW)).toBeNull();
    const summaries = classifyHarnessCandidates(byHarness, NOW);
    expect(summaries.every((s) => s.best === null)).toBe(true);
    const claude = summaries.find((s) => s.agent === 'claude')!;
    expect(claude.exclusionReasons).toEqual(['1 rate_limited', '1 signed_out']);
  });

  it('the banner names the picked harness and its best-account headroom', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [harnessAcct('claude', '2.1.207', { usageStatus: 'rate_limited' })]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageSnapshot: freshSnap(56) })]],
    ]);
    const result = pickHarnessWeighted(byHarness, NOW)!;
    expect(formatHarnessPickBanner(result)).toBe(
      '[agents] auto picked codex (best account 44% headroom, 1 of 2 harnesses healthy)',
    );
  });
});

describe('formatNoHealthyAccountError — the watchdog contract (RUSH-2132)', () => {
  const NOW = Date.UTC(2026, 7, 3, 7, 0);
  const resetAt = new Date(NOW + 2 * 3600 * 1000);
  const cappedSnap: UsageSnapshot = {
    source: 'live',
    sourceLabel: 'live',
    capturedAt: new Date(NOW - 60_000),
    windows: [{ key: 'week', label: 'week', shortLabel: 'week', usedPercent: 100, resetsAt: resetAt, windowMinutes: null }],
  };

  it('matches the exact message contract (literal `no healthy` + `resets <time>` + pinned escape hatch)', () => {
    const limited = candidate({ version: '2.1.207', usageSnapshot: cappedSnap });
    const msg = formatNoHealthyAccountError('claude', 'balanced', [limited], NOW);
    expect(msg).toBe(
      `agents: no healthy claude account under strategy 'balanced' — excluded: 2.1.207 (rate_limited); ` +
      `earliest window resets ${resetAt.toISOString()}. Use --strategy pinned to force the default.`,
    );
  });

  it('picks the earliest FUTURE reset across candidates and ignores past resets', () => {
    const later = new Date(NOW + 5 * 3600 * 1000);
    const past = new Date(NOW - 3600 * 1000);
    const snap = (resetsAt: Date): UsageSnapshot => ({
      ...cappedSnap,
      windows: [{ ...cappedSnap.windows[0], resetsAt }],
    });
    const a = candidate({ version: '1.0.0', usageSnapshot: snap(later) });
    const b = candidate({ version: '2.0.0', usageSnapshot: snap(resetAt) });
    const c = candidate({ version: '3.0.0', usageSnapshot: snap(past) });
    expect(earliestResetAcross([a, b, c], NOW)?.toISOString()).toBe(resetAt.toISOString());
  });

  it('degrades to `resets unknown` when no snapshot carries a reset timestamp', () => {
    const signedOut = candidate({ version: '2.1.207', signedIn: false });
    const msg = formatNoHealthyAccountError('claude', 'available', [signedOut], NOW);
    expect(msg).toContain('no healthy claude account');
    expect(msg).toContain("strategy 'available'");
    expect(msg).toContain('excluded: 2.1.207 (signed_out)');
    expect(msg).toContain('resets unknown');
  });

  it('names every excluded account with its reason', () => {
    const msg = formatNoHealthyAccountError('claude', 'balanced', [
      candidate({ version: '1.0.0', usageStatus: 'rate_limited' }),
      candidate({ version: '2.0.0', usageStatus: 'out_of_credits' }),
      candidate({ version: '3.0.0', signedIn: false }),
    ], NOW);
    expect(msg).toContain('excluded: 1.0.0 (rate_limited), 2.0.0 (out_of_credits), 3.0.0 (signed_out)');
  });

  it('formatNoHealthyHarnessError names each harness exclusion + the reset, and stays parseable', () => {
    const byHarness = new Map<AgentId, RotateCandidate[]>([
      ['claude', [
        harnessAcct('claude', '2.1.207', { usageSnapshot: cappedSnap }),
        harnessAcct('claude', '2.1.186', { signedIn: false }),
      ]],
      ['codex', [harnessAcct('codex', '0.116.0', { usageStatus: 'out_of_credits' })]],
    ]);
    const msg = formatNoHealthyHarnessError(classifyHarnessCandidates(byHarness, NOW), NOW);
    expect(msg).toContain('no healthy');
    expect(msg).toContain('claude (2 accounts: 1 rate_limited, 1 signed_out)');
    expect(msg).toContain('codex (1 account: 1 out_of_credits)');
    expect(msg).toContain(`resets ${resetAt.toISOString()}`);
  });
});

describe('resolveRunVersion — fail-loud signal on zero healthy (RUSH-2132)', () => {
  it('zero healthy accounts → rotation null + the full exhausted set (no silent default launch)', async () => {
    const limited = candidate({ version: '9.9.9', usageStatus: 'rate_limited' });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [limited]);
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted?.map((c) => c.version)).toEqual(['9.9.9']);
  });

  it('one healthy account → picked, no exhausted marker', async () => {
    const healthy = candidate({ version: '9.9.9' });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [healthy]);
    expect(resolved.rotation?.picked.version).toBe('9.9.9');
    expect(resolved.version).toBe('9.9.9');
    expect(resolved.exhausted).toBeUndefined();
  });

  it('pinned still uses a signed-in default without rotating', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-2685-pin-healthy-'));
    fs.writeFileSync(path.join(cwd, 'agents.yaml'), 'agents:\n  claude: "2.1.219"\n');
    const pinned = candidate({ version: '2.1.219' });
    const other = candidate({ version: '2.1.187' });
    const resolved = await resolveRunVersion('claude', 'pinned', cwd, async () => [pinned, other]);
    expect(resolved.version).toBe('2.1.219');
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted).toBeUndefined();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('pinned still forces a rate-limited default (the throttle escape hatch)', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-2685-pin-limited-'));
    fs.writeFileSync(path.join(cwd, 'agents.yaml'), 'agents:\n  claude: "2.1.219"\n');
    const pinned = candidate({ version: '2.1.219', usageStatus: 'rate_limited' });
    const other = candidate({ version: '2.1.187' });
    const resolved = await resolveRunVersion('claude', 'pinned', cwd, async () => [pinned, other]);
    expect(resolved.version).toBe('2.1.219');
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted).toBeUndefined();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('resolveRunVersion — never auto-pick from entirely stale usage (PHNX-2526)', () => {
  // Snapshots are dated relative to the real clock because resolveRunVersion
  // reads Date.now() internally (pickBalancedCandidate default nowMs).
  const freshSnap = (usedPercent: number) =>
    snapshotAt(new Date(Date.now() - 60_000), [{ key: 'week', usedPercent }]);
  const staleSnap = (usedPercent: number) =>
    snapshotAt(new Date(Date.now() - 26 * 3600 * 1000), [{ key: 'week', usedPercent }]);

  it('balanced: all-stale pool → version null, noVerifiedUsage set, NOT a silent stale launch', async () => {
    const a = candidate({ version: '2.1.181', usageSnapshot: staleSnap(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: staleSnap(70) });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [a, b]);
    expect(resolved.noVerifiedUsage).toBe(true);
    expect(resolved.version).toBeNull();
    expect(resolved.exhausted).toBeUndefined();
    // The stale candidates survive in `healthy` for bounded post-rejection failover.
    expect(resolved.rotation?.healthy.map((c) => c.version).sort()).toEqual(['2.1.181', '2.1.207']);
  });

  it('available: all-stale pool → version null, noVerifiedUsage set', async () => {
    const a = candidate({ version: '2.1.181', usageSnapshot: staleSnap(48) });
    const b = candidate({ version: '2.1.207', usageSnapshot: staleSnap(70) });
    const resolved = await resolveRunVersion('claude', 'available', process.cwd(), async () => [a, b]);
    expect(resolved.noVerifiedUsage).toBe(true);
    expect(resolved.version).toBeNull();
  });

  it('a single verified account in the pool routes normally — noVerifiedUsage stays unset', async () => {
    const stale = candidate({ version: '2.1.181', usageSnapshot: staleSnap(48) });
    const verified = candidate({ version: '2.1.219', usageSnapshot: freshSnap(20) });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [stale, verified]);
    expect(resolved.noVerifiedUsage).toBeFalsy();
    expect(resolved.version).toBe('2.1.219');
  });

  it('a BLIND pool (no snapshots) still routes — the worker-box case is not "stale" (PHNX-3392)', async () => {
    const a = candidate({ version: '2.1.181' });
    const b = candidate({ version: '2.1.207' });
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => [a, b]);
    expect(resolved.noVerifiedUsage).toBeFalsy();
    expect(['2.1.181', '2.1.207']).toContain(resolved.version);
  });

  it('pinned: an auth-blocked default rotating to only-stale siblings ALSO refuses (PR #3295 review)', async () => {
    // The pinned strategy's auth-blocked-pin fallback rotates via
    // pickAvailableCandidate — an initial selection, so it must honor the same
    // verified-only gate. A revoked pin whose only siblings are stale must NOT
    // launch one blind; it diverts exactly like balanced/available.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-2526-pin-stale-'));
    fs.writeFileSync(path.join(cwd, 'agents.yaml'), 'agents:\n  claude: "2.1.219"\n');
    const revokedPin = candidate({ version: '2.1.219', authVerdict: 'revoked' });
    const staleSibling = candidate({ version: '2.1.187', usageSnapshot: staleSnap(40) });
    const resolved = await resolveRunVersion('claude', 'pinned', cwd, async () => [revokedPin, staleSibling]);
    expect(resolved.noVerifiedUsage).toBe(true);
    expect(resolved.version).toBeNull();
    // The stale sibling is still in healthy for bounded failover.
    expect(resolved.rotation?.healthy.map((c) => c.version)).toContain('2.1.187');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('pinned: an auth-blocked default rotating to a VERIFIED sibling still routes normally', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-2526-pin-verified-'));
    fs.writeFileSync(path.join(cwd, 'agents.yaml'), 'agents:\n  claude: "2.1.219"\n');
    const revokedPin = candidate({ version: '2.1.219', authVerdict: 'revoked' });
    const verifiedSibling = candidate({ version: '2.1.187', usageSnapshot: freshSnap(20) });
    const resolved = await resolveRunVersion('claude', 'pinned', cwd, async () => [revokedPin, verifiedSibling]);
    expect(resolved.noVerifiedUsage).toBeFalsy();
    expect(resolved.version).toBe('2.1.187');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('bounded post-rejection failover still cascades across the preserved stale accounts', async () => {
    // The refused stale pool is still the failover net once a primary has hit a
    // 429 — by then the alternative is not launching at all, so a stale account
    // is better than nothing. The chain is bounded (DEFAULT_ROTATION_FAILOVER_LIMIT).
    const stale = ['2.1.181', '2.1.207', '2.1.217', '2.1.218', '2.1.219'].map((version) =>
      candidate({ version, usageSnapshot: staleSnap(30) }),
    );
    const resolved = await resolveRunVersion('claude', 'balanced', process.cwd(), async () => stale);
    expect(resolved.noVerifiedUsage).toBe(true);

    // Simulate the interactive picker having chosen the first account as primary.
    const primary = resolved.rotation!.healthy[0].version;
    const chain = rotationFailoverChain(resolved.rotation, primary);
    expect(chain.length).toBe(DEFAULT_ROTATION_FAILOVER_LIMIT);
    expect(chain.every((entry) => entry.agent === 'claude')).toBe(true);
    expect(chain.map((entry) => entry.version)).not.toContain(primary);
  });
});

describe('formatNoVerifiedUsageError (PHNX-2526 — the unattended fail-loud contract)', () => {
  const staleSnap = (usedPercent: number, ageMs: number) =>
    snapshotAt(new Date(Date.now() - ageMs), [{ key: 'week', usedPercent }]);

  it('carries the literal NO_VERIFIED_USAGE token and names each account with its staleness', () => {
    const a = candidate({ version: '2.1.181', usageSnapshot: staleSnap(48, 26 * 3600 * 1000) });
    const b = candidate({ version: '2.1.207' }); // blind — no snapshot
    const msg = formatNoVerifiedUsageError('claude', 'balanced', [a, b]);
    expect(msg).toContain('NO_VERIFIED_USAGE');
    expect(msg).toContain('2.1.181');
    expect(msg).toContain('2.1.207 (no usage snapshot)');
    expect(msg).toContain("strategy 'balanced'");
  });

  it('names the accounts even with an empty candidate list', () => {
    const msg = formatNoVerifiedUsageError('claude', 'available', []);
    expect(msg).toContain('NO_VERIFIED_USAGE');
    expect(msg).toContain('no signed-in accounts');
  });
});

describe('resolveRunVersion — skip a logged-out default (PHNX-2685)', () => {
  let cwd: string;
  afterEach(() => {
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  });

  function pinDefault(version: string): string {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'phnx-2685-loggedout-'));
    fs.writeFileSync(path.join(cwd, 'agents.yaml'), `agents:\n  claude: "${version}"\n`);
    return cwd;
  }

  it('pinned picks a signed-in sibling instead of launching a logged-out default', async () => {
    const project = pinDefault('2.1.219');
    const loggedOut = candidate({ version: '2.1.219', signedIn: false });
    const authed = candidate({ version: '2.1.187' });
    const resolved = await resolveRunVersion('claude', 'pinned', project, async () => [loggedOut, authed]);
    expect(resolved.version).toBe('2.1.187');
    expect(resolved.rotation?.picked.version).toBe('2.1.187');
    expect(resolved.rotation?.excluded.map((c) => c.version)).toContain('2.1.219');
    expect(resolved.exhausted).toBeUndefined();
  });

  it('pinned also yields a revoked default to a signed-in sibling', async () => {
    const project = pinDefault('2.1.219');
    const revoked = candidate({ version: '2.1.219', authVerdict: 'revoked' });
    const authed = candidate({ version: '2.1.187' });
    const resolved = await resolveRunVersion('claude', 'pinned', project, async () => [revoked, authed]);
    expect(resolved.version).toBe('2.1.187');
    expect(resolved.rotation?.picked.version).toBe('2.1.187');
  });

  it('pinned with a logged-out default and no signed-in sibling fails loud (exhausted)', async () => {
    const project = pinDefault('2.1.219');
    const loggedOut = candidate({ version: '2.1.219', signedIn: false });
    const alsoOut = candidate({ version: '2.1.187', signedIn: false });
    const resolved = await resolveRunVersion('claude', 'pinned', project, async () => [loggedOut, alsoOut]);
    expect(resolved.rotation).toBeNull();
    expect(resolved.exhausted?.map((c) => c.version).sort()).toEqual(['2.1.187', '2.1.219']);
  });

  // Real version homes + real collectRunCandidates. Off macOS the credential
  // floor keys off `.credentials.json`; a default with leftover `.claude.json`
  // oauthAccount and no token file used to look signed-in and die at spawn.
  it.skipIf(process.platform === 'darwin')(
    'collectRunCandidates + pinned skip a real logged-out default home',
    async () => {
      const project = pinDefault('2.1.219');
      const planted: string[] = [];
      const plant = (version: string, creds: boolean) => {
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
        if (creds) {
          fs.writeFileSync(
            path.join(home, '.claude', '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { accessToken: 'at-real', refreshToken: 'rt-real', expiresAt: 1 } }),
          );
        }
      };
      try {
        plant('2.1.219', false);
        plant('2.1.187', true);
        invalidateInstalledVersionsCache('claude');
        const resolved = await resolveRunVersion('claude', 'pinned', project);
        expect(resolved.version).toBe('2.1.187');
        expect(resolved.rotation?.picked.version).toBe('2.1.187');
        expect(resolved.rotation?.excluded.some((c) => c.version === '2.1.219' && !c.signedIn)).toBe(true);
      } finally {
        for (const dir of planted) fs.rmSync(dir, { recursive: true, force: true });
        invalidateInstalledVersionsCache('claude');
      }
    },
  );
});

describe('buildRotationDecisionEvent (the observability contract for a bad pick)', () => {
  // The whole point: when routing lands on a maxed/logged-out account, the
  // emitted rotation event must carry enough to say WHY from `agents events`
  // alone — the per-org identity, each candidate's freshness tier, its staleness,
  // and the pick reason. The old payload (version + counts) could not.
  type EventCandidate = {
    usageKey: string | null; email: string | null; tier: string;
    source: string | null; ageMs: number | null; capturedAt: string | null;
    eligible: boolean; excludedReason: string | null;
    windows: Array<{ key: string; usedPercent: number }>;
  };
  const byKey = (ev: ReturnType<typeof buildRotationDecisionEvent>, key: string) =>
    Object.values(ev.candidates as Record<string, EventCandidate>).find((c) => c.usageKey === key)!;

  it('records the pick identity, per-candidate tier/staleness, and a freshness tally', () => {
    const now = Date.now();
    const verified = candidate({ version: '2.1.219', usageKey: 'claude:org=verified',
      usageSnapshot: snapshotAt(new Date(now - 60_000), [{ key: 'week', usedPercent: 30 }]) });
    const stale = candidate({ version: '2.1.181', usageKey: 'claude:org=stale',
      usageSnapshot: snapshotAt(new Date(now - 26 * 3600_000), [{ key: 'week', usedPercent: 48 }]) });
    const blind = candidate({ version: '2.1.207', usageKey: 'claude:org=blind', usageSnapshot: null });
    const limited = candidate({ version: '2.1.170', usageKey: 'claude:org=limited',
      usageStatus: 'rate_limited' });

    const result: RotateResult = {
      picked: verified, healthy: [verified, stale, blind], excluded: [limited],
      usageUnverified: false,
    };
    const ev = buildRotationDecisionEvent(result, 'claude', 'balanced');

    // A verified-weighted pick, named by its per-ORG key (not the device-local version).
    expect(ev.pickReason).toBe('verified-weighted');
    expect((ev.picked as { usageKey: string; tier: string }).usageKey).toBe('claude:org=verified');
    expect((ev.picked as { tier: string }).tier).toBe('verified');
    // The freshness tally over the healthy pool disambiguates blind-vs-verified fleets.
    expect(ev.freshness).toEqual({ verified: 1, stale: 1, blind: 1 });
    expect(ev.candidatesTotal).toBe(4);

    // The stale row: past the 5-min window, so its number is NOT to be trusted —
    // a large ageMs next to `tier: stale` is exactly the post-mortem signal.
    const s = byKey(ev, 'claude:org=stale');
    expect(s.tier).toBe('stale');
    expect(s.ageMs!).toBeGreaterThan(5 * 60_000);
    expect(s.source).toBe('live');
    expect(s.windows).toEqual([{ key: 'week', usedPercent: 48 }]);

    // The blind row: no snapshot at all (a 403'd worker or never-synced harness).
    const b = byKey(ev, 'claude:org=blind');
    expect(b.tier).toBe('blind');
    expect(b.ageMs).toBeNull();
    expect(b.capturedAt).toBeNull();

    // The excluded row carries WHY it was excluded, next to the eligible ones.
    const l = byKey(ev, 'claude:org=limited');
    expect(l.eligible).toBe(false);
    expect(l.excludedReason).toBe('rate_limited');
    expect(byKey(ev, 'claude:org=verified').eligible).toBe(true);
  });

  // The two blockers PR #3320 review caught both lived at the emit()/sanitizer
  // boundary, which the in-memory assertions above never cross. This drives a
  // real emit() into a redirected sink and reads the persisted JSONL back, so a
  // regression that (a) redacts a field by name or (b) truncates the candidate
  // set is caught where it actually happens.
  it('survives the real emit() sanitizer: no redaction, no 10-cap, no shared-version collision', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rot-ev-'));
    const logPath = path.join(dir, 'events.jsonl');
    try {
      _resetForTest(logPath);
      // 15 candidates. An ARRAY would be truncated to 10 by sanitizeNested. And —
      // mirroring foldRegistryCandidates (RUSH-3182) — the first three SHARE one
      // `version` and carry a null `usageKey` (native login + two provider
      // accounts on the same runVersion); keying the map by version OR usageKey
      // would collapse them via Object.fromEntries. Index keys must keep all 15,
      // each distinguishable by accountKey.
      const pool = Array.from({ length: 15 }, (_, i) =>
        candidate({
          version: i < 3 ? '2.1.219' : `2.1.${i}`,
          accountKey: `claude:account=${i}`,
          usageKey: i < 3 ? null : `claude:org=${i}`,
          providerAccount: i < 3 && i > 0 ? `provider-${i}` : undefined,
          authVerdict: i === 0 ? 'revoked' : null,
        }));
      emit('rotation.resolved', buildRotationDecisionEvent(
        { picked: pool[0], healthy: pool, excluded: [], usageUnverified: false },
        'claude', 'balanced',
      ));

      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
      const rec = JSON.parse(lines[lines.length - 1]) as {
        candidates: Record<string, { accountKey: string; usageKey: string | null; credentialVerdict: unknown }>;
        candidatesTotal: number;
      };
      const entries = Object.values(rec.candidates);
      // All 15 persisted (not capped at 10, not collapsed by shared version).
      expect(entries).toHaveLength(15);
      expect(rec.candidatesTotal).toBe(15);
      // Every distinct account survived — including the 3 that share a version.
      expect(new Set(entries.map((c) => c.accountKey)).size).toBe(15);
      const revoked = entries.find((c) => c.accountKey === 'claude:account=0')!;
      // The verdict carries its real value, not the "[REDACTED]" sentinel it
      // would if the key still matched /auth/i.
      expect(revoked.credentialVerdict).toBe('revoked');
      expect(revoked.credentialVerdict).not.toBe('[REDACTED]');
      // A uuid-shaped org key is NOT mistaken for a token and redacted.
      expect(entries.find((c) => c.accountKey === 'claude:account=9')!.usageKey).toBe('claude:org=9');
    } finally {
      _resetForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the fallback the router was forced into (blind draw / refused)', () => {
    const blind = candidate({ version: '2.1.207', usageKey: 'claude:org=blind', usageSnapshot: null });
    const blindDraw = buildRotationDecisionEvent(
      { picked: blind, healthy: [blind], excluded: [], usageUnverified: true },
      'claude', 'balanced',
    );
    expect(blindDraw.pickReason).toBe('unverified-blind-draw');

    const refused = buildRotationDecisionEvent(
      { picked: blind, healthy: [blind], excluded: [], usageUnverified: true, noVerifiedUsage: true },
      'claude', 'balanced',
    );
    expect(refused.pickReason).toBe('refused-no-verified');
  });
});
