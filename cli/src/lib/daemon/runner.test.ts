import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { activeRunSkipStreak, archiveRoutineTranscripts, assertRoutineAccountLocalForPlacement, buildHostDispatchOptions, buildJobCommand, buildRoutineSpawnEnv, dispatchPlacedJob, dispatchesViaAgentsRun, executeJob, executeJobDetached, launcherClaimPid, mergeRoutineProviderEnv, monitorRunningJobs, reapExitedRunningJobs, resolveRoutineLaunch, RoutineAlreadyRunningError, routineSpawnCwd, snapshotRoutineTranscriptBase } from './runner.js';
import { getRunDir, readRunMeta, writeRunMeta } from '../scheduling/routines.js';
import { getVersionDir, getVersionHomePath, invalidateInstalledVersionsCache } from '../installations/versions.js';
import { addAccount, addNativeAccount, bindAccount, removeAccount, resolveCredentialAccount, unbindAccount } from '../account-registry.js';
import { recordSlot, slotDir } from '../accounts/slots.js';
import type { JobConfig, RunMeta } from '../scheduling/routines.js';
import * as yaml from 'yaml';
import * as state from '../state.js';
import { hardDeprecationError } from '../agents.js';
import { writeAuthHealthEntries, authCacheKey } from '../auth-health.js';
import { machineId } from '../machine-id.js';
import type { RotateCandidate, RotateResult } from '../accounting/rotate.js';
import { saveTask, hostsCacheDir } from '../hosts/tasks.js';
import { _resetPerfDbForTest, aggregateSamples } from '../perf/db.js';
import * as activation from '../routine-activation.js';
import { query, _resetForTest } from '../feed/events.js';
import { useFreshSecretsHome } from '../../../tests/secrets-standalone.js';

// RUSH-2215: only process-group / real-spawn holder suites are POSIX-oriented.
// Pure command construction and path helpers must still run on Windows.
const describeSpawn = process.platform === 'win32' ? describe.skip : describe;

describe('buildRoutineSpawnEnv (PHNX-3406)', () => {
  it('pairs Claude operator HOME with the selected version config', () => {
    const overlay = path.join(os.tmpdir(), 'phnx3406-overlay');
    const version = '99.0.0-phnx3406';
    const env = buildRoutineSpawnEnv({ HOME: overlay, AGENTS_USER_DIR: state.getUserAgentsDir() }, 'claude', version, undefined, overlay);
    expect(env.HOME).toBe(process.env.AGENTS_REAL_HOME || os.homedir());
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(getVersionHomePath('claude', version), '.claude'));
  });
});


