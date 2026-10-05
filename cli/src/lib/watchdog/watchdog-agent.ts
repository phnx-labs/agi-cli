/** The watchdog agent: the whole decider, ONE read-only `agents run --mode plan` call per tick for
 * all idle sessions. A `watchdog` workflow runs by name, else the built-in WATCHDOG_SYSTEM_PROMPT.
 * Any failure yields an empty map; unlisted terminals are a safe skip, never a blind nudge. */

import { renderWatchdogPrompt, parseWatchdogResponse, type WatchdogCandidate, type Decision } from './watchdog.js';

/** Judge every idle candidate at once; returns decisions keyed by terminalId. */
export type WatchdogAgentDecider = (candidates: WatchdogCandidate[]) => Promise<Map<string, Decision>>;

/** Runs the agent once and returns raw stdout; injectable so tests assert one call per tick and the
 * prompt. `runTarget` is the resolved `agents run` target (a `watchdog` workflow or bare agent id). */
type WatchdogAgentRunner = (runTarget: string, prompt: string) => Promise<string>;

/** The real runner: one `agents run <target> --mode plan <prompt>` subprocess. */
async function defaultAgentRunner(runTarget: string, prompt: string): Promise<string> {
  const [{ execFile }, { promisify }] = await Promise.all([import('child_process'), import('util')]);
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('agents', ['run', runTarget, '--mode', 'plan', prompt], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

/** The default agent decider. `agent` is the harness for the built-in prompt (default 'claude');
 * `workflowCwd` is where a `watchdog` workflow override resolves (the daemon's cwd, since a batch
 * spans projects); `run` is the test seam. */
export function makeWatchdogAgentDecider(
  agent: string,
  opts: { workflowCwd?: string; run?: WatchdogAgentRunner } = {},
): WatchdogAgentDecider {
  return async (candidates) => {
    const result = new Map<string, Decision>();
    if (candidates.length === 0) return result;
    try {
      const { resolveWorkflowRef } = await import('../workflows.js');
      const cwd = opts.workflowCwd || process.cwd();
      const workflowPath = resolveWorkflowRef('watchdog', cwd);
      const runTarget = workflowPath ? 'watchdog' : agent;
      const prompt = renderWatchdogPrompt(candidates);
      const run = opts.run ?? defaultAgentRunner;
      const stdout = await run(runTarget, prompt);
      for (const d of parseWatchdogResponse(stdout)) result.set(d.terminalId, d);
    } catch {
      // Agent unavailable / timed out — return what we have (possibly empty); the
      // caller safe-skips any terminal with no verdict. Never a blind nudge.
    }
    return result;
  };
}
