/** Turn the engine's NDJSON action events (fd 4) into the durable `browser_sessions` row read by
 * `agents browser sessions`. It stays here because sessions.db is agents-cli state; a writer in
 * the engine would make it a second author (PHNX-4101). */

import type { BrowserActionEvent } from '../browser-client.js';
import { recordBrowserSession } from '../session/db.js';
import { resolveActor } from '../actor.js';

/** Record one action the engine performed. Never throws: the action already reported its own
 * result, so bookkeeping must not fail it. Only an event naming a `task` and `profile` is recorded
 * (the row is keyed `(profile, task)`); task-less verbs are skipped. */
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
