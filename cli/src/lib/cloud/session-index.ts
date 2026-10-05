
import { upsertSession } from '../session/db.js';
import type { SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { isSessionTrackedAgent } from '@phnx-labs/sessions-cli/reader';
import { deriveShortId } from '../session/short-id.js';
import type { CloudTask } from './types.js';

const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

interface CloudSessionContext {
  cwd?: string;
}

export function registerCloudSession(task: CloudTask, ctx: CloudSessionContext = {}): void {
  // Empty filePath is the remote-transcript sentinel; indexing is best-effort and cannot fail dispatch.
  if (!task.agent || !isSessionTrackedAgent(task.agent)) return;
  if (!task.id || !EXECUTION_ID_RE.test(task.id)) return;
  try {
    upsertSession(
      {
        id: task.id,
        shortId: deriveShortId(task.id),
        agent: task.agent as SessionAgentId,
        timestamp: task.createdAt,
        lastActivity: task.updatedAt,
        cwd: ctx.cwd ?? process.cwd(),
        project: task.repo ?? task.repos?.[0],
        filePath: '',
        topic: task.prompt.split('\n')[0]?.slice(0, 120) || undefined,
        label: `[cloud/${task.status}]${task.branch ? ` ${task.branch}` : ''}`,
        prUrl: task.prUrl,
      },
      '',
    );
  } catch {
  }
}
