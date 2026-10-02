import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  bakeRoutineArgv,
  buildJobCommand,
  buildRoutineSpawnEnv,
  dispatchesViaAgentsRun,
  executeJob,
  executeJobDetached,
  pinJobBinary,
  resolveRoutineLaunch,
} from '../daemon/runner.js';
import { ROUTINE_AGENT_IDS } from '../agents.js';
import { readRunMeta } from '../scheduling/routines.js';
import { getRunsDir } from '../state.js';
import type { JobConfig } from '../scheduling/routines.js';
import { getBinaryPath, getVersionDir } from '../installations/versions.js';
import { rotationFailoverChain, type RotateCandidate, type RotateResult } from '../accounting/rotate.js';
import { AGENT_COMMANDS, detectRateLimit, buildExecCommand } from '../exec.js';
import * as activation from '../routine-activation.js';

beforeEach(() => {
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function baseJob(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'test-job',
    schedule: '0 9 * * 1-5',
    prompt: 'Do the task.',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    agent: 'claude',
    ...overrides,
  } as JobConfig;
}

describe('bakeRoutineArgv', () => {
  it('pins the six daemon skeletons that used to live in ROUTINE_AGENT_COMMANDS', () => {
    expect(ROUTINE_AGENT_IDS).toEqual(['claude', 'codex', 'cursor', 'kimi', 'droid', 'muse']);
    expect(bakeRoutineArgv('claude')).toEqual([
      'claude', '-p', '--verbose', '{prompt}', '--output-format', 'stream-json', '--permission-mode', 'plan',
    ]);
    expect(bakeRoutineArgv('codex')).toEqual(['codex', 'exec', '{prompt}', '--json']);
    expect(bakeRoutineArgv('cursor')).toEqual(['cursor-agent', '-p', '{prompt}', '--output-format', 'stream-json']);
    expect(bakeRoutineArgv('kimi')).toEqual(['kimi', '--prompt', '{prompt}', '--output-format', 'stream-json']);
    expect(bakeRoutineArgv('droid')).toEqual(['droid', 'exec', '{prompt}', '-o', 'stream-json']);
    expect(bakeRoutineArgv('muse')).toEqual(['muse', 'exec', '{prompt}', '--json']);
  });

  it('kimi keeps --prompt; AGENT_COMMANDS.kimi.promptFlag stays -p (not a silent merge)', () => {
    expect(AGENT_COMMANDS.kimi.promptFlag).toBe('-p');
    expect(bakeRoutineArgv('kimi')![1]).toBe('--prompt');
  });

  it('refuses harnesses the daemon does not fire locally', () => {
    expect(bakeRoutineArgv('gemini')).toBeUndefined();
    expect(bakeRoutineArgv('grok')).toBeUndefined();
  });
});

describe('buildJobCommand', () => {
  it('cursor default/write mode trusts the configured workspace without using --yolo', () => {
    const argv = buildJobCommand(baseJob({ agent: 'cursor', mode: 'auto' }), 'Do the task.');
    expect(argv).toContain('--trust');
    expect(argv).not.toContain('--yolo');
    expect(argv).not.toContain('-f');
  });

  it('bare-agent claude plan mode includes --permission-mode plan', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'plan' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('plan');
  });

  it('bare-agent claude edit mode includes --permission-mode acceptEdits', () => {
    const argv = buildJobCommand(baseJob({ agent: 'claude', mode: 'edit' }), 'Do the task.');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
  });

  it('workflow plan mode emits exact argv with no --non-interactive and no --permission-mode', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'plan' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'plan']);
    expect(argv).not.toContain('--non-interactive');
    expect(argv).not.toContain('--permission-mode');
  });

  it('workflow edit mode emits exact argv with --mode edit', () => {
    const argv = buildJobCommand(
      baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude', mode: 'edit' }),
      '<prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'autodev', '<prompt>', '--mode', 'edit']);
    expect(argv).not.toContain('--non-interactive');
  });

  it('resume emits `agents run <agent> --resume <id>` and reopens the session (not a fresh template)', () => {
    const argv = buildJobCommand(
      baseJob({ agent: 'claude', mode: 'skip', resume: 'sess-abc123' }),
      '<wake prompt>',
    );
    expect(argv).toEqual(['agents', 'run', 'claude', '--resume', 'sess-abc123', '<wake prompt>', '--mode', 'skip']);
    // Resume takes precedence over the fresh-agent template — none of its flags leak in.
    expect(argv).not.toContain('--permission-mode');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  // Regression: kimi daemon jobs run headless via `--prompt`, which cannot be
  // combined with --plan/--auto/--yolo (kimi aborts "Cannot combine --prompt
  // with --X"). Write-modes must omit the flag; plan must fail closed.
  it('kimi skip mode omits --yolo (incompatible with headless --prompt)', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'skip' }), 'Do the task.');
    expect(argv).toContain('--prompt');
    expect(argv).not.toContain('--yolo');
  });

  it('kimi auto mode omits --auto', () => {
    const argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'auto' }), 'Do the task.');
    expect(argv).not.toContain('--auto');
  });

  it('kimi plan mode downgrades to auto — no throw, no --plan (RUSH-1810)', () => {
    // Routines run headless; kimi's headlessPlan:false makes a plan request degrade
    // to auto (kimi -p auto-runs, carrying no startup-mode flag). Must not throw.
    let argv: string[] = [];
    expect(() => {
      argv = buildJobCommand(baseJob({ agent: 'kimi', mode: 'plan' }), 'Do the task.');
    }).not.toThrow();
    expect(argv).toContain('--prompt');
    expect(argv).not.toContain('--plan');
    expect(argv).not.toContain('--auto');
  });
});

