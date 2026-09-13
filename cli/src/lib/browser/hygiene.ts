/**
 * Abandoned browser-task reaper (RUSH-2622).
 *
 * `agents browser done` / `stop` already close a task's tabs, but agents
 * routinely never call them — the run ends, the process exits, and the task's
 * tabs stay open in the profile window forever. Over a day of fleet activity
 * that is dozens of leftover tabs in Comet/Chrome.
 *
 * This closes the loop from the other end: a periodic pass that finds tasks
 * nobody is driving any more and stops them.
 *
 * Two independent reasons, both conservative:
 *
 *   - `session-dead` — the task recorded WHICH agent session (`sessionId`) or
 *     WHICH run (`launchId`) started it, and neither is alive on this host.
 *     That is the honest end of the task: the thing that would have called
 *     `done` no longer exists.
 *   - `idle` — nothing has touched the task for `idleMs` (default 30 minutes).
 *     The catch-all for a task with no recorded identity (a human running
 *     `agents browser start` by hand) or an agent that stalled without exiting.
 *
 * Closing always goes through `BrowserService.stop`, never a direct
 * `Target.closeTarget`, so history, the session cache, the target cache, and
 * forked-profile teardown all stay on the one code path that already handles
 * them. Two things this deliberately never does: touch a tab that is not in
 * `task.tabs` (a tab the user opened themselves is not ours to close), and kill
 * the profile window or the browser process because one task went idle.
 */
import { isPidAlive, isSessionIdLiveOnProcessTable } from '../session/active.js';
import { listPidSessionEntries, sessionIdFromLivePid, type PidSessionEntry } from '../session/pid-registry.js';
import { parseConnectionKey, type ReapResult, type ReapedTask, type Task } from './types.js';

/** Default idle window before an untouched task is reaped. */
const DEFAULT_IDLE_MS = 30 * 60_000;

/**
 * The slice of `BrowserService` the reaper needs. Structural, so a test drives
 * it with a stub and `BrowserService` satisfies it without an import — which
 * also keeps this module off the service's import cycle.
 */
export interface ReapableService {
  listTasks(): Array<{ profile: string; task: Task }>;
  recordStatus(taskName: string): Promise<{ recording: boolean }>;
  stop(taskName: string): Promise<{ ok: boolean; profile?: string }>;
}

/**
 * Injectable liveness sources. Same shape as `feed-post.ts`
 * (`input.listEntries ?? listPidSessionEntries`, feed-post.ts:119) — the
 * defaults are the real registry and the real process table, so a test can
 * substitute them without mocking a module.
 */
export interface ReapDeps {
  listEntries?: () => PidSessionEntry[];
  pidAlive?: (pid: number, startedAtMs?: number) => boolean;
  sessionIdOfPid?: (pid: number) => string | undefined;
  sessionLiveOnProcessTable?: (sessionId: string) => Promise<boolean>;
}

export interface ReapOptions {
  /**
   * Idle window in ms. Default {@link DEFAULT_IDLE_MS}.
   *
   * `null` is the explicit "idle reaping is off" signal
   * (`browser.task-idle-minutes=0`) — session-dead reaping below is
   * unaffected. A caller-supplied `0` is a DIFFERENT thing and still throws
   * (see the guard below): it is far likelier to be a bug (a value that
   * survived `??` unset) than an intentional "reap everything immediately."
   */
  idleMs?: number | null;
  /** Clock, injectable for tests. Default `Date.now()`. */
  now?: number;
  /** Report what would be closed without closing anything. */
  dryRun?: boolean;
  deps?: ReapDeps;
}

interface LiveIdentities {
  sessions: Set<string>;
  launches: Set<string>;
}

/**
 * Session and launch ids belonging to a process that is alive right now.
 *
 * Built from the per-pid launch registry, filtered to live pids —
 * `isPidAlive(pid, startedAtMs)` rather than a bare existence check, so a pid
 * the OS recycled onto an unrelated process does not read as a live agent.
 * An entry with no recorded `sessionId` still contributes one when the live
 * process carries `--session-id` on its argv, which is the RUSH-2384 recovery
 * path the registry itself documents (pid-registry.ts:102-107).
 */
export function resolveLiveIdentities(deps: ReapDeps = {}): LiveIdentities {
  const listEntries = deps.listEntries ?? listPidSessionEntries;
  const alive = deps.pidAlive ?? isPidAlive;
  const sessionIdOf = deps.sessionIdOfPid ?? sessionIdFromLivePid;

  const sessions = new Set<string>();
  const launches = new Set<string>();
  for (const entry of listEntries()) {
    if (!alive(entry.pid, entry.startedAtMs)) continue;
    const sessionId = entry.sessionId ?? sessionIdOf(entry.pid);
    if (sessionId) sessions.add(sessionId);
    if (entry.launchId) launches.add(entry.launchId);
  }
  return { sessions, launches };
}

