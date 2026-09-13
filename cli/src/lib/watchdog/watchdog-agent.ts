/**
 * The watchdog AGENT — the whole decider, in ONE call per tick.
 *
 * The watchdog does not use a heuristic script to guess idle-vs-unfinished. It
 * hands every idle session's task + tail to an agent (via `agents run <target>
 * --mode plan`, read-only) and asks it, for each, whether it is idle-but-unfinished
 * (→ nudge) or idle-and-done / needs-human (→ skip). The whole idle set goes in ONE
 * invocation, so the cost is one bounded plan-mode call per tick regardless of how
 * many sessions are idle — not one agent per session, and only when something is
 * actually idle (the caller does not invoke this with an empty list).
 *
 * A resolved `watchdog` workflow (repo > user > system, via resolveWorkflowRef)
 * runs by name so its WORKFLOW.md body + `model:` frontmatter apply; otherwise the
 * bare agent runs the built-in WATCHDOG_SYSTEM_PROMPT. Best-effort: any failure
 * (agent unavailable, timeout, no verdict) yields an empty map, and the caller
 * treats an unlisted terminal as a SAFE skip — never a blind nudge.
 */

import { renderWatchdogPrompt, parseWatchdogResponse, type WatchdogCandidate, type Decision } from './watchdog.js';

/** Judge every idle candidate at once; returns decisions keyed by terminalId. */
export type WatchdogAgentDecider = (candidates: WatchdogCandidate[]) => Promise<Map<string, Decision>>;

/**
 * Runs the agent once and returns its raw stdout. Injectable so a test can assert
 * the ONE-call-per-tick property and the assembled prompt without shelling out.
 * `runTarget` is the resolved `agents run` target (a `watchdog` workflow or the
 * bare agent id).
 */
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

/**
 * The default agent decider. `agent` is the harness the built-in prompt runs as
 * (default 'claude'); `workflowCwd` is where a `watchdog` workflow override is
 * resolved from (the daemon's cwd — the batch spans many projects, so there is no
 * single per-session cwd to key on); `run` is the injectable subprocess seam
 * (tests pass a synthetic one). The whole idle set goes to the runner in ONE call.
 */
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