describe('cursor loop routine mode warning', () => {
  it('emits --plan for cursor plan-mode routines now that headless plan is supported (RUSH-2101)', async () => {
    const config = baseJob({
      name: 'cursor-loop-plan-test',
      agent: 'cursor',
      version: '0.0.0-test',
      mode: 'plan',
      sandbox: false,
      loop: { maxIterations: 1 },
    });
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await executeJob(config, {
        runIteration: async (options) => {
          expect(options.version).toBeUndefined();
          const argv = buildExecCommand(options);
          expect(argv).toContain('--plan');
          expect(argv).toContain('--trust');
          expect(argv).not.toContain('-f');
          return { exitCode: 0, tokens: 0 };
        },
      });
      expect(write).not.toHaveBeenCalledWith(
        expect.stringContaining("[agents] routine cursor-loop-plan-test: cursor's read-only plan mode is not enabled in this build"),
      );
    } finally {
      write.mockRestore();
      fs.rmSync(path.join(getRunsDir(), config.name), { recursive: true, force: true });
    }
  });
});

describe('dispatchesViaAgentsRun — pin exclusion for `agents run` commands', () => {
  // Regression: resume commands start with 'agents' (the dispatcher), so binary-pinning
  // them rewrites cmd[0] -> the agent binary and yields a broken `<binary> run …`.
  // executeJob/executeJobDetached must skip pinning for these, exactly like workflow jobs.
  it('is true for resume and workflow jobs, false for a plain agent job', () => {
    expect(dispatchesViaAgentsRun(baseJob({ agent: 'claude', resume: 'sess-1' }))).toBe(true);
    expect(dispatchesViaAgentsRun(baseJob({ workflow: 'autodev', agent: undefined as unknown as 'claude' }))).toBe(true);
    expect(dispatchesViaAgentsRun(baseJob({ agent: 'claude' }))).toBe(false);
    expect(dispatchesViaAgentsRun(baseJob({ agent: 'claude', account: 'work' }))).toBe(true);
  });

  it('pinJobBinary would corrupt a resume command — proving why it must be excluded', () => {
    // A resume command: cmd[0] is the 'agents' dispatcher, not the agent binary.
    const resumeCmd = buildJobCommand(baseJob({ agent: 'claude', mode: 'skip', resume: 'sess-1' }), '<p>');
    expect(resumeCmd[0]).toBe('agents');
    // If pinJobBinary DID run on it and the version were installed, it would clobber
    // cmd[0] to the binary → `<binary> run claude …`. The guard is what prevents this.
    expect(dispatchesViaAgentsRun({ resume: 'sess-1' })).toBe(true);
  });
});