beforeEach(() => {
  // These tests pass synthetic definitions directly to the runner. Exercise
  // legacy definition eligibility explicitly instead of inheriting the host's
  // real device manifest from a reused local/CI worker.
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Remove every run directory for a job (its parent dir), best-effort. */
function cleanupJobRuns(jobName: string): void {
  const jobRunsDir = path.dirname(getRunDir(jobName, 'x'));
  try { fs.rmSync(jobRunsDir, { recursive: true, force: true }); } catch { /* nothing to clean */ }
}

function baseConfig(partial: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 3 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'do it',
    cwd: '~',
    ...partial,
  } as JobConfig;
}

describe('custom-harness routine jobs delegate to agents run (RUSH-2930)', () => {
  let harnessDir: string;
  beforeEach(() => {
    harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-harness-'));
    fs.mkdirSync(path.join(harnessDir, 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'profiles', 'deepseek.yml'),
      yaml.stringify({ name: 'deepseek', host: { agent: 'claude' }, env: { ANTHROPIC_MODEL: 'deepseek/deepseek-chat-v3-0324' } }),
    );
    vi.spyOn(state, 'getUserAgentsDir').mockReturnValue(harnessDir);
  });
  afterEach(() => {
    fs.rmSync(harnessDir, { recursive: true, force: true });
  });

  it('buildJobCommand delegates a custom harness to `agents run <name>` with mode and account', () => {
    const cmd = buildJobCommand(baseConfig({ agent: 'deepseek', mode: 'auto', account: 'openrouter-primary' }), 'do the thing');
    expect(cmd).toEqual(['agents', 'run', 'deepseek', 'do the thing', '--mode', 'auto', '--account', 'openrouter-primary']);
  });

  it('classifies a custom-harness job as dispatching via agents run (no binary pin, no account env injection)', async () => {
    const { dispatchesViaAgentsRun } = await import('./runner.js');
    expect(dispatchesViaAgentsRun({ agent: 'deepseek' })).toBe(true);
    expect(dispatchesViaAgentsRun({ agent: 'claude' })).toBe(false);
  });

  it('resolveRoutineLaunch resolves no version/account chain — the profile pins its own', async () => {
    const plan = await resolveRoutineLaunch(baseConfig({ agent: 'deepseek' }));
    expect(plan).toEqual({ chain: [], rotation: null, pinned: false });
  });
});

describe('routine model flags', () => {
  it.each([
    ['claude', '--model'],
    ['codex', '--model'],
    ['cursor', '--model'],
    ['kimi', '--model'],
    ['droid', '-m'],
    ['muse', '--model'],
  ] as const)('uses the canonical %s model flag', (agent, modelFlag) => {
    const cmd = buildJobCommand(baseConfig({
      agent,
      config: { model: 'test-model' },
    }), 'inspect');

    expect(cmd).toContain(modelFlag);
    expect(cmd[cmd.indexOf(modelFlag) + 1]).toBe('test-model');
  });
});

describe('Codex routine permission profiles', () => {
  it('keeps plan read-only with network and on-request approvals', () => {
    const cmd = buildJobCommand(baseConfig({ agent: 'codex', mode: 'plan' }), 'inspect');
    expect(cmd).toContain('approval_policy="on-request"');
    expect(cmd).toContain('default_permissions="agents-plan"');
    expect(cmd.join(' ')).toContain('extends = ":read-only"');
    expect(cmd.join(' ')).toContain('network = { enabled = true, allow_local_binding = true }');
  });

  it('uses the writable profile for edit and preserves explicit skip', () => {
    const edit = buildJobCommand(baseConfig({ agent: 'codex', mode: 'edit', allow: { dirs: ['/tmp/routine'] } }), 'edit');
    expect(edit).toContain('default_permissions="agents-edit"');
    expect(edit.join(' ')).toContain('"/tmp/routine" = true');
    expect(edit).not.toContain('--dangerously-bypass-approvals-and-sandbox');

    const skip = buildJobCommand(baseConfig({ agent: 'codex', mode: 'skip' }), 'skip');
    expect(skip).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(skip).not.toContain('default_permissions="agents-edit"');
  });
});

describe('routine spawn cwd', () => {
  it('uses the home directory when no project/cwd execution anchor is declared', () => {
    const cwd = routineSpawnCwd({ name: 'r' });
    expect(cwd).toBe(os.homedir());
    expect(fs.statSync(cwd).isDirectory()).toBe(true);
  });

  it('no longer infers a checkout from repo — repo is external identity, not a cwd', () => {
    // Removing repo→directory inference is the fix: `repo` is GitHub/cloud
    // identity only. A repo-only routine has no execution anchor, so it lands in
    // $HOME (and the readiness gate pauses such an agent routine before it fires).
    expect(routineSpawnCwd({ name: 'r', repo: 'phnx-labs/agents-cli' } as never)).toBe(os.homedir());
  });

  it('resolves an absolute-under-home cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.homedir(), '.routine-cwd-test-'));
    try {
      expect(routineSpawnCwd({ name: 'r', cwd: dir })).toBe(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describeSpawn('runner device enforcement', () => {
  const savedId = process.env.AGENTS_SYNC_MACHINE_ID;

  afterEach(() => {
    if (savedId === undefined) delete process.env.AGENTS_SYNC_MACHINE_ID;
    else process.env.AGENTS_SYNC_MACHINE_ID = savedId;
    cleanupJobRuns('test-job');
    cleanupJobRuns('guard-reject');
  });

  it('executeJob persists a skipped attempt when this machine is not in the devices allowlist', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ devices: ['yosemite-s0', 'mac-mini'] });
    const { meta } = await executeJob(config);
    expect(meta.status).toBe('skipped');
    expect(meta.skipReason).toBe('wrong_owner');
    expect(meta.errorMessage).toBe("Job 'test-job' can only run on: yosemite-s0, mac-mini");
  });

  it('executeJobDetached persists the canonical wrong-owner result without spawning', async () => {
    process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
    const config = baseConfig({ name: 'guard-reject', devices: ['yosemite-s0'] });

    const meta = await executeJobDetached(config);
    expect(meta.status).toBe('skipped');
    expect(meta.skipReason).toBe('wrong_owner');
    expect(meta.pid).toBeNull();
    expect(meta.errorMessage).toBe("Job 'guard-reject' can only run on: yosemite-s0");
  });
});


describeSpawn('runner hard-deprecation enforcement (RUSH-2202)', () => {
  afterEach(() => cleanupJobRuns('gemini-legacy'));

  it('executeJob blocks with a visible run record instead of building a gemini command', async () => {
    const config = baseConfig({ name: 'gemini-legacy', agent: 'gemini' });
    const { meta, reportPath } = await executeJob(config);

    expect(meta.status).toBe('blocked');
    expect(meta.exitCode).toBeNull();
    expect(meta.readiness?.code).toBe('agent_unavailable');
    expect(meta.agent).toBe('gemini');
    expect(meta.errorMessage).toBe(hardDeprecationError('gemini'));
    expect(reportPath).toBeNull();

    // The failure is persisted, not just returned — `agents routines runs` and
    // the daemon's own record-keeping see the same skip reason.
    const persisted = readRunMeta(config.name, meta.runId);
    expect(persisted?.status).toBe('blocked');
    expect(persisted?.errorMessage).toBe(hardDeprecationError('gemini'));
  });

  it('executeJobDetached blocks with a visible run record instead of spawning gemini', async () => {
    const config = baseConfig({ name: 'gemini-legacy', agent: 'gemini' });
    const meta = await executeJobDetached(config);

    expect(meta.status).toBe('blocked');
    expect(meta.exitCode).toBeNull();
    expect(meta.readiness?.code).toBe('agent_unavailable');
    expect(meta.pid).toBeNull();
    expect(meta.errorMessage).toBe(hardDeprecationError('gemini'));
  });

  it('gates hostStrategy: cloud too — gemini has no cloudProvider entry and would otherwise silently fall back to the default provider', async () => {
    // Regression for a gap a non-author review found: the gate used to sit
    // AFTER placement resolution, so a cloud-placed gemini routine reached
    // resolveProvider(undefined, 'gemini') — which finds no native
    // cloudProvider for gemini and falls back to the configured default
    // ('rush'), dispatching for real instead of refusing. The gate now runs
    // before placement is resolved at all, so this never reaches
    // executeJobOnCloud/resolveProvider.
    const config = baseConfig({ name: 'gemini-legacy', agent: 'gemini', hostStrategy: 'cloud' });
    const { meta, reportPath } = await executeJob(config);

    expect(meta.status).toBe('blocked');
    expect(meta.readiness?.code).toBe('agent_unavailable');
    expect(meta.errorMessage).toBe(hardDeprecationError('gemini'));
    expect(reportPath).toBeNull();
    // No cloud dispatch happened — no cloudTaskId/cloudProvider was ever set.
    expect(meta.cloudTaskId).toBeUndefined();
    expect(meta.cloudProvider).toBeUndefined();
  });
});


describeSpawn('runner fire-time auth preflight (PHNX-3415)', () => {
  // Proves the runner.ts WIRING, not just the extracted pure function
  // (routine-readiness.auth.test.ts covers fireTimeAuthReadiness in isolation): a
  // routine whose resolved account is provably signed out records a terminal
  // `blocked`/`agent_auth_failed` run — with the re-login repair, exitCode/pid
  // null, and nothing spawned — through the real executeJob/executeJobDetached
  // call sites, instead of a `failed` run that spawned and 401'd.
  //
  // A PINNED version resolves through `resolveRoutineLaunch` without a live
  // credential (the pin returns its own chain — runner.ts:1069), so the fire-time
  // cache preflight downstream is what's exercised; `sandbox: false` keeps the run
  // out of a version-home overlay it need not build. This is the real signed-out
  // pinned-routine scenario, not a synthetic one.
  afterEach(() => {
    cleanupJobRuns('auth-preflight-fg');
    cleanupJobRuns('auth-preflight-detached');
  });

  /** Seed the daemon-warmed auth-health cache (isolated HOME) for claude@version. */
  function seedAuth(version: string, verdict: 'revoked' | 'unconfigured', account?: string): void {
    writeAuthHealthEntries({
      [authCacheKey(machineId(), 'claude', version)]: { verdict, checkedAt: Date.now(), ...(account ? { account } : {}) },
    });
  }

  it('executeJob blocks a signed-out (revoked) pinned account with a visible run record — no spawn', async () => {
    const version = '9.3.101';
    seedAuth(version, 'revoked', 'bot@example.com');
    const config = baseConfig({ name: 'auth-preflight-fg', agent: 'claude', version, sandbox: false });
    const { meta, reportPath } = await executeJob(config);

    expect(meta.status).toBe('blocked');
    expect(meta.exitCode).toBeNull();
    expect(meta.pid).toBeNull();
    expect(meta.readiness?.code).toBe('agent_auth_failed');
    expect(meta.readiness?.repair).toBe(`agents run claude@${version} -- login`);
    expect(meta.errorMessage).toContain('agent_auth_failed');
    expect(reportPath).toBeNull();

    // Persisted, not just returned — `agents routines runs` sees the same block.
    const persisted = readRunMeta(config.name, meta.runId);
    expect(persisted?.status).toBe('blocked');
    expect(persisted?.readiness?.code).toBe('agent_auth_failed');
  });

  it('executeJobDetached blocks a signed-out (unconfigured) pinned account without spawning', async () => {
    const version = '9.3.102';
    seedAuth(version, 'unconfigured');
    const config = baseConfig({ name: 'auth-preflight-detached', agent: 'claude', version, sandbox: false });
    const meta = await executeJobDetached(config);

    expect(meta.status).toBe('blocked');
    expect(meta.exitCode).toBeNull();
    expect(meta.pid).toBeNull();
    expect(meta.readiness?.code).toBe('agent_auth_failed');
    expect(meta.readiness?.repair).toBe(`agents run claude@${version} -- login`);
  });
});


describeSpawn('runner host placement', () => {
  afterEach(() => {
    cleanupJobRuns('host-wf');
    cleanupJobRuns('host-loop');
  });

  it('executeJob records host+workflow as blocked before any dispatch', async () => {
    const config = baseConfig({ name: 'host-wf', host: 'gpu-box', workflow: 'autodev', agent: undefined as never });
    const { meta } = await executeJob(config);
    expect(meta.status).toBe('blocked');
    expect(meta.readiness?.code).toBe('placement_unsupported');
    expect(meta.errorMessage).toMatch(/workflow bundle, which can't execute on a host yet/);
  });

  it('executeJob records host+loop as blocked before any dispatch', async () => {
    const config = baseConfig({ name: 'host-loop', host: 'gpu-box', loop: { maxIterations: 3 } });
    const { meta } = await executeJob(config);
    expect(meta.status).toBe('blocked');
    expect(meta.readiness?.code).toBe('placement_unsupported');
    expect(meta.errorMessage).toMatch(/uses 'loop:', which can't execute on a host yet/);
  });

  it('monitorRunningJobs finalizes a host-placed run from its terminal sidecar (no local pid)', () => {
    // A terminal sidecar means reconcileTask returns without any ssh probe —
    // this exercises the exact daemon path that used to strand host runs at
    // 'running' forever (the monitor skipped every pid-less meta).
    const taskId = 'ffff0001';
    const jobName = 'host-monitor-test';
    const runId = 'run-hm-1';
    const eventsPath = path.join(os.tmpdir(), `agents-events-host-${process.pid}-${Date.now()}.jsonl`);
    _resetForTest(eventsPath);
    saveTask({
      id: taskId,
      host: 'gpu-box',
      target: 'taylor@gpu-box.tail.ts.net',
      agent: 'claude',
      prompt: 'p',
      remoteLog: `$HOME/.agents/.cache/hosts/${taskId}.log`,
      remoteExit: `$HOME/.agents/.cache/hosts/${taskId}.exit`,
      status: 'completed',
      exitCode: 0,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      host: 'gpu-box',
      hostTaskId: taskId,
    };
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    try {
      writeRunMeta(meta);
      monitorRunningJobs();
      const healed = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf-8')) as RunMeta;
      expect(healed.status).toBe('completed');
      expect(healed.exitCode).toBe(0);
      expect(healed.completedAt).not.toBeNull();
      const ends = query({ module: 'routine', eventTypes: ['routine.end'] });
      expect(ends).toHaveLength(1);
      expect(ends[0]).toMatchObject({
        event: 'routine.end',
        name: jobName,
        runId,
        status: 'completed',
        exitCode: 0,
      });
    } finally {
      fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
      fs.rmSync(path.join(hostsCacheDir(), `${taskId}.json`), { force: true });
      fs.rmSync(eventsPath, { force: true });
      _resetForTest();
    }
  });

  it('reapExitedRunningJobs finalizes a host-placed run via the async reconciler (no sync ssh on the tick)', async () => {
    // The daemon heartbeat tick reaches host-placed runs through the ASYNC path
    // (finalizeHostRunAsync → reconcileTaskAsync). A terminal sidecar returns
    // without any ssh probe, so this asserts the async path heals the record
    // identically to the sync monitorRunningJobs one (PHNX-3695).
    const taskId = 'ffff0002';
    const jobName = 'host-monitor-async-test';
    const runId = 'run-hm-async-1';
    const eventsPath = path.join(os.tmpdir(), `agents-events-host-async-${process.pid}-${Date.now()}.jsonl`);
    _resetForTest(eventsPath);
    saveTask({
      id: taskId,
      host: 'gpu-box',
      target: 'taylor@gpu-box.tail.ts.net',
      agent: 'claude',
      prompt: 'p',
      remoteLog: `$HOME/.agents/.cache/hosts/${taskId}.log`,
      remoteExit: `$HOME/.agents/.cache/hosts/${taskId}.exit`,
      status: 'completed',
      exitCode: 0,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    const meta: RunMeta = {
      jobName,
      runId,
      agent: 'claude',
      pid: null,
      spawnedAt: Date.now(),
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      exitCode: null,
      host: 'gpu-box',
      hostTaskId: taskId,
    };
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    try {
      writeRunMeta(meta);
      await reapExitedRunningJobs();
      const healed = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf-8')) as RunMeta;
      expect(healed.status).toBe('completed');
      expect(healed.exitCode).toBe(0);
      expect(healed.completedAt).not.toBeNull();
    } finally {
      fs.rmSync(path.dirname(runDir), { recursive: true, force: true });
      fs.rmSync(path.join(hostsCacheDir(), `${taskId}.json`), { force: true });
      fs.rmSync(eventsPath, { force: true });
      _resetForTest();
    }
  });
});

// Pure fs archive of overlay homes — no process-group ownership.
describe('routine transcript archiving', () => {
  const jobName = 'archive-routine-test';
  const runId = 'run-archive-1';

  afterEach(() => {
    cleanupJobRuns(jobName);
  });

  it('copies sandboxed agent transcripts into the stable run directory', () => {
    const overlayHome = path.join(getRunDir(jobName, runId), 'overlay-home');
    const sourceDir = path.join(overlayHome, '.claude', 'projects', 'tmp-project');
    const sourcePath = path.join(sourceDir, 'sess-archive.jsonl');
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, '{"type":"user","message":{"content":"hi"}}\n', 'utf-8');

    archiveRoutineTranscripts({ jobName, runId, agent: 'claude' }, runDir, overlayHome);
    fs.rmSync(overlayHome, { recursive: true, force: true });

    const archived = path.join(runDir, 'sessions', 'claude', 'projects', 'tmp-project', 'sess-archive.jsonl');
    expect(fs.readFileSync(archived, 'utf-8')).toContain('"content":"hi"');
  });

  // Regression: Kimi splits a session across state.json (metadata) and
  // agents/main/wire.jsonl (the actual conversation) — see
  // session/discover.ts:4382-4384. A ROUTINE_TRANSCRIPT_SPECS entry that only
  // matched `.json` archived the metadata shell and silently dropped every
  // message; both extensions must be captured.
  it('archives BOTH state.json and wire.jsonl for a kimi routine session', () => {
    const kimiJobName = 'archive-kimi-test';
    const kimiRunId = 'run-kimi-1';
    const overlayHome = path.join(getRunDir(kimiJobName, kimiRunId), 'overlay-home');
    const sessionDir = path.join(overlayHome, '.kimi-code', 'sessions', 'workdir-hash', 'session_abc123');
    const runDir = getRunDir(kimiJobName, kimiRunId);
    fs.mkdirSync(path.join(sessionDir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), '{"title":"demo"}', 'utf-8');
    fs.writeFileSync(
      path.join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      '{"role":"user","content":"the actual conversation"}\n',
      'utf-8',
    );

    try {
      archiveRoutineTranscripts({ jobName: kimiJobName, runId: kimiRunId, agent: 'kimi' }, runDir, overlayHome);

      const archivedState = path.join(runDir, 'sessions', 'kimi', 'sessions', 'workdir-hash', 'session_abc123', 'state.json');
      const archivedWire = path.join(runDir, 'sessions', 'kimi', 'sessions', 'workdir-hash', 'session_abc123', 'agents', 'main', 'wire.jsonl');
      expect(fs.readFileSync(archivedState, 'utf-8')).toContain('demo');
      expect(fs.readFileSync(archivedWire, 'utf-8')).toContain('the actual conversation');
    } finally {
      fs.rmSync(overlayHome, { recursive: true, force: true });
      cleanupJobRuns(kimiJobName);
    }
  });

  // RUSH-2271: a real Claude routine writes its transcript to the per-version
  // CLAUDE_CONFIG_DIR home (buildExecEnv, exec.ts), NOT the sandbox overlay the
  // archiver used to scan — so nothing was ever archived and the run never became
  // an origin='routine' session. The archiver now reads the version home, scoped by
  // a pre-spawn baseline so it copies ONLY this run's transcript out of that shared
  // home, never a sibling session's.
  it('archives a Claude routine transcript from the per-version home and excludes pre-existing sessions', () => {
    const jobName = 'archive-versionhome-test';
    const runId = 'run-vh-1';
    const version = '99.0.0-rush2271';
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    // Where a claude routine actually writes: <versionHome>/.claude/projects.
    const projects = path.join(getVersionHomePath('claude', version), '.claude', 'projects', 'proj');
    fs.mkdirSync(projects, { recursive: true });
    // A sibling session already in the shared home BEFORE this run — must never be
    // swept in and mis-tagged as this routine's.
    const preexisting = path.join(projects, 'sess-preexisting.jsonl');
    fs.writeFileSync(preexisting, '{"type":"user","message":{"content":"an earlier interactive session"}}\n', 'utf-8');

    const meta = { jobName, runId, agent: 'claude' as const, version };
    try {
      // 1) Baseline captured before the run spawns (records the pre-existing session).
      snapshotRoutineTranscriptBase(meta, runDir);
      // 2) The run produces its own transcript in the same shared home.
      const thisRun = path.join(projects, 'sess-thisrun.jsonl');
      fs.writeFileSync(thisRun, '{"type":"user","message":{"content":"the routine run"}}\n', 'utf-8');
      // 3) Archive.
      archiveRoutineTranscripts(meta, runDir);

      const archivedThisRun = path.join(runDir, 'sessions', 'claude', 'projects', 'proj', 'sess-thisrun.jsonl');
      const archivedPreexisting = path.join(runDir, 'sessions', 'claude', 'projects', 'proj', 'sess-preexisting.jsonl');
      expect(fs.readFileSync(archivedThisRun, 'utf-8')).toContain('the routine run');
      expect(fs.existsSync(archivedPreexisting)).toBe(false);
    } finally {
      fs.rmSync(getVersionHomePath('claude', version), { recursive: true, force: true });
      cleanupJobRuns(jobName);
    }
  });

  // RUSH-2271 failover: the single-shot loop spawns each chain entry's OWN version,
  // whose per-version home differs from chain[0]'s. When a run rate-limit-fails over to
  // a second account, the archiver must read the home the attempt that actually ran wrote
  // to — re-pointed via meta.version + a re-taken baseline before each attempt (runner.ts).
  it('archives the failover attempt\'s version home, not the first attempt\'s (RUSH-2271)', () => {
    const jobName = 'archive-failover-test';
    const runId = 'run-fo-1';
    const vA = '99.0.2-rush2271'; // first attempt (rate-limited)
    const vB = '99.0.3-rush2271'; // failover attempt that actually ran
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const projA = path.join(getVersionHomePath('claude', vA), '.claude', 'projects', 'p');
    const projB = path.join(getVersionHomePath('claude', vB), '.claude', 'projects', 'p');
    fs.mkdirSync(projA, { recursive: true });
    fs.mkdirSync(projB, { recursive: true });
    // A sibling session already in the failover home, and one in the first home.
    fs.writeFileSync(path.join(projB, 'old-B.jsonl'), '{"type":"user","message":{"content":"earlier B session"}}\n', 'utf-8');
    fs.writeFileSync(path.join(projA, 'old-A.jsonl'), '{"type":"user","message":{"content":"earlier A session"}}\n', 'utf-8');

    try {
      // Attempt 1 on version A: baseline A (rate-limits, writes nothing new).
      snapshotRoutineTranscriptBase({ jobName, runId, agent: 'claude', version: vA }, runDir);
      // Failover to version B: re-point meta.version + re-baseline B, then B runs.
      const metaB = { jobName, runId, agent: 'claude' as const, version: vB };
      snapshotRoutineTranscriptBase(metaB, runDir);
      fs.writeFileSync(path.join(projB, 'sess-B.jsonl'), '{"type":"user","message":{"content":"ran on B"}}\n', 'utf-8');
      archiveRoutineTranscripts(metaB, runDir);

      const archivedB = path.join(runDir, 'sessions', 'claude', 'projects', 'p', 'sess-B.jsonl');
      expect(fs.readFileSync(archivedB, 'utf-8')).toContain('ran on B');
      // Neither the failover home's earlier session nor the first attempt's home is swept in.
      expect(fs.existsSync(path.join(runDir, 'sessions', 'claude', 'projects', 'p', 'old-B.jsonl'))).toBe(false);
      expect(fs.existsSync(path.join(runDir, 'sessions', 'claude', 'projects', 'p', 'old-A.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(getVersionHomePath('claude', vA), { recursive: true, force: true });
      fs.rmSync(getVersionHomePath('claude', vB), { recursive: true, force: true });
      cleanupJobRuns(jobName);
    }
  });

  // Safety: a shared per-version home holds every session that version+account ran,
  // so with NO pre-spawn baseline the archiver cannot tell this run's transcript from
  // a sibling's — it must copy nothing rather than sweep them all in as origin='routine'.
  it('copies nothing from a shared version home when no baseline was recorded', () => {
    const jobName = 'archive-nobaseline-test';
    const runId = 'run-nb-1';
    const version = '99.0.1-rush2271';
    const runDir = getRunDir(jobName, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const projects = path.join(getVersionHomePath('claude', version), '.claude', 'projects', 'proj');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(path.join(projects, 'sess-orphan.jsonl'), '{"type":"user","message":{"content":"unrelated"}}\n', 'utf-8');

    const meta = { jobName, runId, agent: 'claude' as const, version };
    try {
      // No snapshotRoutineTranscriptBase() call → no baseline on disk.
      archiveRoutineTranscripts(meta, runDir);
      expect(fs.existsSync(path.join(runDir, 'sessions', 'claude'))).toBe(false);
    } finally {
      fs.rmSync(getVersionHomePath('claude', version), { recursive: true, force: true });
      cleanupJobRuns(jobName);
    }
  });
});

describeSpawn('command-mode routines (executeJob foreground)', () => {
  const jobs: string[] = [];
  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
  });

  /** A command-mode job (no agent) that runs a plain shell command. */
  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name,
      schedule: '0 3 * * *',
      command,
      mode: 'auto',
      effort: 'auto',
      timeout: '1m',
      enabled: true,
      // command routines carry no prompt; the runner never dereferences it.
      prompt: '',
    } as JobConfig;
  }

  it('runs a successful shell command → status completed, exitCode 0, no agent', async () => {
    const config = commandConfig('cmd-ok', 'exit 0');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('completed');
    expect(result.meta.exitCode).toBe(0);
    expect(result.meta.command).toBe('exit 0');
    expect(result.meta.agent).toBeUndefined();
    expect(result.meta.duration).toBeGreaterThanOrEqual(0);
    expect(result.meta.errorMessage).toBeUndefined();
    expect(result.reportPath).toBeNull();

    // A real run record was written and is readable from disk.
    const metaOnDisk = JSON.parse(
      fs.readFileSync(path.join(getRunDir('cmd-ok', result.meta.runId), 'meta.json'), 'utf-8'),
    );
    expect(metaOnDisk.status).toBe('completed');
    expect(metaOnDisk.command).toBe('exit 0');
    expect(metaOnDisk.agent).toBeUndefined();
    expect(metaOnDisk.duration).toBeGreaterThanOrEqual(0);
    expect(metaOnDisk.errorMessage).toBeUndefined();
  });

  it('propagates a non-zero exit → status failed, exitCode preserved', async () => {
    const config = commandConfig('cmd-fail', 'exit 3');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('failed');
    expect(result.meta.exitCode).toBe(3);
    expect(result.meta.command).toBe('exit 3');
    expect(result.meta.agent).toBeUndefined();
    expect(result.meta.duration).toBeGreaterThanOrEqual(0);
    expect(result.meta.errorMessage).toBeUndefined();
  });

  it('captures command stdout to the run log', async () => {
    const config = commandConfig('cmd-stdout', 'echo command-mode-ran');
    const result = await executeJob(config);

    expect(result.meta.status).toBe('completed');
    const log = fs.readFileSync(path.join(getRunDir('cmd-stdout', result.meta.runId), 'stdout.log'), 'utf-8');
    expect(log).toContain('command-mode-ran');
  });
});

describeSpawn('command-mode routines (executeJobDetached — daemon/cron path)', () => {
  const jobs: string[] = [];
  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
  });

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitTerminal(name: string, runId: string, ms = 4000): Promise<Record<string, unknown>> {
    const metaPath = path.join(getRunDir(name, runId), 'meta.json');
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (m.status !== 'running') return m;
      } catch { /* meta not yet written */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  }

  // Regression: a detached (daemon-scheduled) command run must record its REAL
  // terminal status. The first cut relied on monitorRunningJobs, which only infers
  // status for agent jobs — so every successful command cron run was mis-recorded
  // as 'failed'. child.on('exit') now writes the true status.
  it('records completed / exitCode 0 on a successful detached run (not failed)', async () => {
    const meta = await executeJobDetached(commandConfig('cmd-det-ok', 'exit 0'));
    const final = await waitTerminal('cmd-det-ok', meta.runId);
    expect(final.status).toBe('completed');
    expect(final.exitCode).toBe(0);
    expect(final.command).toBe('exit 0');
    expect(final.duration).toBeGreaterThanOrEqual(0);
    expect(final.errorMessage).toBeUndefined();
    expect(final.timeoutMs).toBe(60_000);
    // exit-code file is the posix restart-recovery source of truth (the sh subshell
    // wrapper writes it). Windows records status via child.on('exit') only — no file.
    if (process.platform !== 'win32') {
      expect(
        fs.readFileSync(path.join(getRunDir('cmd-det-ok', meta.runId), 'exit-code'), 'utf-8').trim(),
      ).toBe('0');
    }
  });

  it('records failed / exitCode 3 on a non-zero detached run', async () => {
    const meta = await executeJobDetached(commandConfig('cmd-det-fail', 'exit 3'));
    const final = await waitTerminal('cmd-det-fail', meta.runId);
    expect(final.status).toBe('failed');
    expect(final.exitCode).toBe(3);
    expect(final.duration).toBeGreaterThanOrEqual(0);
    expect(final.errorMessage).toBeUndefined();
  });

  it('allows only one detached execution — a second attempt is a skipped/active_run record, not a launch', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 600)"`;
    const config = commandConfig('cmd-det-single-flight', command.replace('600)', '5000)'));

    const first = await executeJobDetached(config);
    // The overlap no longer throws — it records a skipped attempt that links the
    // live run and launches nothing (the plan's non-overlap contract).
    const overlap = await executeJobDetached(config);
    expect(overlap.status).toBe('skipped');
    expect(overlap.skipReason).toBe('active_run');
    expect(overlap.activeRunId).toBe(first.runId);
    expect(overlap.pid).toBeNull();

    const final = await waitTerminal(config.name, first.runId, 7000);
    expect(final.status).toBe('completed');
  });

  it('a terminal (failed) record releases the slot even while its process is still live — the next fire proceeds (RUSH-2640)', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;
    const config = commandConfig('cmd-det-failed-live', command);
    const first = await executeJobDetached(config);
    // Mark the first run failed while its child is still alive — the exact shape
    // that used to wedge the slot forever (a failed/timeout record whose pid stays
    // live is treated as "active"). Reaping that orphaned process group is
    // reapTerminalRoutineProcesses's job, not a reason to keep the slot occupied.
    writeRunMeta({ ...first, status: 'failed', completedAt: new Date().toISOString(), exitCode: 1 });

    const overlap = await executeJobDetached(config);
    expect(overlap.skipReason).toBeUndefined();
    expect(overlap.status).not.toBe('skipped');
    expect(overlap.runId).not.toBe(first.runId);
    await waitTerminal(config.name, overlap.runId, 7000);
  });

  it('a failed run still carrying a live daemon-shaped pid no longer wedges every later slot (RUSH-2640)', async () => {
    const config = commandConfig('cmd-det-2640-failed', 'exit 0');
    // Reproduce the release-train wedge: a prior run reached `failed` while its
    // record still carries a pid that isPidOurs() always accepts. The daemon
    // stamps its OWN pid on the provisional claim and the daemon never dies, so
    // isPidOurs() can never go false — process.pid is exactly that shape here.
    const runId = 'wedged-failed-daemonpid';
    fs.mkdirSync(getRunDir(config.name, runId), { recursive: true });
    writeRunMeta({
      jobName: config.name,
      runId,
      command: 'exit 1',
      pid: process.pid,
      spawnedAt: Date.now() - process.uptime() * 1000,
      timeoutMs: 60_000,
      status: 'failed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitCode: 1,
    } as RunMeta);

    const meta = await executeJobDetached(config);
    // Unfixed: the failed+live-pid record reads as active → skipped/active_run,
    // and the routine never fires again. Fixed: the terminal state released it.
    expect(meta.skipReason).toBeUndefined();
    expect(meta.status).not.toBe('skipped');
    const final = await waitTerminal(config.name, meta.runId);
    expect(final.status).toBe('completed');
  });

  it('a stale running record past its own timeout no longer wedges the slot (RUSH-2640)', async () => {
    const config = commandConfig('cmd-det-2640-stale', 'exit 0');
    // The sandbox-tests/triage-tickets shape: a month-old `running` record with a
    // live pid and no spawnedAt, which isPidOurs() accepts for any live process.
    const runId = 'stale-running-nobirthtime';
    fs.mkdirSync(getRunDir(config.name, runId), { recursive: true });
    writeRunMeta({
      jobName: config.name,
      runId,
      command: 'sleep',
      pid: process.pid,
      timeoutMs: 60_000,
      status: 'running',
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    } as RunMeta);

    const meta = await executeJobDetached(config);
    expect(meta.skipReason).toBeUndefined();
    const final = await waitTerminal(config.name, meta.runId);
    expect(final.status).toBe('completed');
  });

  it('ignores a shadowing `agents` binary on PATH and runs the current CLI (RUSH-2431)', async () => {
    // Place a fake `agents` binary earlier on PATH than the real one. Without the
    // shell-function guard, the routine would run the fake and print "SHADOW".
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-shadow-'));
    const fakeAgents = path.join(tmpDir, 'agents');
    fs.writeFileSync(fakeAgents, '#!/bin/sh\necho SHADOW\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${savedPath ?? ''}`;
    try {
      const config = commandConfig('cmd-det-shadow', 'agents --version');
      const meta = await executeJobDetached(config);
      // The routine reaches a terminal state; its exit code depends on what the
      // real CLI does with `--version` in this environment, so the discriminating
      // signal is that the fake was NOT run — a broken guard would print SHADOW.
      const final = await waitTerminal('cmd-det-shadow', meta.runId);
      expect(['completed', 'failed']).toContain(final.status);
      const log = fs.readFileSync(path.join(getRunDir('cmd-det-shadow', meta.runId), 'stdout.log'), 'utf-8');
      expect(log).not.toContain('SHADOW');
    } finally {
      process.env.PATH = savedPath ?? '';
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('monitorRunningJobs kills a detached process after its persisted deadline', async () => {
    const jobName = 'cmd-det-restart-timeout';
    jobs.push(jobName);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const runId = 'restart-timeout-run';
    const meta: RunMeta = {
      jobName,
      runId,
      command: 'long-running command',
      pid: child.pid ?? null,
      spawnedAt: Date.now(),
      timeoutMs: 25,
      status: 'running',
      startedAt: new Date(Date.now() - 100).toISOString(),
      completedAt: null,
      exitCode: null,
    };
    fs.mkdirSync(getRunDir(jobName, runId), { recursive: true });
    writeRunMeta(meta);

    monitorRunningJobs();

    const final = JSON.parse(
      fs.readFileSync(path.join(getRunDir(jobName, runId), 'meta.json'), 'utf-8'),
    );
    expect(final.status).toBe('timeout');
    expect(final.errorMessage).toBe('exceeded configured timeout');
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed-out child stayed alive')), 1000)),
    ]);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  });
});

describe('RUSH-2640 scheduler slot release (pure paths)', () => {
  const jobs: string[] = [];
  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
  });

  it('launcherClaimPid records no pid when this process is the routines daemon', () => {
    const savedDaemonDir = process.env.AGENTS_DAEMON_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-'));
    process.env.AGENTS_DAEMON_DIR = tmp;
    try {
      // No daemon pid file: a short-lived foreground launcher records its own pid
      // so a crash between claim and spawn releases the slot fast.
      expect(launcherClaimPid()).toBe(process.pid);
      // The daemon pid file names THIS process → we ARE the daemon → record no
      // pid. The daemon never dies, so its pid must never anchor a run's claim
      // (it would wedge the slot forever and mis-aim the reaper — RUSH-2640).
      fs.writeFileSync(path.join(tmp, 'daemon.pid'), String(process.pid));
      expect(launcherClaimPid()).toBeNull();
      // A different daemon pid → this is a foreground launcher again → own pid.
      fs.writeFileSync(path.join(tmp, 'daemon.pid'), String(process.pid + 100_000));
      expect(launcherClaimPid()).toBe(process.pid);
    } finally {
      if (savedDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
      else process.env.AGENTS_DAEMON_DIR = savedDaemonDir;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('monitorRunningJobs ages out a running record with no pid past its timeout', () => {
    const jobName = 'cmd-2640-ageout-nopid';
    jobs.push(jobName);
    const runId = 'ageout-nopid';
    fs.mkdirSync(getRunDir(jobName, runId), { recursive: true });
    writeRunMeta({
      jobName,
      runId,
      command: 'noop',
      pid: null,
      spawnedAt: Date.now() - 10 * 60_000,
      timeoutMs: 60_000,
      status: 'running',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      completedAt: null,
      exitCode: null,
    } as RunMeta);

    monitorRunningJobs();

    // Unfixed: the `if (!meta.pid) continue` guard ran before the timeout check,
    // so a null-pid claim wedged as `running` forever. Fixed: it is aged out.
    const final = readRunMeta(jobName, runId);
    expect(final?.status).toBe('timeout');
    expect(final?.errorMessage).toBe('exceeded configured timeout');
  });

  it('activeRunSkipStreak counts only the trailing consecutive active_run skips', () => {
    const base = (over: Partial<RunMeta>): RunMeta => ({
      jobName: 'j', runId: 'r', command: 'c', pid: null,
      status: 'completed', startedAt: '', completedAt: '', exitCode: 0, ...over,
    } as RunMeta);
    expect(activeRunSkipStreak([])).toBe(0);
    expect(activeRunSkipStreak([
      base({ status: 'completed' }),
      base({ status: 'skipped', skipReason: 'active_run' }),
      base({ status: 'skipped', skipReason: 'active_run' }),
      base({ status: 'skipped', skipReason: 'active_run' }),
    ])).toBe(3);
    // A non-matching newest record breaks the streak.
    expect(activeRunSkipStreak([
      base({ status: 'skipped', skipReason: 'active_run' }),
      base({ status: 'completed' }),
    ])).toBe(0);
    // Only active_run counts — a wrong_owner/duplicate_slot skip is not a wedge.
    expect(activeRunSkipStreak([
      base({ status: 'skipped', skipReason: 'wrong_owner' }),
      base({ status: 'skipped', skipReason: 'active_run' }),
    ])).toBe(1);
  });
});

// Regression: executeJobDetached / executeCommandJobDetached (the daemon's
// normal firing path) never wrapped their settle() with createTimer(...).end(),
// unlike executeJob/executeJobOnCloud/executeJobOnHost — so every routine that
// actually fired off the daemon's own schedule emitted ZERO perf.timing
// samples, and `agents perf run` / `agents routines stats` had nothing to show
// for the most common firing path. Verifies against the REAL disposable perf
// warehouse (recordPerfTiming's dynamic import into perf/spool.ts respects the
// same _resetPerfDbForTest override db.test.ts uses), not a mock.
describeSpawn('detached routine fires record a perf.timing sample (agent.run)', () => {
  const jobs: string[] = [];
  let tmp: string;

  function commandConfig(name: string, command: string): JobConfig {
    jobs.push(name);
    return {
      name, schedule: '0 3 * * *', command,
      mode: 'auto', effort: 'auto', timeout: '1m', enabled: true, prompt: '',
    } as JobConfig;
  }

  async function waitForPerfSample(label: string, ms = 4000): Promise<ReturnType<typeof aggregateSamples>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const rows = aggregateSamples({ days: 1, kinds: ['perf.timing'], label });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-perf-'));
    process.env.AGENTS_PERF_DB = path.join(tmp, 'perf.db');
    _resetPerfDbForTest(process.env.AGENTS_PERF_DB);
  });

  afterEach(() => {
    for (const j of jobs.splice(0)) cleanupJobRuns(j);
    _resetPerfDbForTest(null);
    delete process.env.AGENTS_PERF_DB;
    delete process.env.AGENTS_PERF_SPOOL;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('executeCommandJobDetached records an agent.run sample with status + jobName on success', async () => {
    await executeJobDetached(commandConfig('cmd-perf-ok', 'exit 0'));
    const rows = await waitForPerfSample('agent.run');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('executeCommandJobDetached records the sample on a FAILED run too (not just success)', async () => {
    await executeJobDetached(commandConfig('cmd-perf-fail', 'exit 5'));
    const rows = await waitForPerfSample('agent.run');
    expect(rows.length).toBeGreaterThan(0);
  });
});

describeSpawn('resolveRoutineLaunch — per-routine strategy override (RUSH-2719)', () => {
  it('config.strategy is what resolveRunVersion receives, beating the firing box config', async () => {
    let seenStrategy: string | undefined;
    const plan = await resolveRoutineLaunch({ ...baseConfig(), strategy: 'available' }, process.cwd(), {
      resolveRunVersion: async (_agent, strategy) => {
        seenStrategy = strategy;
        return { version: '2.1.219', rotation: null };
      },
    });
    expect(seenStrategy).toBe('available');
    expect(plan.chain[0]).toMatchObject({ agent: 'claude', version: '2.1.219' });
  });

  it('an explicit version pin still short-circuits before any strategy resolution', async () => {
    let called = false;
    const plan = await resolveRoutineLaunch({ ...baseConfig(), version: '2.1.207' }, process.cwd(), {
      resolveRunVersion: async () => {
        called = true;
        return { version: 'x', rotation: null };
      },
    });
    expect(called).toBe(false);
    expect(plan.pinned).toBe(true);
    expect(plan.chain[0]).toEqual({ agent: 'claude', version: '2.1.207' });
  });
});

describeSpawn('resolveRoutineLaunch — zero-healthy accounts fail the routine loud (RUSH-2132)', () => {
  function acct(version: string): RotateCandidate {
    return {
      agent: 'claude',
      version,
      accountKey: `claude:account=${version}`,
      accountLabel: `${version}@example.com`,
      email: `${version}@example.com`,
      usageKey: `claude:org=${version}`,
      usageStatus: 'rate_limited',
      usageSnapshot: null,
      usageError: null,
      plan: 'Max',
      signedIn: true,
      lastActive: null,
    };
  }

  it('throws the watchdog contract error (no healthy + resets + pinned escape hatch) when the strategy exhausts', async () => {
    const err = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.207', rotation: null, exhausted: [acct('2.1.207')] }),
    }).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/no healthy claude account under strategy '\w+'/);
    expect(err!.message).toContain('excluded: 2.1.207 (rate_limited)');
    expect(err!.message).toContain('resets');
    expect(err!.message).toContain('Use --strategy pinned to force the default.');
  });

  it('an unattended routine fails loud with NO_VERIFIED_USAGE when every account is stale (PHNX-2526)', async () => {
    // No picker exists for a routine, so entirely-stale usage is a hard fail —
    // never a silent launch on the stale default that would hammer it each tick.
    const stale = { ...acct('2.1.219'), usageStatus: 'available' as const };
    const rotation: RotateResult = { picked: stale, healthy: [stale], excluded: [] };
    const err = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: null, rotation, noVerifiedUsage: true }),
    }).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain('NO_VERIFIED_USAGE');
    expect(err!.message).toMatch(/strategy '\w+'/);
  });

  it('a healthy pick proceeds with the rotated version (no throw)', async () => {
    const healthy = { ...acct('2.1.219'), usageStatus: 'available' as const };
    const rotation: RotateResult = { picked: healthy, healthy: [healthy], excluded: [] };
    const plan = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.219', rotation }),
    });
    expect(plan.chain[0]).toMatchObject({ agent: 'claude', version: '2.1.219' });
    expect(plan.rotation).toBe(rotation);
  });

  it('retains both same-binary account slots without probing a legacy home', async () => {
    const first = { ...acct('2.1.219'), nativeAccount: 'first', slotDir: '/slots/first' };
    const second = { ...acct('2.1.219'), nativeAccount: 'second', slotDir: '/slots/second' };
    const rotation: RotateResult = { picked: second, healthy: [first, second], excluded: [] };
    const plan = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: second.version, rotation }),
    });
    expect(plan.chain.map((entry) => entry.account)).toEqual(['second', 'first']);
    expect(plan.chain[0].candidate).toBe(second);
  });

  it('a non-exhausted null rotation (pinned-shaped) proceeds with the resolved version — unchanged', async () => {
    const plan = await resolveRoutineLaunch(baseConfig(), process.cwd(), {
      resolveRunVersion: async () => ({ version: '2.1.207', rotation: null }),
    });
    expect(plan.chain[0]).toEqual({ agent: 'claude', version: '2.1.207' });
    expect(plan.rotation).toBeNull();
  });

  it('fails closed when a routine account cannot authenticate its harness', async () => {
    let strategyCalled = false;
    const err = await resolveRoutineLaunch({ ...baseConfig(), agent: 'codex', account: 'work' }, process.cwd(), {
      resolveCredentialAccount: (name, host) => {
        throw new Error(`Account '${name}' cannot authenticate the ${host} harness.`);
      },
      resolveRunVersion: async () => {
        strategyCalled = true;
        return { version: '0.1.0', rotation: null };
      },
    }).then(() => null, (error: unknown) => error as Error);
    expect(err?.message).toBe("Account 'work' cannot authenticate the codex harness.");
    expect(strategyCalled).toBe(false);
  });

  it('a native routine account pins the installed version by its identity and forwards --account', async () => {
    const meta = { accounts: { native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'claude:user=1', scope: 'version' as const } } } };
    let askedIdentity: string | undefined;
    const plan = await resolveRoutineLaunch({ ...baseConfig(), account: 'work' }, process.cwd(), {
      findCredentialAccount: () => false, // 'work' is native, not a provider credential
      readMeta: () => meta as never,
      resolveAccountVersion: async (_agent, identity) => { askedIdentity = identity; return '2.1.220'; },
    });
    // The durable name was translated to the identity key before matching...
    expect(askedIdentity).toBe('claude:user=1');
    // ...and the run pins that install while forwarding `--account` so two
    // slots sharing one managed binary still select this login.
    expect(plan).toMatchObject({ pinned: true, forwardAccount: true, chain: [{ agent: 'claude', version: '2.1.220' }] });
  });

  it('a native routine account named for another harness fails closed', async () => {
    const meta = { accounts: { native: { n1: { id: 'n1', name: 'work', agent: 'claude' as const, identityKey: 'k', scope: 'version' as const } } } };
    const err = await resolveRoutineLaunch({ ...baseConfig(), agent: 'codex', account: 'work' }, process.cwd(), {
      findCredentialAccount: () => false,
      readMeta: () => meta as never,
      resolveAccountVersion: async () => '1.0.0',
    }).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain('is a claude login and cannot authenticate codex');
  });
});

