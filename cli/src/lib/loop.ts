/**
 * Autonomous loop driver (issue #332).
 *
 * Re-injects an entrypoint each iteration until a stop condition is met. The
 * driver is the deterministic skeleton; the entrypoint inside stays dynamic (it
 * can spawn subagents freely). Every guard — `max_iterations`, `budget`, the
 * `until: signal` condition, SIGINT/SIGTERM — lives OUTSIDE the agent, so the
 * agent cannot vote past a kill-switch (the standard answer to runaway-loop and
 * runaway-cost failure modes; see docs/execution.md).
 *
 * Structure mirrors the teams supervisor (`runSupervisor` in teams/supervisor.ts):
 * a bounded for-loop with a hard cap, a SIGINT/SIGTERM trap that flips a stop
 * flag, a per-iteration guard check, an interval sleep, and a typed `stoppedBy`
 * union for the exit reason.
 *
 * Token accounting: the budget cap is a TOKEN hard-cap, enforced after each
 * turn from the usage events parsed off the agent's stream-json output. Token
 * extraction reuses `extractUsageEvents` from budget/enforce.ts (read-only
 * import) rather than re-implementing the per-provider parsing.
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './types.js';
import type { ExecOptions } from './exec.js';
import { buildExecCommand, buildExecEnv } from './exec.js';
import { extractUsageEvents } from './budget/enforce.js';
import { parseTimeout } from './scheduling/routines.js';
import { writeCheckpoint, type Checkpoint } from './checkpoint.js';
import { mailboxDir } from './mailbox.js';
import { composeWin32CommandLine } from './platform/index.js';

/** Loop block config; see docs/execution.md. */
export interface LoopConfig {
  /** Stop condition. `signal` reads loop-signal.json; absence is fail-closed. */
  until?: 'signal';
  /** Hard cap on iterations. */
  maxIterations?: number;
  /** Token hard-cap, enforced outside the agent. */
  budget?: number;
  /** Delay between iterations: "0" back-to-back, "30m" paces. */
  interval?: string;
}

/** The loop-signal.json contract the entrypoint writes each iteration. */
export interface LoopSignal {
  continue: boolean;
  reason?: string;
}

/** Why the loop stopped. Mirrors the teams supervisor exit reasons. */
export type LoopStoppedBy =
  | 'condition-met'
  | 'budget'
  | 'stalled'
  | 'max'
  | 'signal'
  | 'error';

/** Result of a loop run. */
interface LoopResult {
  /** Iterations actually executed. */
  iterations: number;
  stoppedBy: LoopStoppedBy;
  elapsedMs: number;
  /** Cumulative tokens consumed across all iterations. */
  tokens: number;
  /** Last loop-signal read, if any. */
  lastSignal?: LoopSignal;
}

/** What a single iteration's run function returns. */
export interface IterationResult {
  exitCode: number;
  /** Tokens consumed this iteration (input + output + cache). */
  tokens: number;
}

/** Per-iteration run function — the injectable seam that makes the driver testable. */
export type RunIteration = (options: ExecOptions) => Promise<IterationResult>;

/** Context the driver needs that isn't part of ExecOptions. */
export interface LoopContext {
  runId: string;
  runDir: string;
  agent: AgentId;
  version?: string;
  /** Iteration to start at (1 for a fresh run, checkpoint.iteration+1 for a resume). */
  startIteration?: number;
  /** Tokens already consumed before this driver started (carried across a resume). */
  startTokens?: number;
  /**
   * On a resume, the killed run's LAST iteration session id. The first resumed
   * iteration `/continue`s from it to thread conversation memory forward.
   * Undefined on a fresh run (iteration 1 mints its own id, no prior to continue).
   */
  sessionId?: string;
}