describe('executeJobDetached — spawn error handling', () => {
  const cleanupJobDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupJobDirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('marks run failed in meta.json on spawn error without throwing', async () => {
    // Seed an "installed" version whose binary path is a directory — pinJobBinary
    // rewrites to that absolute path, and spawn then fails with EISDIR/ENOENT so
    // the error handler rewrites meta. Guaranteed even when a real `codex` is on PATH.
    const version = '0.0.1-enoent-test';
    const versionDir = getVersionDir('codex', version);
    const binPath = getBinaryPath('codex', version);
    fs.mkdirSync(binPath, { recursive: true }); // directory where a file should be

    const config: JobConfig = {
      name: '__runner-test-enoent__',
      schedule: '0 0 * * *',
      agent: 'codex',
      version,
      mode: 'plan',
      effort: 'auto',
      timeout: '10m',
      enabled: true,
      prompt: 'test prompt',
      cwd: '~', // agent routines now need an execution anchor; home is a valid one
      sandbox: false,
    };

    cleanupJobDirs.push(path.join(getRunsDir(), config.name));

    try {
      const meta = await executeJobDetached(config);
      expect(meta.status).toBe('running');

      // The spawn error event is async and rewrites meta.json off the event
      // loop. A fixed sleep flakes on slow Windows CI (the event lands after
      // the window); poll for the terminal state up to 10s instead.
      let updated = readRunMeta(config.name, meta.runId);
      const deadline = Date.now() + 10_000;
      while ((updated?.status ?? 'running') === 'running' && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 50));
        updated = readRunMeta(config.name, meta.runId);
      }

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.exitCode).toBe(1);
      expect(updated!.completedAt).not.toBeNull();
    } finally {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('pinJobBinary (RUSH-1016 — absolute path, bypass bare shim)', () => {
  const version = '99.99.99-test';

  it('rewrites cmd[0] to the absolute binary when the version is installed', () => {
    const versionDir = getVersionDir('claude', version);
    const binaryPath = getBinaryPath('claude', version);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    try {
      const pinned = pinJobBinary(['claude', '-p', 'hi'], 'claude', version);
      expect(pinned[0]).toBe(binaryPath);
      expect(pinned.slice(1)).toEqual(['-p', 'hi']);
    } finally {
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('leaves cmd unchanged when version is missing or binary absent', () => {
    const cmd = ['claude', '-p', 'hi'];
    expect(pinJobBinary(cmd, 'claude', '0.0.0-missing')).toEqual(cmd);
    expect(pinJobBinary(cmd, 'claude', undefined)).toEqual(cmd);
  });
});

describe('resolveRoutineLaunch (RUSH-1016 — pin + failover chain)', () => {
  it('honors an explicit version pin and does not arm rotation failover', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({ name: 'pinned-job', version: '2.1.0', agent: 'claude' }),
    );
    expect(plan.pinned).toBe(true);
    expect(plan.rotation).toBeNull();
    expect(plan.chain).toEqual([{ agent: 'claude', version: '2.1.0' }]);
  });

  it('leaves workflow jobs without a version chain', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({
        name: 'wf-job',
        workflow: 'autodev',
        agent: undefined as unknown as 'claude',
      }),
    );
    expect(plan.chain).toEqual([]);
    expect(plan.pinned).toBe(false);
  });

  it('an explicit version pin coexists with a durable account credential', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({ name: 'both-pins', version: '2.1.0', account: 'work', agent: 'claude' }),
      process.cwd(),
      { resolveCredentialAccount: () => ({ env: { ANTHROPIC_API_KEY: 'test' } }) },
    );
    expect(plan.pinned).toBe(true);
    expect(plan.chain).toEqual([{ agent: 'claude', version: '2.1.0' }]);
  });

  it('resolves a legacy login-email account pin to its installed version', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({ name: 'oauth-account', account: 'person@example.com', agent: 'claude' }),
      process.cwd(),
      {
        findCredentialAccount: () => false,
        resolveCredentialAccount: () => { throw new Error('provider default must not preflight'); },
        resolveAccountVersion: async () => '2.1.9',
        readMeta: () => ({ accounts: { defaults: { claude: 'unavailable-provider-default' } } }),
      },
    );
    expect(plan).toEqual({
      chain: [{ agent: 'claude', version: '2.1.9' }],
      rotation: null,
      pinned: true,
      forwardAccount: true,
    });
  });

  it('fails closed instead of rotating when a native account pin is unavailable', async () => {
    let strategyCalled = false;
    const error = await resolveRoutineLaunch(
      baseJob({ name: 'missing-native', account: 'person@example.com', agent: 'claude' }),
      process.cwd(),
      {
        findCredentialAccount: () => false,
        resolveAccountVersion: async () => null,
        resolveRunVersion: async () => {
          strategyCalled = true;
          return { version: '2.1.219', rotation: null };
        },
      },
    ).then(() => null, (cause: unknown) => cause as Error);

    expect(error?.message).toContain("account 'person@example.com' is not signed in");
    expect(error?.message).toContain('refusing to rotate');
    expect(strategyCalled).toBe(false);
  });

  it('forwards a native identity through --account so two slots on one binary stay distinct', async () => {
    const config = baseJob({
      name: 'native-resume',
      account: 'person@example.com',
      agent: 'claude',
      resume: 'sess-1',
    });
    const launch = await resolveRoutineLaunch(config, process.cwd(), {
      findCredentialAccount: () => false,
      resolveAccountVersion: async () => '2.1.9',
    });

    expect(buildJobCommand(config, 'continue', launch.forwardAccount !== false)).toEqual([
      'agents', 'run', 'claude', '--resume', 'sess-1', 'continue', '--mode', 'plan',
      '--account', 'person@example.com',
    ]);
  });

  it('rejects a version pin that does not own the requested native identity', async () => {
    const error = await resolveRoutineLaunch(
      baseJob({
        name: 'wrong-native-version',
        account: 'person@example.com',
        agent: 'claude',
        version: '2.1.0',
      }),
      process.cwd(),
      {
        findCredentialAccount: () => false,
        resolveAccountVersion: async () => '2.1.9',
      },
    ).then(() => null, (cause: unknown) => cause as Error);

    expect(error?.message).toContain('signed in at claude@2.1.9, not pinned claude@2.1.0');
  });

  it('accepts a version pin only when that version owns the native identity', async () => {
    const plan = await resolveRoutineLaunch(
      baseJob({
        name: 'matching-native-version',
        account: 'person@example.com',
        agent: 'claude',
        version: '2.1.9',
      }),
      process.cwd(),
      {
        findCredentialAccount: () => false,
        resolveAccountVersion: async () => '2.1.9',
      },
    );

    expect(plan).toEqual({
      chain: [{ agent: 'claude', version: '2.1.9' }],
      rotation: null,
      pinned: true,
      forwardAccount: true,
    });
  });
});

