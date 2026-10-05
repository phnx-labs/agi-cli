
import * as fs from 'fs';
import { upsertSession } from '../session/db.js';
import type { SessionMeta, SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { isSessionTrackedAgent } from '@phnx-labs/sessions-cli/reader';
import { localLogPath, updateTask, type HostTask } from './tasks.js';
import { parseSessionIdMarker } from './session-marker.js';
import { deriveShortId } from '../text/short-id.js';
import { normalizeHost } from '../machine-id.js';

interface HostSessionContext {
  cwd: string;
  prompt: string;
}

export function hostSessionMeta(task: HostTask, ctx: HostSessionContext): SessionMeta | null {
  // Synthetic rows have no local transcript path and stamp the remote execution owner as machine.
  const id = task.sessionId;
  if (!id) return null;
  if (!isSessionTrackedAgent(task.agent)) return null;

  return {
    id,
    shortId: deriveShortId(id),
    agent: task.agent as SessionAgentId,
    timestamp: task.createdAt,
    cwd: ctx.cwd,
    filePath: '',
    machine: normalizeHost(task.host),
    topic: ctx.prompt.split('\n')[0]?.slice(0, 120) || undefined,
    label: task.name || `[host/${task.host}]`,
  };
}

export function registerHostSession(task: HostTask, ctx: HostSessionContext): void {
  const meta = hostSessionMeta(task, ctx);
  if (!meta) return;
  try {
    upsertSession(meta, '');
  } catch {
  }
}

export function captureRemoteSessionId(task: HostTask): HostTask | null {
  if (task.sessionId) return null;
  let text: string;
  try {
    text = fs.readFileSync(localLogPath(task.id), 'utf8');
  } catch {
    return null;
  }
  const captured = parseSessionIdMarker(text);
  if (!captured) return null;
  return updateTask(task.id, { sessionId: captured });
}

interface InteractiveHostSessionContext {
  cwd: string;
  host: string;
  agent: string;
  sessionId: string;
  name?: string;
  createdAt?: string;
}

export function registerInteractiveHostSession(ctx: InteractiveHostSessionContext): void {
  // Interactive TTY streams cannot be tapped; their identity is recovered through the launch-id join.
  if (!isSessionTrackedAgent(ctx.agent)) return;
  try {
    upsertSession(
      {
        id: ctx.sessionId,
        shortId: deriveShortId(ctx.sessionId),
        agent: ctx.agent as SessionAgentId,
        timestamp: ctx.createdAt ?? new Date().toISOString(),
        cwd: ctx.cwd,
        filePath: '',
        machine: normalizeHost(ctx.host),
        label: ctx.name || `[host/${ctx.host}]`,
      },
      '',
    );
  } catch {
  }
}
