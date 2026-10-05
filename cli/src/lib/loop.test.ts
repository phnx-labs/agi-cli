import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  runLoop,
  loopSignalPath,
  readLoopSignal,
  clearLoopSignal,
  parseLoopInterval,
  buildLoopContinuePrompt,
  buildContinuePrompt,
  type LoopContext,
  type IterationResult,
} from './loop.js';
import type { ExecOptions } from './exec.js';
import type { Checkpoint } from './checkpoint.js';

function tmpRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-loop-test-'));
}

const baseExec: ExecOptions = {
  agent: 'claude',
  prompt: 'iterate',
  mode: 'skip',
  effort: 'auto',
};

function baseCtx(runDir: string, overrides: Partial<LoopContext> = {}): LoopContext {
  return { runId: 'loop-test', runDir, agent: 'claude', ...overrides };
}

/** A run-fn that records each call and returns a fixed token count + exit 0. */
function recordingRun(tokensPerIter = 0): {
  fn: (o: ExecOptions) => Promise<IterationResult>;
  calls: ExecOptions[];
} {
  const calls: ExecOptions[] = [];
  return {
    calls,
    fn: async (o: ExecOptions) => {
      calls.push(o);
      return { exitCode: 0, tokens: tokensPerIter };
    },
  };
}

const noSleep = async () => {};

describe('runLoop — termination by max_iterations', () => {
  it('runs exactly maxIterations turns then stops with stoppedBy max', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun();
    const checkpoints: Checkpoint[] = [];
    const result = await runLoop(baseExec, { maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: (c) => checkpoints.push({ ...c }),
    });
    expect(result.iterations).toBe(3);
    expect(result.stoppedBy).toBe('max');
    expect(rec.calls.length).toBe(3);
    // A checkpoint after every iteration.
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[checkpoints.length - 1].iteration).toBe(3);
  });

  it('pins a DISTINCT session id per iteration and threads continuity via /continue', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun();
    await runLoop(baseExec, { maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    const ids = rec.calls.map((c) => c.sessionId);
    const prompts = rec.calls.map((c) => c.prompt);
    // `--session-id` CREATES a session — re-passing one errors "already in use".
    // So every iteration must pin a UNIQUE id.
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(3);
    // Iteration 1 gets the bare entrypoint.
    expect(prompts[0]).toBe('iterate');
    // Iterations 2+ thread the PRIOR iteration's session via /continue, then
    // re-append the entrypoint. The id referenced must be the previous turn's.
    expect(prompts[1]).toBe(`/continue ${ids[0]}\n\niterate`);
    expect(prompts[2]).toBe(`/continue ${ids[1]}\n\niterate`);
  });

  it('non-claude loops run independent conversations (no /continue injection)', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun();
    await runLoop(
      { ...baseExec, agent: 'codex' },
      { maxIterations: 3, interval: '0' },
      baseCtx(runDir, { agent: 'codex' }),
      { runIteration: rec.fn, sleep: noSleep, writeCheckpoint: () => {} },
    );
    // Every iteration re-injects the bare entrypoint — no /continue handoff.
    expect(rec.calls.every((c) => c.prompt === 'iterate')).toBe(true);
  });
});

describe('runLoop — until=signal', () => {
  it('stops with condition-met when the entrypoint writes continue:false', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        // The "agent" writes the signal AFTER iteration 1 saying "stop".
        if (iter === 1) {
          fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: false, reason: 'goal reached' }), 'utf-8');
        }
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(1);
    expect(result.stoppedBy).toBe('condition-met');
    expect(result.lastSignal?.reason).toBe('goal reached');
  });

  it('continues while the signal says continue:true, then stops on false', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        const cont = iter < 3; // stop on the 3rd
        fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: cont }), 'utf-8');
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(3);
    expect(result.stoppedBy).toBe('condition-met');
  });

  it('fail-closed: an absent signal file stops with condition-met', async () => {
    const runDir = tmpRunDir();
    // run-fn never writes loop-signal.json — absence must be treated as stop.
    const result = await runLoop(baseExec, { until: 'signal', maxIterations: 10, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 0 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.iterations).toBe(1);
    expect(result.stoppedBy).toBe('condition-met');
    expect(result.lastSignal?.continue).toBe(false);
  });

  it('deletes the signal file between iterations so a stale signal cannot carry over', async () => {
    const runDir = tmpRunDir();
    let iter = 0;
    const seenSignalBeforeRun: boolean[] = [];
    await runLoop(baseExec, { until: 'signal', maxIterations: 3, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        iter++;
        // Record whether a stale signal survived into this iteration's start.
        seenSignalBeforeRun.push(fs.existsSync(loopSignalPath(runDir)));
        fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: iter < 3 }), 'utf-8');
        return { exitCode: 0, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    // The driver clears the signal after reading it, so no iteration ever begins
    // with a leftover signal file present.
    expect(seenSignalBeforeRun).toEqual([false, false, false]);
  });
});

