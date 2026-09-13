import * as path from 'path';

import { gcMailbox } from '../mailbox-gc.js';
import { mailboxIdForActiveSession } from '../mailbox-target.js';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { loadLocalActiveSessions } from '../session/session-cache.js';
import { getRuntimeStateDir } from '../state.js';
import { runWatchdogTick, type WatchdogThresholds, type WatchdogTickResult } from './runner.js';

interface WatchdogPassOptions {
  nudge: boolean;
  nudgeText?: string;
  smartAgent?: string;
  thresholds?: WatchdogThresholds;
  allowGhosttyFocus?: boolean;
  sessions?: ActiveSession[];
  stateDir?: string;
  mailboxGc?: boolean;
}

export async function loadWatchdogSessions(): Promise<ActiveSession[]> {
  const loaded = await loadLocalActiveSessions({
    gather: () => getActiveSessions({ localOnly: true }),
  });
  return loaded.sessions;
}

function runWatchdogMailboxGc(sessions: ActiveSession[]): void {
  const activeBoxIds = new Set(
    sessions.map(mailboxIdForActiveSession).filter((id): id is string => Boolean(id)),
  );
  try {
    gcMailbox(activeBoxIds);
  } catch {
    // Housekeeping is retried by the next daemon tick.
  }
}

/** Execute one watchdog pass from the daemon or the explicit CLI command. */
export async function runWatchdogPass(opts: WatchdogPassOptions): Promise<WatchdogTickResult> {
  const sessions = opts.sessions ?? await loadWatchdogSessions();
  const result = await runWatchdogTick({
    nudge: opts.nudge,
    nudgeText: opts.nudgeText,
    smartAgent: opts.smartAgent,
    thresholds: opts.thresholds,
    allowGhosttyFocus: opts.allowGhosttyFocus,
    stateDir: opts.stateDir ?? path.join(getRuntimeStateDir(), 'watchdog'),
    sessions,
  });
  if (opts.mailboxGc !== false) runWatchdogMailboxGc(sessions);
  return result;
}