/** Dependency seams for testing. */
export interface LoopDeps {
  /** Per-iteration runner. Defaults to a token-capturing spawn (defaultRunIteration). */
  runIteration?: RunIteration;
  /** Sleep function (ms). Defaults to setTimeout-backed. Injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Checkpoint writer. Defaults to writeCheckpoint. */
  writeCheckpoint?: (c: Checkpoint) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Path to a run's loop-signal.json. */
export function loopSignalPath(runDir: string): string {
  return path.join(runDir, 'loop-signal.json');
}

/**
 * Build the prompt for iteration >= 2 so the agent CONTINUES the prior
 * iteration's conversation instead of starting fresh.
 *
 * This reuses the repo's established cross-process Claude-continuity mechanism —
 * the `/continue <id>` skill (see `buildFallbackPrompt` in exec.ts, which hands
 * a rate-limit successor `/continue ${prevSessionId}`). The skill loads the
 * prior transcript via `agents sessions <id>`, so continuity does NOT depend on
 * the provider's native session being "active"; it reads the transcript off
 * disk. That is why each loop iteration can safely pin a FRESH session id (the
 * `--session-id` flag CREATES a session — re-passing one errors "Session ID
 * already in use") while still threading the conversation forward via the
 * prior id.
 *
 * The original entrypoint is re-appended after the continue directive so the
 * agent both recalls the prior turn AND knows what to do this iteration.
 */
export function buildLoopContinuePrompt(prevSessionId: string, entrypoint: string): string {
  return buildContinuePrompt(prevSessionId, entrypoint);
}

/**
 * The universal (Tier-2) resume directive: a `/continue <id>` first message that
 * tells the agent to load the prior transcript via `agents sessions <id>` and
 * pick up. Works for ANY agent that ships the `/continue` command — the resume
 * path for agents without a native `--resume` (gemini, grok, opencode, …). An
 * optional follow-on prompt is appended after a blank line; omitted when empty so
 * a bare resume sends just the directive.
 */
export function buildContinuePrompt(sessionId: string, prompt?: string): string {
  const directive = `/continue ${sessionId}`;
  return prompt && prompt.trim() ? `${directive}\n\n${prompt}` : directive;
}

/**
 * Resolve a loop interval string to milliseconds. `"0"` is an explicit
 * back-to-back run (0ms). Any other string must parse via parseTimeout
 * (e.g. "30m", "1h"); an unparseable value (e.g. "30s", "5", "abc") is a
 * configuration error and must NOT silently coalesce to 0 (which would run the
 * loop full-speed on a typo). Throws on bad input; validate at config build
 * time (validateLoopInterval) so the error surfaces before the loop starts.
 */
export function parseLoopInterval(interval: string | undefined): number {
  if (interval === undefined) return 0;
  if (interval.trim() === '0') return 0;
  const ms = parseTimeout(interval);
  if (ms === null) {
    throw new Error(
      `Invalid loop interval '${interval}'. Use "0" for back-to-back or a duration like "30m", "1h", "2h30m" (units: w/d/h/m).`,
    );
  }
  return ms;
}

/**
 * Read and parse loop-signal.json. Returns null when the file is absent or
 * unparseable — the caller treats null as fail-closed (continue:false).
 */
export function readLoopSignal(runDir: string): LoopSignal | null {
  const file = loopSignalPath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return { continue: parsed.continue === true, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined };
  } catch {
    return null;
  }
}

/** Delete loop-signal.json so a stale signal never carries into the next iteration. */
export function clearLoopSignal(runDir: string): void {
  const file = loopSignalPath(runDir);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* best-effort: a missing file is the desired state anyway. */
  }
}

/**
 * Default per-iteration runner: spawn the agent, tee stdout, and sum token usage
 * off the stream. This is a purpose-built token-capturing spawn for the loop's
 * budget guard, not a re-implementation of exec's fallback/budget machinery —
 * it reuses `buildExecCommand` / `buildExecEnv` (the canonical command/env
 * builders) and `extractUsageEvents` (the canonical stream parser). The agent
 * is forced to JSON/headless so the usage stream is parseable.
 */
export function defaultRunIteration(options: ExecOptions): Promise<IterationResult> {
  // Force the stream-json output the usage parser needs; a loop iteration is
  // always headless (re-injected programmatically, never an interactive TUI).
  const execOptions: ExecOptions = { ...options, json: true, headless: true, interactive: false };
  const cmd = buildExecCommand(execOptions);
  const [executable, ...args] = cmd;
  const env = buildExecEnv(execOptions);
  const cwd = execOptions.cwd || process.cwd();
  const model = execOptions.model ?? `${execOptions.agent}-default`;

  return new Promise((resolve, reject) => {
    // DEP0190-safe shell spawn: on the win32 shell path compose ONE fully-quoted
    // command line and pass an EMPTY args array (see composeWin32CommandLine) so
    // Node never concatenates the args array — which carries the re-injected
    // prompt — into the cmd.exe line unescaped.
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    const spawnCommand = useShell ? composeWin32CommandLine(executable, args) : executable;
    const spawnArgs = useShell ? [] : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      env,
      shell: useShell,
    });

    let tokens = 0;
    let pending = '';
    if (child.stdout) {
      child.stdout.pipe(process.stdout);
      child.stdout.on('data', (chunk: Buffer) => {
        const { events, rest } = extractUsageEvents(chunk.toString('utf-8'), pending, model, execOptions.agent);
        pending = rest;
        for (const ev of events) {
          tokens += (ev.inputTokens ?? 0) + (ev.outputTokens ?? 0)
            + (ev.cacheReadTokens ?? 0) + (ev.cacheCreationTokens ?? 0);
        }
      });
    }
    if (child.stderr) child.stderr.pipe(process.stderr);

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) => {
      resolve({ exitCode: code ?? (signal ? 1 : 0), tokens });
    });
  });
}

