/**
 * Register host-dispatched runs (`agents run --device <h>`) into the LOCAL session
 * index so they show up in `agents sessions` and are resolvable by id — even
 * though the transcript itself lives on the remote host.
 *
 * The transcript file is remote, so the row is registered with an EMPTY
 * `file_path`. The DB's stale-row filter keeps rows with no file_path
 * (`!file_path || existsSync(file_path)` in db.ts querySessions) precisely for
 * this "synthetic file_path" case, and the scanner never prunes session rows —
 * so the entry survives rescans. `cwd` is the LOCAL directory the dispatch was
 * issued from, so the run appears in that project's session listing like any
 * local run. The `[host/<name>]` label mirrors the cloud path's
 * `[cloud/<status>]` convention.
 *
 * `machine` is the dispatch host, not this box. Both the transcript and the
 * version-isolated harness home live there; omitting it makes the SQLite upsert
 * infer this box from the empty file path and sends recovery to the wrong home.
 */

import * as fs from 'fs';
import { upsertSession } from '../session/db.js';
import type { SessionMeta, SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { isSessionTrackedAgent } from '@phnx-labs/sessions-cli/reader';
import { localLogPath, updateTask, type HostTask } from './tasks.js';
import { parseSessionIdMarker } from './session-marker.js';
import { deriveShortId } from '../text/short-id.js';
import { normalizeHost } from '../machine-id.js';

interface HostSessionContext {
  /** Local directory the `agents run --device` was invoked from. */
  cwd: string;
  /** Prompt the run was launched with, used for the session topic. */
  prompt: string;
}

/**
 * Build the SessionMeta for a host-dispatched run. Returns null when the run has
 * no captured session id (nothing stable to key/resume on) or its agent isn't a
 * known session agent. Pure — no I/O — so the mapping is unit-testable.
 */
export function hostSessionMeta(task: HostTask, ctx: HostSessionContext): SessionMeta | null {
  const id = task.sessionId;
  if (!id) return null;
  if (!isSessionTrackedAgent(task.agent)) return null;

  return {
    id,
    shortId: deriveShortId(id),
    agent: task.agent as SessionAgentId,
    timestamp: task.createdAt,
    cwd: ctx.cwd,
    // Remote transcript — no local file. Empty file_path is the sentinel the DB
    // stale-filter treats as "always live" (see module doc).
    filePath: '',
    machine: normalizeHost(task.host),
    topic: ctx.prompt.split('\n')[0]?.slice(0, 120) || undefined,
    // The run's `--name` seeds the label (resolves `agents sessions <name>` and
    // `agents logs <name>`); an unnamed host run falls back to the
    // `[host/<name>]` indicator, mirroring the cloud path's `[cloud/<status>]`.
    label: task.name || `[host/${task.host}]`,
  };
}

/**
 * Register (or refresh) a host-dispatched run in the local session index. No-op
 * when the task carries no session id. Best-effort: a failed write must never
 * break the dispatch itself, which has already been launched on the host.
 */
export function registerHostSession(task: HostTask, ctx: HostSessionContext): void {
  const meta = hostSessionMeta(task, ctx);
  if (!meta) return;
  try {
    upsertSession(meta, '');
  } catch {
    /* index write is best-effort; the run is already live on the host */
  }
}

/**
 * Relate a remote-created session id back to a followed host dispatch.
 *
 * The remote run (dispatched with `--emit-session-id`) prints its resolved id as
 * a stdout sentinel (see session-marker.ts) that rides the followed log into the
 * task's local mirror. Read that mirror, parse the id, and stamp it on the task
 * so `findTaskBySessionId` and the session-index registration work for agents
 * that never take a forced `--session-id` — closing the gap where every
 * non-Claude host run was orphaned.
 *
 * Returns the updated task when an id was captured (and differs from what's on
 * the record), else null. A task that already carries an id (Claude's forced id,
 * a resume) is left untouched — the marker only fills a genuinely empty slot, so
 * it can never overwrite an authoritative id with a stale echo. Best-effort: a
 * missing/unreadable mirror or absent marker yields null, never an exception.
 */
export function captureRemoteSessionId(task: HostTask): HostTask | null {
  if (task.sessionId) return null;
  let text: string;
  try {
    text = fs.readFileSync(localLogPath(task.id), 'utf8');
  } catch {
    return null; // no local mirror (unfollowed run, or read raced the follow)
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

/**
 * Register an interactive host run (no prompt, TTY forwarded over SSH) in the
 * local session index. Unlike detached host runs, there is no remote log/exit
 * file and no HostTask; we only need the session id so `agents sessions` can
 * surface and resume it by id.
 */
export function registerInteractiveHostSession(ctx: InteractiveHostSessionContext): void {
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
    /* index write is best-effort; the run is already live on the host */
  }
}
