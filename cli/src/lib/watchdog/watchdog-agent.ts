
import { renderWatchdogPrompt, parseWatchdogResponse, type WatchdogCandidate, type Decision } from './watchdog.js';

export type WatchdogAgentDecider = (candidates: WatchdogCandidate[]) => Promise<Map<string, Decision>>;

type WatchdogAgentRunner = (runTarget: string, prompt: string) => Promise<string>;

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
    }
    return result;
  };
}
