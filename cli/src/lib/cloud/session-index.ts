/** Register cloud-dispatched tasks into the local session index by real execution id, so a launch
 * maps to a session immediately (previously orphaned until `discoverCloudSessions`). Mirrors
 * hosts/session-index.ts: EMPTY `file_path`, `[cloud/<status>]` label, refreshed on each poll. */

import { upsertSession } from '../session/db.js';
import type { SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { isSessionTrackedAgent } from '@phnx-labs/sessions-cli/reader';
import { deriveShortId } from '../session/short-id.js';
import type { CloudTask } from './types.js';

/** The execution-id charset the session index will accept as a row id. */
const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** Context a cloud task needs to become a session row — the LOCAL dir it was launched from. */
interface CloudSessionContext {
  /** Local directory `agents cloud run` was invoked from. Defaults to process.cwd(). */
  cwd?: string;
}

/** Register or refresh a cloud task in the local session index. No-op for non-session agents or
 * unusable execution ids (never a fabricated `codex-<ts>`). Best-effort: an index failure must not
 * break the dispatch/poll. */
export function registerCloudSession(task: CloudTask, ctx: CloudSessionContext = {}): void {
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
        // Remote transcript — no local file yet. Empty file_path is the sentinel
        // the DB stale-filter treats as "always live" (see hosts/session-index.ts).
        filePath: '',
        topic: task.prompt.split('\n')[0]?.slice(0, 120) || undefined,
        // Mirrors session/cloud.ts's discovered label, so the dispatch-time row and
        // a later proxy-discovered row read the same in `agents sessions`.
        label: `[cloud/${task.status}]${task.branch ? ` ${task.branch}` : ''}`,
        prUrl: task.prUrl,
      },
      '',
    );
  } catch {
    /* index write is best-effort; the task is already persisted in the cloud store */
  }
}
