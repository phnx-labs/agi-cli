/**
 * Tests for the loop driver wired into executeJob (issue #400).
 *
 * Proves:
 *   1. A job with config.loop runs through runLoop (the loop driver is invoked,
 *      counting iterations via the injectable runIteration seam).
 *   2. A job without config.loop does NOT invoke the loop driver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { JobConfig } from '../src/lib/scheduling/routines.js';
import type { ExecOptions } from '../src/lib/exec.js';
import type { LoopDeps, IterationResult } from '../src/lib/loop.js';
import * as activation from '../src/lib/routine-activation.js';

// Hoist state the same way jobs.test.ts does (works with both vitest's hoist and Bun).
// The string literal is used inside vi.mock to avoid TDZ issues with const references.
interface LoopTestState { TEST_DIR: string }
const hoistedState: LoopTestState =
  ((globalThis as Record<string, unknown>)['__agents_cli_runner_loop_test_state__'] as LoopTestState | undefined)
  ?? (((globalThis as Record<string, unknown>)['__agents_cli_runner_loop_test_state__'] = { TEST_DIR: '' }) as LoopTestState);

// Partial mock: keep the real state.js exports (getModelsCachePath, loaded at
// models.ts import time, and getMailboxRootDir, used by runLoop) and override
// only the path getters to the isolated TEST_DIR. A full replacement drops
// those transitive exports and fails under vitest (the CI runner).
vi.mock('../src/lib/state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/state.js')>();
  const gt = globalThis as Record<string, unknown>;
  if (!gt['__agents_cli_runner_loop_test_state__']) {
    gt['__agents_cli_runner_loop_test_state__'] = { TEST_DIR: '' };
  }
  const state = () => gt['__agents_cli_runner_loop_test_state__'] as LoopTestState;
  return {
    ...actual,
    getRoutinesDir: () => join(state().TEST_DIR, 'routines'),
    getRunsDir: () => join(state().TEST_DIR, 'runs'),
    getUserAgentsDir: () => state().TEST_DIR,
    getCliVersionCachePath: () => join(state().TEST_DIR, '.cli-version-cache.json'),
    ensureAgentsDir: () => {},
    getProjectRoutinesDir: () => null,
    getMailboxRootDir: () => join(state().TEST_DIR, 'mailbox'),
  };
});

import { executeJob } from '../src/lib/daemon/runner.js';

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    name: 'loop-test-job',
    schedule: '0 9 * * *',
    agent: 'claude',
    mode: 'plan',
    effort: 'auto',
    timeout: '10m',
    enabled: true,
    prompt: 'iterate over the task',
    cwd: hoistedState.TEST_DIR,
    sandbox: false,  // skip HOME overlay so tests need no real filesystem setup
    ...overrides,
  };
}

function makeLoopDeps(calls: ExecOptions[]): LoopDeps {
  return {
    runIteration: async (o: ExecOptions): Promise<IterationResult> => {
      calls.push(o);
      return { exitCode: 0, tokens: 0 };
    },
    sleep: async () => {},
    writeCheckpoint: () => {},
  };
}

beforeEach(() => {
  hoistedState.TEST_DIR = mkdtempSync(join(tmpdir(), 'agents-runner-loop-'));
  mkdirSync(join(hoistedState.TEST_DIR, 'runs'), { recursive: true });
  vi.spyOn(activation, 'routineEnabledOnThisDevice').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(hoistedState.TEST_DIR, { recursive: true, force: true });
});

describe('executeJob — loop driver (issue #400)', () => {
  it('runs exactly maxIterations iterations through runLoop when config.loop is set', async () => {
    const calls: ExecOptions[] = [];
    const config = makeConfig({ loop: { maxIterations: 3, interval: '0' } });

    const result = await executeJob(config, makeLoopDeps(calls));

    expect(calls.length).toBe(3);
    expect(result.meta.status).toBe('completed');
    expect(result.meta.exitCode).toBe(0);
  });

  it('passes the resolved prompt through to each loop iteration', async () => {
    const calls: ExecOptions[] = [];
    const config = makeConfig({ loop: { maxIterations: 2, interval: '0' }, prompt: 'do the work' });

    await executeJob(config, makeLoopDeps(calls));

    // Iteration 1 gets the bare entrypoint; iterations >= 2 get the /continue prefix —
    // check that the entrypoint appears in every call.
    for (const call of calls) {
      expect(call.prompt).toContain('do the work');
    }
  });

  it('does NOT invoke the loop driver when config.loop is absent', async () => {
    const calls: ExecOptions[] = [];
    const deps = makeLoopDeps(calls);

    // No loop field — should go to the single-shot spawn path.
    // Use a sentinel agent which command construction rejects before a real spawn.
    const result = await executeJob(makeConfig({ agent: 'no-such-agent' as any }), deps);
    expect(result.meta.status).toBe('failed');
    expect(result.meta.errorMessage).toContain('Unsupported agent for daemon jobs');

    // Loop driver must not have been invoked.
    expect(calls.length).toBe(0);
  });

  it('stamps harnessName on loop ExecOptions for a custom-harness profile (PHNX-2935)', async () => {
    // The loop path resolves the profile to its host agent and spawns
    // in-process via runLoop — it never re-enters `agents run <name>`, so
    // ExecOptions.harnessName must be set here or a deepseek loop-routine
    // is recorded as claude.
    mkdirSync(join(hoistedState.TEST_DIR, 'profiles'), { recursive: true });
    writeFileSync(
      join(hoistedState.TEST_DIR, 'profiles', 'deepseek.yml'),
      'name: deepseek\nhost:\n  agent: claude\nenv:\n  ANTHROPIC_MODEL: deepseek/deepseek-chat-v3-0324\n',
    );
    const calls: ExecOptions[] = [];
    const result = await executeJob(makeConfig({
      agent: 'deepseek',
      loop: { maxIterations: 1, interval: '0' },
    }), makeLoopDeps(calls));

    expect(result.meta.status).toBe('completed');
    expect(calls.length).toBe(1);
    expect(calls[0].agent).toBe('claude');
    expect(calls[0].harnessName).toBe('deepseek');
  });

  it('marks status failed when runLoop stops with error', async () => {
    const config = makeConfig({ loop: { maxIterations: 5, interval: '0' } });
    const deps: LoopDeps = {
      runIteration: async (): Promise<IterationResult> => ({ exitCode: 1, tokens: 0 }),
      sleep: async () => {},
      writeCheckpoint: () => {},
    };

    const result = await executeJob(config, deps);

    expect(result.meta.status).toBe('failed');
    expect(result.meta.exitCode).toBe(1);
  });
});
