/**
 * record.ts — turn the engine's NDJSON action events (fd 4) into the durable
 * `browser_sessions` row that `agents browser sessions` and `agents sessions
 * --browser` read to link a browser task back to the agent session that drove it.
 *
 * WHY THIS STAYS HERE. `sessions.db` is agents-cli state. Handing the standalone
 * engine a writer for it would have made it a second author of the session index
 * — precisely the "one engine, one executor" rule the repo holds elsewhere.
 * Instead the engine reports what it did on fd 4 and agents-cli, which owns the
 * store, records it.
 *
 * Before PHNX-4101 this upsert ran INSIDE the browser daemon at task start
 * (`BrowserService.start` → `recordBrowserSession`), with the identity resolved
 * in the calling CLI and forwarded over IPC. The engine now streams that identity
 * back on fd 4 instead, and this CLI process — the one the user actually ran, so
 * the actor is right — performs the upsert. The behavior is unchanged; only the
 * trigger moved from an IPC call to a line on a pipe.
 *
 * The feed's browser tool rows are projected from the on-disk captures and the
 * live `tasks.json` (`lib/feed/tool-activity.ts`), not from a per-action event
 * ledger, so — unlike `lib/computer/record.ts` — this emits no feed event: the
 * durable row is the whole job, and every consumer already reads it.
 */

import type { BrowserActionEvent } from '../browser-client.js';
import { recordBrowserSession } from '../session/db.js';
import { resolveActor } from '../actor.js';

/**
 * Record one action the engine performed. Never throws: the action already
 * happened and already reported its own success or failure on the engine's
 * stderr, so a bookkeeping failure must not turn a successful navigate into a
 * failed command.
 *
 * Only an event that names a `task` AND a `profile` can be recorded — the
 * `browser_sessions` row is keyed on `(profile, task)`. A task-less verb
 * (`profiles list`, `status`) carries neither and is skipped, exactly as the old
 * inline recorder only ran for task-scoped verbs.
 */
export function recordBrowserAction(event: BrowserActionEvent, opts: { device?: string } = {}): void {
  if (typeof event.task !== 'string' || typeof event.profile !== 'string') return;

  // The driven machine. `host` is what a `--device` invocation stamps; `opts.device`
  // is the fallback for an engine that drove the device this CLI resolved but did
  // not echo it back. Both absent → a local run, recorded under this machine.
  const machine = event.host ?? opts.device;

  try {
    recordBrowserSession({
      task: event.task,
      profile: event.profile,
      sessionId: event.sessionId ?? process.env.AGENT_SESSION_ID ?? process.env.AGENTS_SESSION_ID,
      launchId: event.launchId ?? process.env.AGENT_LAUNCH_ID,
      actor: event.actor ?? resolveActor().id,
      ...(machine ? { machine } : {}),
    });
  } catch {
    // Recording is best-effort; the action is already done.
  }
}
