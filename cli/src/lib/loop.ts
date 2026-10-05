
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

export interface LoopConfig {
  until?: 'signal';
  maxIterations?: number;
  budget?: number;
  interval?: string;
}

export interface LoopSignal {
  continue: boolean;
  reason?: string;
}

export type LoopStoppedBy =
  | 'condition-met'
  | 'budget'
  | 'stalled'
  | 'max'
  | 'signal'
  | 'error';

interface LoopResult {
  iterations: number;
  stoppedBy: LoopStoppedBy;
  elapsedMs: number;
  tokens: number;
  lastSignal?: LoopSignal;
}

export interface IterationResult {
  exitCode: number;
  tokens: number;
}

export type RunIteration = (options: ExecOptions) => Promise<IterationResult>;

export interface LoopContext {
  runId: string;
  runDir: string;
  agent: AgentId;
  version?: string;
  startIteration?: number;
  startTokens?: number;
  sessionId?: string;
}

export interface LoopDeps {
  runIteration?: RunIteration;
  sleep?: (ms: number) => Promise<void>;
  writeCheckpoint?: (c: Checkpoint) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export function loopSignalPath(runDir: string): string {
  return path.join(runDir, 'loop-signal.json');
}

export function buildLoopContinuePrompt(prevSessionId: string, entrypoint: string): string {
  return buildContinuePrompt(prevSessionId, entrypoint);
}

export function buildContinuePrompt(sessionId: string, prompt?: string): string {
  const directive = `/continue ${sessionId}`;
  return prompt && prompt.trim() ? `${directive}\n\n${prompt}` : directive;
}

export function parseLoopInterval(interval: string | undefined): number {
  // Loop caps, budgets, and signals are enforced outside the agent; invalid intervals fail loud.
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

export function readLoopSignal(runDir: string): LoopSignal | null {
  // Missing or corrupt external signals fail closed in runLoop.
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

export function clearLoopSignal(runDir: string): void {
  const file = loopSignalPath(runDir);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
  }
}

export function defaultRunIteration(options: ExecOptions): Promise<IterationResult> {
  const execOptions: ExecOptions = { ...options, json: true, headless: true, interactive: false };
  const cmd = buildExecCommand(execOptions);
  const [executable, ...args] = cmd;
  const env = buildExecEnv(execOptions);
  const cwd = execOptions.cwd || process.cwd();
  const model = execOptions.model ?? `${execOptions.agent}-default`;

  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && (
      !path.isAbsolute(executable) || executable.endsWith('.cmd')
    );
    // Windows shell execution passes one fully quoted command and an empty argv.
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

  // Each iteration gets a fresh session; only Claude continues through /continue.
  const firstSessionId = randomUUID();
  let prevSessionId = ctx.sessionId;
  let lastIterationSessionId = ctx.sessionId ?? firstSessionId;
  const startIteration = ctx.startIteration ?? 1;
  if (execOptions.prompt === undefined) {
    throw new Error('runLoop requires execOptions.prompt — the loop re-injects the entrypoint each iteration.');
  }
  const entrypointPrompt = execOptions.prompt;
  const continuitySupported = ctx.agent === 'claude';
  if (!continuitySupported && maxIterations !== 1) {
    process.stderr.write(
      `[loop] WARNING: cross-iteration conversation continuity applies to claude only. ` +
      `Each ${ctx.agent} iteration runs as an independent fresh conversation (no /continue handoff).\n`,
    );
  }

  // Checkpoints track the latest session while the mailbox remains keyed by run ID.
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

      const iterationSessionId =
        prevSessionId === undefined ? firstSessionId : randomUUID();

      const iterationPrompt =
        prevSessionId !== undefined && continuitySupported
          ? buildLoopContinuePrompt(prevSessionId, entrypointPrompt)
          : entrypointPrompt;

      const iterOptions: ExecOptions = {
        ...execOptions,
        prompt: iterationPrompt,
        sessionId: iterationSessionId,
        env: {
          ...execOptions.env,
          AGENTS_RUN_DIR: ctx.runDir,
          AGENTS_LOOP_SIGNAL: loopSignalPath(ctx.runDir),
          AGENTS_LOOP_ITERATION: String(iteration),
          AGENTS_MAILBOX_DIR: mailboxDir(ctx.runId),
        },
      };

      let result: IterationResult;
      try {
        result = await runIteration(iterOptions);
      } catch (err) {
        // A process signal wins over a thrown child failure.
        if (stopSignal) {
          checkpoint(iteration - 1);
          return done(iteration - startIteration, 'signal');
        }
        checkpoint(iteration - 1);
        process.stderr.write(`[loop] iteration ${iteration} failed: ${(err as Error).message}\n`);
        return done(iteration - startIteration, 'error');
      }

      prevSessionId = iterationSessionId;
      lastIterationSessionId = iterationSessionId;

      tokens += result.tokens;
      const completed = iteration - startIteration + 1;

      if (loop.until === 'signal') {
        lastSignal = readLoopSignal(ctx.runDir) ?? { continue: false, reason: 'loop-signal.json absent (fail-closed)' };
        clearLoopSignal(ctx.runDir);
        if (!lastSignal.continue) {
          checkpoint(iteration);
          return done(completed, 'condition-met');
        }
      }

      if (loop.budget !== undefined && tokens >= loop.budget) {
        checkpoint(iteration);
        return done(completed, 'budget');
      }

      if (result.exitCode !== 0) {
        // Ctrl-C is a signal stop, not an iteration error.
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
