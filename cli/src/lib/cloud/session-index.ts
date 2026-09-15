/**
 * Register cloud-dispatched tasks into the LOCAL session index, keyed by the
 * real execution id, so a launch is mappable to a session immediately.
 *
 * The cloud store (`tasks.db`) and the session index (`sessions` table) were two
 * disjoint stores: a `agents cloud run` wrote only the store, and the session
 * index learned about the run only later, via `discoverCloudSessions` hitting the
 * proxy. Until that discovery ran there was no launch→session mapping at all —
 * the run was orphaned in `agents sessions` exactly like the non-Claude host runs.
 *
 * This mirrors hosts/session-index.ts: the transcript is remote (fetched on
 * demand by session/cloud.ts), so the row is registered with an EMPTY `file_path`
 * — the sentinel db.js's stale-row filter treats as "always live" — and a
 * `[cloud/<status>]` label. The row is written at dispatch and refreshed on every
 * status poll so the label tracks the task's lifecycle. Non-session-agent cloud
 * providers (a task whose agent has no transcript format) are skipped: there is
 * nothing to resolve or resume by id.
 */

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

/**
 * Register (or refresh) a cloud task in the local session index. No-op when the
 * task's agent isn't a known session agent, or its id isn't a usable execution id
 * (never a fabricated `codex-<ts>` — codex.ts fails loud instead of minting one,
 * but guard here too so a bad id can never seed a bogus row). Best-effort: a
 * failed index write must never break the dispatch/poll it rides on.
 */
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