describe('native slot routine dispatch (PHNX-3940 T5)', () => {
  const suffix = `t5run-${Date.now()}`;
  const planted: string[] = [];
  const names: string[] = [];
  const slotIds: string[] = [];

  function writeClaudeCred(home: string, email: string) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: {
          emailAddress: email,
          accountUuid: `acct-${email}`,
          organizationUuid: `org-${email}`,
          organizationType: 'claude_max',
        },
      }),
    );
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 86_400_000 } }),
    );
  }

  afterEach(() => {
    for (const n of names) {
      try { removeAccount(n); } catch { /* already gone */ }
    }
    names.length = 0;
    for (const p of planted) fs.rmSync(p, { recursive: true, force: true });
    planted.length = 0;
    if (slotIds.length > 0) {
      state.updateMeta((m) => {
        const slots = { ...m.deviceAccounts?.slots };
        for (const id of slotIds) delete slots[id];
        return { ...m, deviceAccounts: { ...m.deviceAccounts, slots } };
      });
      slotIds.length = 0;
    }
    invalidateInstalledVersionsCache('claude');
  });

  it('forwards --account so two native slots on one harness launch the selected one', async () => {
    const label = `99.0.0-t5run-${suffix}`;
    const dir = getVersionDir('claude', label);
    const pkgRoot = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(path.join(pkgRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: '@anthropic-ai/claude-code', version: label, bin: { claude: 'bin/claude-launcher' },
    }));
    fs.writeFileSync(path.join(pkgRoot, 'bin', 'claude-launcher'), 'REAL BINARY');
    planted.push(dir);
    invalidateInstalledVersionsCache('claude');

    const workEmail = `work-${suffix}@example.com`;
    const personalEmail = `personal-${suffix}@example.com`;
    const work = addNativeAccount(`work-${suffix}`, 'claude', `claude:account=acct-${workEmail}:org=org-${workEmail}`, workEmail, 'version');
    const personal = addNativeAccount(`personal-${suffix}`, 'claude', `claude:account=acct-${personalEmail}:org=org-${personalEmail}`, personalEmail, 'version');
    names.push(work.name, personal.name);
    slotIds.push(work.id, personal.id);
    const workDir = slotDir('claude', work.id);
    const personalDir = slotDir('claude', personal.id);
    planted.push(workDir, personalDir);
    writeClaudeCred(workDir, workEmail);
    writeClaudeCred(personalDir, personalEmail);
    recordSlot(work.id, { accountId: work.id, slotDir: workDir, authMode: 'native', verdict: 'live' });
    recordSlot(personal.id, { accountId: personal.id, slotDir: personalDir, authMode: 'native', verdict: 'live' });

    const config = baseConfig({ name: `slot-pin-${suffix}`, account: work.name });
    const plan = await resolveRoutineLaunch(config, process.cwd(), {
      findCredentialAccount: () => false,
    });
    expect(plan.pinned).toBe(true);
    expect(plan.forwardAccount).toBe(true);
    expect(plan.chain[0]?.agent).toBe('claude');
    const cmd = buildJobCommand(config, 'do it', plan.forwardAccount !== false);
    expect(cmd.slice(0, 3)).toEqual(['agents', 'run', 'claude']);
    expect(cmd.slice(-2)).toEqual(['--account', work.name]);
    expect(cmd[2]).not.toContain(personal.name);
  });
});

