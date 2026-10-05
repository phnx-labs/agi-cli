/** Autonomous loop driver (#332): re-injects an entrypoint each iteration until a stop condition.
 * Every guard (`max_iterations`, token `budget`, `until: signal`, SIGINT/SIGTERM) lives OUTSIDE
 * the agent so it cannot vote past a kill-switch. Mirrors runSupervisor in teams/supervisor.ts. */

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
  /** On a resume, the killed run's LAST iteration session id; the first resumed iteration
   * `/continue`s from it. Undefined on a fresh run. */
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

/** Builds the iteration >= 2 prompt: continues the prior conversation via the `/continue <id>`
 * skill (as in buildFallbackPrompt, exec.ts), which reads the transcript off disk, so each
 * iteration can pin a fresh session id. The original entrypoint is re-appended. */
export function buildLoopContinuePrompt(prevSessionId: string, entrypoint: string): string {
  return buildContinuePrompt(prevSessionId, entrypoint);
}

/** The universal (Tier-2) resume directive: a `/continue <id>` first message telling the agent to
 * load the prior transcript via `agents sessions <id>`. Works for any agent shipping `/continue`
 * (those without native `--resume`). An optional follow-on prompt follows a blank line. */
export function buildContinuePrompt(sessionId: string, prompt?: string): string {
  const directive = `/continue ${sessionId}`;
  return prompt && prompt.trim() ? `${directive}\n\n${prompt}` : directive;
}

/** Resolves a loop interval to ms. "0" is an explicit back-to-back run; anything else must parse
 * via parseTimeout ("30m", "1h"). Unparseable values throw rather than coalescing to 0, which
 * would run full-speed on a typo. */
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

/** Reads loop-signal.json. Null when absent or unparseable; the caller treats null as fail-closed
 * (continue:false). */
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

/** Default per-iteration runner: spawns the agent, tees stdout and sums token usage for the budget
 * guard, reusing buildExecCommand/buildExecEnv and extractUsageEvents. The agent is forced to
 * JSON/headless so usage is parseable. */
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
    // DEP0190-safe shell spawn on win32: compose ONE fully-quoted command line and pass an empty
    // args array so Node never concatenates the args (carrying the re-injected prompt) into the
    // cmd.exe line unescaped.
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

/** Runs the loop until a guard trips, the until-condition is met, the cap is reached, or a signal
 * arrives. `stoppedBy`: condition-met (signal said stop, or file absent/corrupt: fail-closed),
 * budget, max, signal (checkpoint written first), error (iteration threw or exited non-zero). */
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

  // Per-iteration session pinning (#332): `--session-id` creates a session, so each iteration
  // needs a distinct id. Iteration 1 uses `firstSessionId`; later ones mint a fresh id and inject
  // `/continue <prevSessionId>` (on resume, ctx.sessionId, the killed run's last session).
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

      // Pin a distinct session id each iteration (`--session-id` creates a session; re-passing one
      // errors). The first executed iteration of a fresh run reuses firstSessionId; later ones
      // mint a new id.
      const iterationSessionId =
        prevSessionId === undefined ? firstSessionId : randomUUID();

      // Continuity: once a prior iteration exists (prevSessionId set) and the agent supports it,
      // inject `/continue <prior id>`; otherwise re-inject the bare entrypoint.
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
