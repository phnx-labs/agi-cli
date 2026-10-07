import * as os from 'os';
import type { JobConfig, RunMeta } from './scheduling/routines.js';
import { routineKind } from './routine-notify.js';
import { postOwnerNotification, type OwnerNotifyResult } from './owner-notify.js';

function routineLabel(r: Pick<JobConfig, 'agent' | 'workflow' | 'command'>): string {
  const kind = routineKind(r);
  if (kind === 'command') return 'command';
  if (kind === 'workflow') return `workflow ${r.workflow}`;
  return `agent ${r.agent ?? 'unknown'}`;
}

function failureReason(
  meta: Pick<RunMeta, 'status' | 'exitCode' | 'errorMessage'>,
): string {
  if (meta.status === 'timeout') return 'Timed out';
  if (meta.errorMessage) return meta.errorMessage;
  return `Exited with code ${meta.exitCode ?? '?'}`;
}

function routineFinishOwnerText(
  meta: Pick<RunMeta, 'jobName' | 'status' | 'exitCode' | 'errorMessage' | 'agent' | 'workflow' | 'command'>,
  host: string,
): string | null {

  if (meta.status !== 'failed' && meta.status !== 'timeout') return null;
  return `${failureReason(meta)}\n${routineLabel(meta)} · ${host}`;
}

function routineStartFailedOwnerText(
  config: Pick<JobConfig, 'name' | 'agent' | 'workflow' | 'command'>,
  error: string,
  host: string,
): string {
  return `${error}\n${routineLabel(config)} · ${host}`;
}

export async function notifyOwnerRoutineFinish(meta: RunMeta): Promise<OwnerNotifyResult | null> {
  const host = os.hostname();
  const body = routineFinishOwnerText(meta, host);
  if (!body) return null;
  return postOwnerNotification({
    event: 'failed',
    title: `Routine failed: ${meta.jobName}`,
    body,
    dedupKey: `routine:${meta.jobName}:${meta.runId}`,
    source: { device: host, agent: 'routines' },
  });
}

export async function notifyOwnerRoutineStartFailed(
  config: JobConfig,
  error: string,
  scheduledFor: Date = new Date(),
): Promise<OwnerNotifyResult> {
  const host = os.hostname();
  return postOwnerNotification({
    event: 'failed',
    title: `Routine failed to start: ${config.name}`,
    body: routineStartFailedOwnerText(config, error, host),
    dedupKey: `routine-start:${config.name}:${scheduledFor.toISOString()}`,
    source: { device: host, agent: 'routines' },
  });
}
