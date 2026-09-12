/**
 * record.ts — turn the engine's NDJSON action events into agents-cli's own
 * records: a feed event and a row in the computer-session history that
 * `agents computer sessions` and `agents sessions --computer` read.
 *
 * WHY THIS STAYS HERE. The feed, the actor registry, and `sessions.db` are
 * agents-cli state. Handing the standalone engine a writer for all three would
 * have made it a second author of the session index — precisely the
 * "one engine, one executor" rule the repo holds elsewhere. Instead the engine
 * reports what it did on fd 4 and agents-cli, which owns those stores, records it.
 *
 * Before PHNX-4075 this was `emitComputerAction`, called inline by each verb in
 * the same process. The behavior is unchanged; only the trigger moved from a
 * function call to a line on a pipe.
 *
 * WHAT THE ENGINE OWNS, AND IS NOT REWRITTEN HERE: the action's identity. The
 * engine mints the `invocationId` that groups a whole run into one session row,
 * names the `host` it drove, and echoes back the session/launch/actor it was
 * handed. Re-deriving any of those from this process would describe the CLI that
 * spawned the engine rather than the run that happened — and for `--device` the
 * two genuinely differ.
 */

import { randomUUID } from 'node:crypto';
import type { ComputerActionEvent } from '../computer-client.js';
import { emit as emitEvent } from '../feed/events.js';
import { recordComputerSession } from '../session/db.js';
import { resolveActor } from '../actor.js';
import { truncate } from '../feed/events.js';
import { TASK_PREVIEW_MAX_CHARS } from './sessions-list.js';

/**
 * Fallback grouping id for an engine that reported no `invocationId` of its own.
 * One per `agents computer` process, so such a run still collapses to a single
 * session row instead of N unrelated ones.
 */
export const COMPUTER_INVOCATION_ID = randomUUID();

/**
 * Record one action the engine performed. Never throws: the action already
 * happened and already reported its own success or failure on the engine's
 * stderr, so a bookkeeping failure must not turn a successful click into a
 * failed command.
 */
export function recordComputerAction(event: ComputerActionEvent, opts: { device?: string } = {}): void {
  const {
    event: _kind,
    command,
    invocationId,
    // The ledger's `pid` is the EMITTING process's by construction (events.ts
    // stamps `process.pid` over any payload value), so the engine's own pid
    // cannot be carried in it. Dropped rather than passed in to be silently
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

  // The task preview is bounded HERE, not upstream. agents-cli owns the ledger
  // and therefore its retention/privacy rule (see sessions-list.ts): an engine
  // that reported a full `--task` string must not be able to write an unbounded
  // one into the session index.
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