/**
 * Run the autonomous loop. Returns when a guard trips, the until-condition is
 * met, the iteration cap is reached, or a signal arrives.
 *
 * stoppedBy semantics:
 *   - `condition-met` — until=signal and the signal said stop (continue:false
 *     OR the file was absent/corrupt → fail-closed).
 *   - `budget`        — cumulative tokens crossed the budget cap (checked after
 *     each turn, outside the agent).
 *   - `max`           — ran maxIterations iterations without any earlier stop.
 *   - `signal`        — SIGINT/SIGTERM arrived; checkpoint is written before exit.
 *   - `error`         — an iteration threw or exited non-zero.
 */
export async function runLoop(
  execOptions: ExecOptions,
  loop: LoopConfig,
  ctx: LoopContext,
  deps?: LoopDeps,
): Promise<LoopResult> {
  const runIteration = deps?.runIteration ?? defaultRunIteration;
  const sleep = deps?.sleep ?? defaultSleep;
  const persist = deps?.writeCheckpoint ?? writeCheckpoint;

  const startedAt = Date.now();
  const maxIterations = loop.maxIterations ?? 1000;
  const intervalMs = parseLoopInterval(loop.interval);

  // Per-iteration session pinning (issue #332). `--session-id` CREATES a
  // session, so each iteration must pin a DISTINCT id — re-passing one errors
  // "Session ID already in use". Iteration 1 pins `firstSessionId`; iteration
  // >= 2 mints a fresh id AND injects `/continue <prior id>` so the agent
  // threads the prior conversation forward (see buildLoopContinuePrompt).
  //
  // `prevSessionId` is the id whose transcript the NEXT iteration continues
  // from. On a resume it is ctx.sessionId (the killed run's last session);
  // on a fresh run it starts undefined and is set after iteration 1.
  const firstSessionId = randomUUID();
  let prevSessionId = ctx.sessionId;
  // The session id recorded in the checkpoint is the most recent iteration's id
  // (what a resume must continue from). Seeded to the resume id or iter-1 id.
  let lastIterationSessionId = ctx.sessionId ?? firstSessionId;
  const startIteration = ctx.startIteration ?? 1;
  // The loop re-injects the entrypoint every iteration, so a prompt is required.
  // The command layer enforces this before dispatch; assert it here so the
  // continuity prompt-builder has a defined entrypoint to thread.
  if (execOptions.prompt === undefined) {
    throw new Error('runLoop requires execOptions.prompt — the loop re-injects the entrypoint each iteration.');
  }
  const entrypointPrompt = execOptions.prompt;
  // `/continue` continuity only applies to claude (the skill + native resume
  // surface). Other agents run each iteration as an independent fresh
  // conversation — warn so the lost continuity is never silent.
  const continuitySupported = ctx.agent === 'claude';
  if (!continuitySupported && maxIterations !== 1) {
    process.stderr.write(
      `[loop] WARNING: cross-iteration conversation continuity applies to claude only. ` +
      `Each ${ctx.agent} iteration runs as an independent fresh conversation (no /continue handoff).\n`,
    );
  }

  // Surface the run-level mailbox id (otherwise undiscoverable — runId is not in
  // the session registry) so an operator can message the loop mid-flight.
  process.stderr.write(`[loop] mailbox: agents message ${ctx.runId} "<text>"\n`);

  let tokens = ctx.startTokens ?? 0;
  let lastSignal: LoopSignal | undefined;

  let stopSignal = false;
  const onSig = () => { stopSignal = true; };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  const checkpoint = (iteration: number): void => {
    const now = new Date().toISOString();
    persist({
      id: ctx.runId,
      agent: ctx.agent,
      version: ctx.version,
      prompt: entrypointPrompt,
      // Resume must continue from the LAST iteration's conversation, so the
      // checkpoint records that iteration's session id (the one a future
      // `/continue` should thread from), not a single pinned id.
      sessionId: lastIterationSessionId,
      iteration,
      loop,
      loopSignal: lastSignal,
      cumulativeTokens: tokens,
      createdAt: now,
      updatedAt: now,
    });
  };

  const done = (iterations: number, stoppedBy: LoopStoppedBy): LoopResult => ({
    iterations,
    stoppedBy,
    elapsedMs: Date.now() - startedAt,
    tokens,
    lastSignal,
  });

  try {
    let iteration = startIteration;
    for (; iteration <= maxIterations; iteration++) {
      if (stopSignal) {
        checkpoint(iteration - 1);
        return done(iteration - startIteration, 'signal');
      }

      // Pin a DISTINCT session id every iteration (`--session-id` CREATES a
      // session; re-passing one errors "Session ID already in use"). The first
      // executed iteration of a fresh run reuses firstSessionId; every later
      // iteration mints a new id.
      const iterationSessionId =
        prevSessionId === undefined ? firstSessionId : randomUUID();

      // Continuity: when a prior iteration exists (prevSessionId set) and the
      // agent supports it, thread the conversation forward via the established
      // `/continue <prior id>` prompt-injection. Otherwise re-inject the bare
      // entrypoint. prevSessionId is set after iteration 1 of a fresh run, or
      // carried in from ctx.sessionId on a resume.
      const iterationPrompt =
        prevSessionId !== undefined && continuitySupported
          ? buildLoopContinuePrompt(prevSessionId, entrypointPrompt)
          : entrypointPrompt;

      // AGENTS_LOOP_SIGNAL / AGENTS_RUN_DIR: tell the entrypoint where to write
      // loop-signal.json so the guard (read OUTSIDE the agent) can see it. The
      // agent never decides whether to continue — it only writes its vote.
      const iterOptions: ExecOptions = {
        ...execOptions,
        prompt: iterationPrompt,
        sessionId: iterationSessionId,
        env: {
          ...execOptions.env,
          AGENTS_RUN_DIR: ctx.runDir,
          AGENTS_LOOP_SIGNAL: loopSignalPath(ctx.runDir),
          AGENTS_LOOP_ITERATION: String(iteration),
          // Every iteration is a fresh session, so key the mailbox by the stable
          // run id — one box for the whole loop. Overrides the per-iteration
          // AGENTS_MAILBOX_DIR that buildExecEnv would derive from sessionId.
          AGENTS_MAILBOX_DIR: mailboxDir(ctx.runId),
        },
      };

      let result: IterationResult;
      try {
        result = await runIteration(iterOptions);
      } catch (err) {
        // A SIGINT/SIGTERM mid-iteration kills the child; the resulting throw
        // is a signal stop, not an error. Check the stop flag first.
        if (stopSignal) {
          checkpoint(iteration - 1);
          return done(iteration - startIteration, 'signal');
        }
        checkpoint(iteration - 1);
        process.stderr.write(`[loop] iteration ${iteration} failed: ${(err as Error).message}\n`);
        return done(iteration - startIteration, 'error');
      }

      // This iteration's conversation is now on disk under iterationSessionId.
      // The next iteration continues from it; a checkpoint records it for resume.
      prevSessionId = iterationSessionId;
      lastIterationSessionId = iterationSessionId;

      tokens += result.tokens;
      const completed = iteration - startIteration + 1;

      // until=signal: read the signal the entrypoint wrote this iteration.
      // Absent/corrupt OR continue:false => stop (fail-closed).
      if (loop.until === 'signal') {
        lastSignal = readLoopSignal(ctx.runDir) ?? { continue: false, reason: 'loop-signal.json absent (fail-closed)' };
        clearLoopSignal(ctx.runDir);
        if (!lastSignal.continue) {
          checkpoint(iteration);
          return done(completed, 'condition-met');
        }
      }

      // Budget (token hard-cap), enforced after the turn — outside the agent.
      if (loop.budget !== undefined && tokens >= loop.budget) {
        checkpoint(iteration);
        return done(completed, 'budget');
      }

      // A non-zero exit is a hard error — UNLESS a signal arrived mid-iteration.
      // Ctrl-C kills the child (non-zero exit / SIGINT exit code); that is a
      // 'signal' stop (exit 130), not an 'error'. Check the stop flag first.
      if (result.exitCode !== 0) {
        if (stopSignal) {
          checkpoint(iteration);
          return done(completed, 'signal');
        }
        checkpoint(iteration);
        process.stderr.write(`[loop] iteration ${iteration} exited ${result.exitCode}\n`);
        return done(completed, 'error');
      }

      checkpoint(iteration);

      if (stopSignal) {
        return done(completed, 'signal');
      }

      // Pace between iterations. Skip the sleep after the final iteration.
      if (iteration < maxIterations && intervalMs > 0) {
        await sleep(intervalMs);
        if (stopSignal) {
          return done(completed, 'signal');
        }
      }
    }
    return done(maxIterations - startIteration + 1, 'max');
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
