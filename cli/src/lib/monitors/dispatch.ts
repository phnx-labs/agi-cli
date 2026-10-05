
import { executeJobDetached } from '../daemon/runner.js';
import { readJob, type JobConfig } from '../scheduling/routines.js';
import { sendToOwner } from '../notify.js';
import type { AgentId, Meta } from '../types.js';
import type { ActionConfig, MonitorConfig, MonitorEvent } from './config.js';

export interface DispatchResult {
  kind: ActionConfig['type'];
  ok: boolean;
  runId?: string;
  error?: string;
}

export function injectEvent(prompt: string, event: MonitorEvent): string {
  return prompt.replace(/\{event\}/g, event.summary);
}

export async function dispatchAction(
  monitor: MonitorConfig,
  event: MonitorEvent,
  meta?: Meta,
): Promise<DispatchResult> {
  const action = monitor.action;

  if (action.type === 'run') {
    const job: JobConfig = {
      name: monitor.name,
      dispatchedBy: 'monitor',
      agent: action.agent as AgentId,
      mode: action.mode ?? 'auto',
      effort: action.effort ?? 'auto',
      timeout: action.timeout ?? '10m',
      enabled: true,
      prompt: injectEvent(action.prompt ?? '', event),
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