describe('provider-pinned routine keeps injected env (PHNX-3940 T5 seam / T7)', () => {
  const name = `t7-prov-${Date.now().toString(36)}`;

  useFreshSecretsHome();

  afterEach(() => {
    try { unbindAccount(name, 'claude', 'claude'); } catch { /* not bound */ }
    state.updateMeta((m) => {
      const defaults = { ...m.accounts?.defaults };
      if (defaults.claude === name) delete defaults.claude;
      const bindings = { ...m.accounts?.bindings };
      delete bindings.claude;
      return { ...m, accounts: { ...m.accounts, defaults, bindings } };
    });
    try { removeAccount(name); } catch { /* already gone */ }
  });

  it('delegates provider materialization to agents run', () => {
    addAccount(name, 'openrouter', 'api-key', 'sk-t7-provider-secret');
    expect(dispatchesViaAgentsRun({ agent: 'claude', account: name })).toBe(true);
    expect(dispatchesViaAgentsRun({ agent: 'claude', account: `native-${name}` })).toBe(true);

    const cmd = buildJobCommand(baseConfig({ name: `job-${name}`, account: name }), 'do it');
    expect(cmd[0]).toBe('agents');
    expect(cmd.slice(-2)).toEqual(['--account', name]);
    expect(cmd.join(' ')).not.toContain(`#${name}`);

    const resolved = resolveCredentialAccount(name, 'claude');
    expect(resolved.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-t7-provider-secret');
    const injected = mergeRoutineProviderEnv({ PATH: '/bin' }, { agent: 'claude', account: name }, 'claude');
    expect(injected.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(injected.PATH).toBe('/bin');
  });

  it('injects env for a routine with no explicit account when the harness default is a provider account', () => {
    addAccount(name, 'openrouter', 'api-key', 'sk-t7-provider-secret');
    state.updateMeta((m) => ({
      ...m,
      accounts: { ...m.accounts, defaults: { ...m.accounts?.defaults, claude: name } },
    }));
    const injected = mergeRoutineProviderEnv({ PATH: '/bin' }, { agent: 'claude' }, 'claude');
    expect(injected.ANTHROPIC_AUTH_TOKEN).toBe('sk-t7-provider-secret');
    expect(injected.PATH).toBe('/bin');
  });

  it('injects env for a routine with no explicit account when a bare-agent binding points at a provider account', () => {
    addAccount(name, 'openrouter', 'api-key', 'sk-t7-provider-secret');
    bindAccount(name, 'claude', 'claude');
    const injected = mergeRoutineProviderEnv({ PATH: '/bin' }, { agent: 'claude' }, 'claude');
    expect(injected.ANTHROPIC_AUTH_TOKEN).toBe('sk-t7-provider-secret');
    expect(injected.PATH).toBe('/bin');
  });
});

describe('assertRoutineAccountLocalForPlacement — native accounts never dispatch off-box', () => {
  // Called at the top of BOTH the foreground (executeJobPlaced) and detached
  // (executeJobDetachedClaimed) placement blocks, before host/cloud dispatch.
  it('allows a host to resolve its own provisioned native slot', async () => {
    await expect(
      assertRoutineAccountLocalForPlacement({ name: 'r', account: 'work' }, 'host', { account: { kind: 'native', id: 'n', name: 'work', agent: 'claude', identityKey: 'k', scope: 'version' } }),
    ).resolves.toBeUndefined();
  });

  it('rejects a native routine account before a cloud dispatch', async () => {
    await expect(
      assertRoutineAccountLocalForPlacement({ name: 'r', account: 'work' }, 'cloud', { account: { kind: 'native', id: 'n', name: 'work', agent: 'codex', identityKey: 'k', scope: 'version' } }),
    ).rejects.toThrow('cannot run on a cloud placement');
  });

  it('rejects an unknown routine account before host or cloud dispatch', async () => {
    await expect(
      assertRoutineAccountLocalForPlacement({ name: 'r', account: 'typo' }, 'host', { account: null }),
    ).rejects.toThrow("account 'typo' is unknown");
    await expect(
      assertRoutineAccountLocalForPlacement({ name: 'r', account: 'typo' }, 'cloud', { account: null }),
    ).rejects.toThrow("account 'typo' is unknown");
  });

  it('the host dispatch boundary forwards the provider account by name (not dropped)', () => {
    // executeJobOnHost builds its dispatch options here; the account MUST ride
    // along or the remote runs under the wrong identity (the review regression).
    const opts = buildHostDispatchOptions(
      { name: 'r', agent: 'claude', account: 'prov', prompt: 'hello', mode: 'auto' } as never,
      { remoteCwd: '/w', runDir: '/run', detached: false },
    );
    expect(opts.account).toBe('prov');
    expect(opts.agent).toBe('claude');
    expect(opts.remoteCwd).toBe('/w');
    expect(opts.follow).toBe(true);
    // No account configured → nothing forwarded.
    const bare = buildHostDispatchOptions({ name: 'r', agent: 'claude', prompt: 'x', mode: 'auto' } as never, { remoteCwd: '/w', runDir: '/run', detached: true });
    expect(bare.account).toBeUndefined();
    expect(bare.follow).toBe(false);
  });

  it('fails a provider cloud placement before calling the cloud dispatcher', async () => {
    const provider = { kind: 'provider' as const, id: 'p', name: 'prov', provider: 'openrouter', auth: 'api-key' as const, secretRef: 'r' };
    let cloudDispatches = 0;
    await expect(dispatchPlacedJob(
      baseConfig({ name: 'provider-cloud', account: 'prov', hostStrategy: 'cloud' }),
      { mode: 'cloud' },
      { runId: 'provider-cloud-run', stamp: {} } as never,
      {
        account: provider,
        cloud: async () => {
          cloudDispatches += 1;
          throw new Error('cloud dispatch must not run');
        },
      },
    )).rejects.toThrow('cloud placement cannot securely inject it');
    expect(cloudDispatches).toBe(0);
  });

  it('allows a provider account on host (forwarded by name), rejects it on cloud, no-ops without an account', async () => {
    const provider = { kind: 'provider' as const, id: 'p', name: 'prov', provider: 'openrouter', auth: 'api-key' as const, secretRef: 'r' };
    // Host: allowed — the remote resolves its own bundle from the forwarded name.
    await expect(assertRoutineAccountLocalForPlacement({ name: 'r', account: 'prov' }, 'host', { account: provider })).resolves.toBeUndefined();
    // Cloud: fails loud — no secure provider-account injection there yet.
    await expect(assertRoutineAccountLocalForPlacement({ name: 'r', account: 'prov' }, 'cloud', { account: provider }))
      .rejects.toThrow('cloud placement cannot securely inject it');
    await expect(assertRoutineAccountLocalForPlacement({ name: 'r' }, 'host', {})).resolves.toBeUndefined();
  });
});
