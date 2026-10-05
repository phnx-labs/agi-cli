/** Turn the engine's NDJSON action events into agents-cli records: a feed event and a
 * computer-session history row. Stays here because the feed, actor registry and `sessions.db` are
 * agents-cli state; the engine must not become a second author of the session index. */

import { randomUUID } from 'node:crypto';
import type { ComputerActionEvent } from '../computer-client.js';
import { emit as emitEvent } from '../feed/events.js';
import { recordComputerSession } from '../session/db.js';
import { resolveActor } from '../actor.js';
import { truncate } from '../feed/events.js';
import { TASK_PREVIEW_MAX_CHARS } from './sessions-list.js';

/** Fallback grouping id for an engine that reports no `invocationId`: one per `agents computer`
 * process, so such a run is one session row instead of N. */
export const COMPUTER_INVOCATION_ID = randomUUID();

/** Record one action the engine performed. Never throws: the action already reported its own
 * result, so a bookkeeping failure must not turn a successful click into a failed command. */
export function recordComputerAction(event: ComputerActionEvent, opts: { device?: string } = {}): void {
  const {
    event: _kind,
    command,
    invocationId,
    // The ledger's `pid` is the emitting process's (events.ts stamps `process.pid` over any
    // payload value), so the engine's pid cannot be carried; it is dropped rather than silently
    // overwritten.
    pid: _enginePid,
    host,
    sessionId,
    launchId,
    actor,
    ...rest
  } = event;

  const runId = invocationId || COMPUTER_INVOCATION_ID;
  // The driven machine. `host` is the field `sessions-list.ts` reads for a
  // remote run; `opts.device` is the fallback for an engine that drove the
  // device this CLI resolved but did not stamp it.
  const drivenHost = host ?? opts.device;

  // The task preview is bounded here, not upstream: agents-cli owns the ledger and its
  // retention/privacy rule (see sessions-list.ts), so an engine cannot write an unbounded `--task`
  // into the session index.
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
    // Feed emission is best-effort; the action is already done.
  }
  try {
    recordComputerSession({
      invocationId: runId,
      sessionId: sessionId ?? process.env.AGENT_SESSION_ID ?? process.env.AGENTS_SESSION_ID,
      launchId: launchId ?? process.env.AGENT_LAUNCH_ID,
      actor: actor ?? resolveActor().id,
      actionCount: 1,
      taskPreview: typeof extra.task === 'string' ? extra.task : undefined,
    });
  } catch {
    // Recording is best-effort; the action and its event are already done.
  }
}
