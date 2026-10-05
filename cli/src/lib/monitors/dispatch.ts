/** Monitor action dispatch. `run`/`routine` use the same detached spawn as cron and webhook fires
 * (executeJobDetached), never duplicating spawn logic. `notify` goes through one owner-channel
 * seam (sendToOwner); an unresolvable channel returns `ok: false`. `webhook-out` POSTs. */

import { executeJobDetached } from '../daemon/runner.js';
import { readJob, type JobConfig } from '../scheduling/routines.js';
import { sendToOwner } from '../notify.js';
import type { AgentId, Meta } from '../types.js';
import type { ActionConfig, MonitorConfig, MonitorEvent } from './config.js';

/** Outcome of a dispatched action. */
export interface DispatchResult {
  kind: ActionConfig['type'];
  ok: boolean;
  /** Run id for `run`/`routine` actions dispatched through executeJobDetached. */
  runId?: string;
  error?: string;
}

/** Replace `{event}` in a prompt with the fired event summary. */
export function injectEvent(prompt: string, event: MonitorEvent): string {
  return prompt.replace(/\{event\}/g, event.summary);
}

/** Dispatches a monitor's action for a fired event. `run` synthesizes a JobConfig (event in the
 * prompt, runOn mapped to host placement) and calls executeJobDetached; `routine` fires an
 * existing routine with the event; `notify` and `webhook-out` are terminal side-effects. */
export async function dispatchAction(
  monitor: MonitorConfig,
  event: MonitorEvent,
  meta?: Meta,
): Promise<DispatchResult> {
  const action = monitor.action;

  if (action.type === 'run') {
    const job: JobConfig = {
      name: monitor.name,
      // This job is not a routine, so it is never in the device's routine activation manifest and
      // MUST NOT be gated on it: that refused every monitor `run` with `wrong_owner` (RUSH-2681).
      // The monitor's own `device:` pin already resolved exactly-once ownership.
      dispatchedBy: 'monitor',
      agent: action.agent as AgentId,
      mode: action.mode ?? 'auto',
      effort: action.effort ?? 'auto',
      timeout: action.timeout ?? '10m',
      enabled: true,
      prompt: injectEvent(action.prompt ?? '', event),
      // A monitor owns no project and had no field to supply a cwd, so
      // `resolveJobExecutionContext` blocked `run` with `execution_context_missing`. `~` is the
      // execution TARGET's home, portable across a `runOn:` SSH hop.
      cwd: monitor.cwd ?? '~',
      ...(monitor.variables ? { variables: monitor.variables } : {}),
      ...(monitor.version ? { version: monitor.version } : {}),
      ...(monitor.runOn ? { host: monitor.runOn } : {}),
    };
    try {
      const runMeta = await executeJobDetached(job);
      if (runMeta.status === 'skipped' || runMeta.status === 'blocked' || runMeta.status === 'failed') {
        return { kind: 'run', ok: false, runId: runMeta.runId, error: runMeta.errorMessage ?? runMeta.status };
      }
      return { kind: 'run', ok: true, runId: runMeta.runId };
    } catch (err) {
      return { kind: 'run', ok: false, error: (err as Error).message };
    }
  }

  if (action.type === 'routine') {
    const routine = action.routine ? readJob(action.routine) : null;
    if (!routine) {
      return { kind: 'routine', ok: false, error: `routine '${action.routine}' not found` };
    }
    // Inject the event into the routine's prompt so the fired routine sees it.
    const fired: JobConfig = { ...routine, prompt: injectEvent(routine.prompt ?? '', event) };
    try {
      const runMeta = await executeJobDetached(fired);
      if (runMeta.status === 'skipped' || runMeta.status === 'blocked' || runMeta.status === 'failed') {
        return { kind: 'routine', ok: false, runId: runMeta.runId, error: runMeta.errorMessage ?? runMeta.status };
      }
      return { kind: 'routine', ok: true, runId: runMeta.runId };
    } catch (err) {
      return { kind: 'routine', ok: false, error: (err as Error).message };
    }
  }

  if (action.type === 'notify') {
    const result = await sendToOwner(event.summary, {
      ...(meta ? { meta } : {}),
      ...(action.notifyChannel ? { channel: action.notifyChannel } : {}),
    });
    return { kind: 'notify', ok: result.ok, ...(result.ok ? {} : { error: result.error }) };
  }

  // webhook-out
  if (!action.url) return { kind: 'webhook-out', ok: false, error: 'action.url is required' };
  try {
    const res = await fetch(action.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    return { kind: 'webhook-out', ok: res.ok, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    return { kind: 'webhook-out', ok: false, error: (err as Error).message };
  }
}