/**
 * True when the task's owner is PROVABLY gone. The bar is proof, not absence of
 * evidence, because being wrong here closes a working agent's tabs.
 *
 * Only a `sessionId` can carry that proof. It has two independent sources — the
 * per-pid launch registry, and a live process carrying `--session-id <id>` in
 * its argv — so a session the registry missed is still caught by the process
 * table. The registry misses constantly: a wrapper pid exits, a prune sweeps
 * the entry, or the agent was never launched via `agents run`
 * (pid-registry.ts:102-107, RUSH-2384).
 *
 * A `launchId` has NO second source — the registry is its only witness, and
 * that witness is the unreliable one. So a task carrying only a `launchId` is
 * never session-reaped, exactly like a task carrying no identity at all; both
 * fall through to the idle rule. This is not a corner case: `launchId` is
 * minted for every run (`exec.ts` `resolveLaunchId`) while `AGENT_SESSION_ID`
 * is Claude-only and skipped on resume, so treating a missing registry entry as
 * proof of death would close the tabs of every live codex/droid/grok run whose
 * launch pid had already exited.
 *
 * A live `launchId` still RESCUES a task whose `sessionId` looks dead — proof of
 * life needs only one witness, unlike proof of death.
 */
export async function taskOwnerIsGone(
  task: Task,
  live: LiveIdentities,
  deps: ReapDeps = {},
): Promise<boolean> {
  if (!task.sessionId) return false;

  if (task.launchId && live.launches.has(task.launchId)) return false;
  if (live.sessions.has(task.sessionId)) return false;

  const onProcessTable = deps.sessionLiveOnProcessTable ?? ((id: string) => isSessionIdLiveOnProcessTable(id));
  return !(await onProcessTable(task.sessionId));
}

/**
 * Stop every task whose owner is gone or that has sat untouched past `idleMs`.
 *
 * Returns what it closed and how many it left alone. A task that is mid-
 * recording is always left alone: reaping it would truncate a capture the user
 * asked for, and an in-flight recording is itself proof the task is in use.
 */
export async function reapAbandonedTasks(
  service: ReapableService,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const idleDisabled = opts.idleMs === null;
  const idleMs = idleDisabled ? undefined : (opts.idleMs ?? DEFAULT_IDLE_MS);
  // Fail loud rather than reap everything. A caller-supplied `0` survives `??`
  // and would close every task including one created a millisecond ago; a
  // non-numeric value makes every `>=` comparison false and silently disables
  // idle reaping. Both are worse than an error. `null` (idleDisabled) skips
  // this check entirely — that is the one deliberate way to turn idle
  // reaping off, distinct from an accidental `0`.
  if (!idleDisabled && (!Number.isFinite(idleMs) || (idleMs as number) <= 0)) {
    throw new Error(`idleMs must be a positive number of milliseconds, got ${String(idleMs)}`);
  }
  const now = opts.now ?? Date.now();
  const deps = opts.deps ?? {};
  const live = resolveLiveIdentities(deps);

  const closed: ReapedTask[] = [];
  let skipped = 0;

  for (const { profile, task } of service.listTasks()) {
    if ((await service.recordStatus(task.name)).recording) {
      skipped++;
      continue;
    }

    let reason: ReapedTask['reason'] | undefined;
    if (await taskOwnerIsGone(task, live, deps)) {
      reason = 'session-dead';
    } else if (!idleDisabled && now - (task.lastActionAt ?? task.createdAt) >= (idleMs as number)) {
      reason = 'idle';
    }

    if (!reason) {
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      // Report the BARE profile, exactly as the real run does below — `profile`
      // here is the runtime key from `listTasks()`, and printing the two shapes
      // in one column made `gc --dry-run` and `gc` disagree (RUSH-2709).
      closed.push({ task: task.name, profile: parseConnectionKey(profile).profile, reason });
      continue;
    }

    const result = await service.stop(task.name);
    if (result.ok) {
      closed.push({ task: task.name, profile: result.profile ?? profile, reason });
    } else {
      // `stop` reports not-found only when the task already left the map — a
      // concurrent `done`, or a profile torn down mid-pass. Nothing was closed,
      // so it is not reported as closed.
      skipped++;
    }
  }

  return { closed, skipped };
}
