
import { randomUUID } from 'node:crypto';
import type { ComputerActionEvent } from '../computer-client.js';
import { emit as emitEvent } from '../feed/events.js';
import { truncate } from '../feed/events.js';

export const TASK_PREVIEW_MAX_CHARS = 200;

export const COMPUTER_INVOCATION_ID = randomUUID();

export function recordComputerAction(event: ComputerActionEvent, opts: { device?: string } = {}): void {
  const {
    event: _kind,
    command,
    invocationId,
    pid: _enginePid,
    host,
    sessionId,
    launchId,
    actor: _actor,
    ...rest
  } = event;


  const runId = invocationId || COMPUTER_INVOCATION_ID;
  const drivenHost = host ?? opts.device;

  const extra = typeof rest.task === 'string'
    ? { ...rest, task: truncate(rest.task, TASK_PREVIEW_MAX_CHARS) }
    : rest;

  try {
    emitEvent('computer.action', {
      command,
      invocationId: runId,
      ...(drivenHost ? { host: drivenHost } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(launchId ? { launchId } : {}),
      ...extra,
    });
  } catch {
  }
}
