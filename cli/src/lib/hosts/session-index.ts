/** Register host-dispatched runs in the local session index so they show in `agents sessions`
 * though the transcript is remote: empty `file_path` (never pruned), local `cwd`,
 * `[host/<name>]` label. `machine` is the dispatch host, or recovery picks the wrong home. */

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

/** Build the SessionMeta for a host-dispatched run; null when no session id was captured or the
 * agent isn't a known session agent. Pure, so it is unit-testable. */
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

/** Register (or refresh) a host-dispatched run in the local session index; no-op without a
 * session id. Best-effort: a failed write must not break the already-launched dispatch. */
export function registerHostSession(task: HostTask, ctx: HostSessionContext): void {
  const meta = hostSessionMeta(task, ctx);
  if (!meta) return;
  try {
    upsertSession(meta, '');
  } catch {
    /* index write is best-effort; the run is already live on the host */
  }
}

/** Relate a remote-created session id to a followed dispatch: parse the `--emit-session-id`
 * sentinel from the local log mirror and stamp it on the task, so non-Claude host runs aren't
 * orphaned. Returns the updated task or null; an existing id is never overwritten. */
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

/** Register an interactive host run (TTY over SSH) in the local session index. There is no
 * remote log, exit file or HostTask; only the session id is needed so `agents sessions` can
 * show and resume it. */
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