describe('runLoop — budget (token cap)', () => {
  it('stops with budget once cumulative tokens reach the cap', async () => {
    const runDir = tmpRunDir();
    // 400 tokens/iter, cap 1000 → stops after iter 3 (1200 >= 1000).
    const result = await runLoop(baseExec, { budget: 1000, maxIterations: 100, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 400 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('budget');
    expect(result.iterations).toBe(3);
    expect(result.tokens).toBe(1200);
  });

  it('does not stop on budget when tokens stay under the cap (max wins)', async () => {
    const runDir = tmpRunDir();
    const result = await runLoop(baseExec, { budget: 100000, maxIterations: 2, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 0, tokens: 10 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('max');
    expect(result.tokens).toBe(20);
  });
});

describe('runLoop — error handling', () => {
  it('stops with error and checkpoints when an iteration exits non-zero', async () => {
    const runDir = tmpRunDir();
    let last: Checkpoint | undefined;
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 2, tokens: 5 }),
      sleep: noSleep,
      writeCheckpoint: (c) => { last = { ...c }; },
    });
    expect(result.stoppedBy).toBe('error');
    expect(result.iterations).toBe(1);
    expect(last?.iteration).toBe(1);
  });

  it('stops with error when an iteration throws', async () => {
    const runDir = tmpRunDir();
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => { throw new Error('spawn blew up'); },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('error');
    expect(result.iterations).toBe(0);
  });
});

describe('runLoop — signal classification (FIX 2)', () => {
  it('classifies a non-zero exit AFTER SIGINT as signal, not error', async () => {
    const runDir = tmpRunDir();
    // Ctrl-C kills the child mid-iteration: the iteration returns a non-zero
    // exit, but a SIGINT arrived first. That must be 'signal' (exit 130), not
    // 'error'. Emit SIGINT during the iteration, then return exit 130.
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        process.emit('SIGINT' as any);
        return { exitCode: 130, tokens: 0 };
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('signal');
  });

  it('classifies a throw AFTER SIGINT as signal, not error', async () => {
    const runDir = tmpRunDir();
    // A SIGINT that kills the child can surface as a spawn rejection rather than
    // a clean non-zero exit. With the stop flag set, that is still a signal.
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => {
        process.emit('SIGINT' as any);
        throw new Error('killed by signal');
      },
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('signal');
  });

  it('a genuine non-zero exit with NO signal is still error', async () => {
    const runDir = tmpRunDir();
    const result = await runLoop(baseExec, { maxIterations: 5, interval: '0' }, baseCtx(runDir), {
      runIteration: async () => ({ exitCode: 2, tokens: 0 }),
      sleep: noSleep,
      writeCheckpoint: () => {},
    });
    expect(result.stoppedBy).toBe('error');
  });
});

describe('buildLoopContinuePrompt (FIX 1)', () => {
  it('prepends the /continue skill directive then re-appends the entrypoint', () => {
    expect(buildLoopContinuePrompt('abc-123', 'do the work')).toBe(
      '/continue abc-123\n\ndo the work',
    );
  });
});

describe('buildContinuePrompt (Tier-2 universal resume directive)', () => {
  it('directive only when no follow-on prompt', () => {
    expect(buildContinuePrompt('abc-123')).toBe('/continue abc-123');
  });
  it('treats a whitespace-only prompt as none', () => {
    expect(buildContinuePrompt('abc-123', '   ')).toBe('/continue abc-123');
  });
  it('appends a real follow-on prompt after a blank line', () => {
    expect(buildContinuePrompt('abc-123', 'what did we decide?')).toBe(
      '/continue abc-123\n\nwhat did we decide?',
    );
  });
});

