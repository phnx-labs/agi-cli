
import type { BrowserActionEvent } from '../browser-client.js';
import { recordBrowserSession } from '../session/db.js';
import { resolveActor } from '../actor.js';

export function recordBrowserAction(event: BrowserActionEvent, opts: { device?: string } = {}): void {
  if (typeof event.task !== 'string' || typeof event.profile !== 'string') return;

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
  }
}