describe('buildRoutineSpawnEnv', () => {
  it('pins Cursor XDG_CONFIG_HOME to the sandbox overlay', () => {
    const env = buildRoutineSpawnEnv(
      { HOME: '/tmp/cursor-overlay', PATH: '/usr/bin', XDG_CONFIG_HOME: '/real/config' },
      'cursor',
      undefined,
      undefined,
      '/tmp/cursor-overlay',
    );
    expect(env.XDG_CONFIG_HOME).toBe(path.join('/tmp/cursor-overlay', '.config'));
  });
  it('preserves Cursor XDG_CONFIG_HOME when no sandbox overlay exists', () => {
    const env = buildRoutineSpawnEnv(
      { HOME: '/home/real-user', PATH: '/usr/bin', XDG_CONFIG_HOME: '/opt/custom-cfg' },
      'cursor',
      undefined,
    );
    expect(env.XDG_CONFIG_HOME).toBe('/opt/custom-cfg');
  });
  it('pins CLAUDE_CONFIG_DIR for a versioned claude launch and preserves TZ', () => {
    const env = buildRoutineSpawnEnv(
      { HOME: '/tmp/overlay', PATH: '/usr/bin' },
      'claude',
      '2.1.0',
      'America/Los_Angeles',
    );
    expect(env.TZ).toBe('America/Los_Angeles');
    expect(env.CLAUDE_CONFIG_DIR).toContain(path.join('claude', '2.1.0'));
    expect(env.CLAUDE_CONFIG_DIR).toContain('.claude');
    expect(env.HOME).toBe('/tmp/overlay');
  });

  // The daemon holds no Claude token, so buildRoutineSpawnEnv does no claude-token
  // manipulation at all — it neither injects a per-account/ambient token nor drops
  // one. A routine authenticates through the pinned account's own CLAUDE_CONFIG_DIR
  // login, identical to interactive `agents run`.
  it('adds no CLAUDE_CODE_OAUTH_TOKEN — routines use the per-account CLAUDE_CONFIG_DIR login', () => {
    const env = buildRoutineSpawnEnv(
      { HOME: '/tmp/overlay', PATH: '/usr/bin' },
      'claude',
      '2.1.0',
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toContain(path.join('claude', '2.1.0'));
  });

  // The above passed everywhere a token was absent — which is every CI runner,
  // and why this shipped. On a provisioned box the daemon's own environment
  // carries CLAUDE_CODE_OAUTH_TOKEN, buildExecEnv spreads ambient process.env,
  // and every routine silently ran on that one shared rotating token instead of
  // the host's login. Set it for real so the assertion means something.
  it('drops an AMBIENT CLAUDE_CODE_OAUTH_TOKEN — the host login wins, not a shared token', () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-ambient-must-not-leak';
    try {
      const env = buildRoutineSpawnEnv({ HOME: '/tmp/overlay', PATH: '/usr/bin' }, 'claude', '2.1.0');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // and the routine still authenticates — via this box's own version home
      expect(env.CLAUDE_CONFIG_DIR).toContain(path.join('claude', '2.1.0'));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
    }
  });
});