describe('parseLoopInterval (FIX 3)', () => {
  it('accepts "0" as explicit back-to-back (0ms)', () => {
    expect(parseLoopInterval('0')).toBe(0);
    expect(parseLoopInterval(' 0 ')).toBe(0);
  });

  it('accepts valid durations', () => {
    expect(parseLoopInterval('30m')).toBe(30 * 60 * 1000);
    expect(parseLoopInterval('1h')).toBe(60 * 60 * 1000);
    expect(parseLoopInterval('2h30m')).toBe((2 * 60 + 30) * 60 * 1000);
  });

  it('returns 0 for undefined (no interval configured)', () => {
    expect(parseLoopInterval(undefined)).toBe(0);
  });

  it('THROWS on unparseable input instead of silently coalescing to 0', () => {
    // The bug: "30s" / "5" / "abc" parsed to null then coalesced to 0ms, so a
    // typo ran the loop full-speed. Each must now throw.
    expect(() => parseLoopInterval('30s')).toThrow(/Invalid loop interval/);
    expect(() => parseLoopInterval('5')).toThrow(/Invalid loop interval/);
    expect(() => parseLoopInterval('abc')).toThrow(/Invalid loop interval/);
  });
});

describe('runLoop — resume from checkpoint', () => {
  it('starts at checkpoint.iteration+1 and carries token count forward', async () => {
    const runDir = tmpRunDir();
    const rec = recordingRun(100);
    const checkpoints: Checkpoint[] = [];
    // Simulate a run that already completed 2 iterations (300 tokens), resuming
    // at iteration 3 with maxIterations 4 → runs iterations 3 and 4 only.
    const result = await runLoop(baseExec, { maxIterations: 4, interval: '0' }, baseCtx(runDir, {
      startIteration: 3,
      startTokens: 300,
      sessionId: 'resumed-session-id',
    }), {
      runIteration: rec.fn,
      sleep: noSleep,
      writeCheckpoint: (c) => checkpoints.push({ ...c }),
    });
    // Only 2 NEW iterations executed (3 and 4).
    expect(rec.calls.length).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.stoppedBy).toBe('max');
    // Token count continued from 300: 300 + 2*100 = 500.
    expect(result.tokens).toBe(500);
    // The FIRST resumed iteration continues the killed run's conversation via
    // /continue <carried id>; it pins its own fresh session id (not the carried
    // one — re-passing would error "already in use").
    expect(rec.calls[0].prompt).toBe('/continue resumed-session-id\n\niterate');
    expect(rec.calls[0].sessionId).not.toBe('resumed-session-id');
    // The second resumed iteration continues from the first resumed iteration.
    expect(rec.calls[1].prompt).toBe(`/continue ${rec.calls[0].sessionId}\n\niterate`);
    expect(rec.calls[1].sessionId).not.toBe(rec.calls[0].sessionId);
    // The final checkpoint records the real iteration number and the LAST
    // iteration's session id (what a future resume continues from).
    expect(checkpoints[checkpoints.length - 1].iteration).toBe(4);
    expect(checkpoints[checkpoints.length - 1].cumulativeTokens).toBe(500);
    expect(checkpoints[checkpoints.length - 1].sessionId).toBe(rec.calls[1].sessionId);
  });
});

describe('loop-signal helpers', () => {
  it('readLoopSignal returns null for a missing file and coerces continue defensively', () => {
    const runDir = tmpRunDir();
    expect(readLoopSignal(runDir)).toBeNull();
    fs.writeFileSync(loopSignalPath(runDir), JSON.stringify({ continue: 'yes', reason: 5 }), 'utf-8');
    const sig = readLoopSignal(runDir)!;
    expect(sig.continue).toBe(false); // non-boolean true coerced to false (fail-closed)
    expect(sig.reason).toBeUndefined(); // non-string reason dropped
  });

  it('clearLoopSignal removes the file and is a no-op when already absent', () => {
    const runDir = tmpRunDir();
    fs.writeFileSync(loopSignalPath(runDir), '{"continue":true}', 'utf-8');
    clearLoopSignal(runDir);
    expect(fs.existsSync(loopSignalPath(runDir))).toBe(false);
    expect(() => clearLoopSignal(runDir)).not.toThrow();
  });
});