describe('credit/rate-limit detect + failover chain composition (RUSH-1016)', () => {
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
      plan: 'Max',
      signedIn: true,
      lastActive: null,
      ...over,
    };
  }

  it('detectRateLimit matches credit/usage phrasing used in failover diagnostics', () => {
    expect(detectRateLimit('You have hit your usage limit')).toBe(true);
    expect(detectRateLimit('rate limit exceeded')).toBe(true);
    expect(detectRateLimit('quota exceeded for this org')).toBe(true);
    expect(detectRateLimit('ENOENT: no such file')).toBe(false);
  });

  it('rotationFailoverChain skips the primary and preserves healthy order', () => {
    const healthy = [
      candidate({ version: '2.1.143' }),
      candidate({ version: '2.1.142' }),
      candidate({ version: '2.1.141' }),
    ];
    const rotation: RotateResult = {
      picked: healthy[0],
      healthy,
      excluded: [candidate({ version: '2.1.140', usageStatus: 'out_of_credits' })],
    };
    const chain = rotationFailoverChain(rotation, '2.1.143');
    expect(chain.map((e) => e.version)).toEqual(['2.1.142', '2.1.141']);
    // Primary + failover is what resolveRoutineLaunch returns as chain.
    const full = [{ agent: 'claude' as const, version: '2.1.143' }, ...chain];
    expect(full[0].version).toBe('2.1.143');
    expect(full).toHaveLength(3);
  });
});
