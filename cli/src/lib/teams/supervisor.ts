/**
 * DAG supervisor — the continuous dispatch loop that makes the Factory
 * dynamic.
 *
 * `teams start --watch` and `factory run` both use this. Each wave:
 *   1. call startReady(team) to fire any now-ready teammates
 *   2. listByTask(team) to count pending / running / done / failed
 *   3. emit one status event (via the caller's callback)
 *   4. exit when pending + running == 0 (DAG drained)
 *
 * Why a shared function:
 *  - the loop is the orchestration, the thing that lets any worker add
 *    tasks mid-flight via `agents teams add` and have them picked up
 *  - `factory run` is just `teams start --watch` with factory-flavored
 *    presentation; keeping them in sync avoids drift
 *
 * The caller supplies a presenter callback so the same loop can drive
 * terminal output, json-per-wave output, or a TUI.
 */
import type { AgentManager, AgentProcess } from './agents.js';
import type { TeamBudgetWatcher } from '../budget/live-team.js';
import type { BreachInfo } from '../budget/enforce.js';

interface WaveSummary {
  wave: number;
  timestamp: string;
  team: string;
  launched: AgentProcess[];
  pending: number;
  running: number;
  completed: number;
  failed: number;
  drained: boolean;
}

interface SupervisorOptions {
  team: string;
  intervalMs?: number;
  maxWaves?: number;
  /** Called once per wave. Return false to stop the loop gracefully. */
  onWave: (summary: WaveSummary) => void | Promise<void> | boolean | Promise<boolean>;
  /**
   * Optional live-spend watcher (issue #399). Polled once per wave; on first
   * breach the supervisor calls `manager.stopByTask(team)` and exits with
   * `stoppedBy: 'budget'`. Dormant when null — supervisor behavior is unchanged
   * for teams that never opt into budget enforcement.
   */
  budgetWatcher?: TeamBudgetWatcher | null;
  /** Called with the breach details when the budget watcher trips. */
  onBudgetBreach?: (breach: BreachInfo) => void;
}

interface SupervisorResult {
  waves: number;
  stoppedBy: 'drained' | 'max-waves' | 'signal' | 'callback' | 'budget';
  elapsed_ms: number;
  /**
   * Number of teammates in the `failed` state when the team drained. Only set
   * for `stoppedBy === 'drained'`. A drained DAG means nothing is pending or
   * running — NOT that everything succeeded — so callers that treat "drained"
   * as success (e.g. a completion nudge) must check `failed === 0` first.
   */
  failed?: number;
  /** Set when `stoppedBy === 'budget'` — the breach that terminated the team. */
  budgetBreach?: BreachInfo;
}

/**
 * Run the continuous DAG dispatcher until the team drains, the caller
 * returns false from onWave, or SIGINT/SIGTERM arrives.
 */
export async function runSupervisor(
  mgr: AgentManager,
  opts: SupervisorOptions
): Promise<SupervisorResult> {
  const intervalMs = opts.intervalMs ?? 8000;
  const maxWaves = opts.maxWaves ?? 1000;
  const team = opts.team;
  const startedAt = Date.now();

  let stopSignal = false;
  const onSig = () => { stopSignal = true; };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  try {
    for (let wave = 1; wave <= maxWaves; wave++) {
      // Pick up teammates added by other processes (e.g. the Planner's
      // `agents teams add` calls). Without this the supervisor only ever
      // sees teammates it created itself.
      await mgr.rescanFromDisk();
      // Distributed teammates: one ssh-per-host liveness/exit pre-pass BEFORE any
      // polling this wave, so every subsequent per-teammate status read
      // (startReady's roster scan + listByTask below) consumes a cached snapshot
      // instead of each opening its own SSH handshake — no N-round-trips-per-wave
      // blowup at 10+ remote teammates. No-op for all-local teams. Reads the
      // in-memory roster directly, so it doesn't itself trigger a poll.
      await mgr.prefetchRemoteStatus(team);
      const launched = await mgr.startReady(team);
      const all = await mgr.listByTask(team);
      let pending = 0, running = 0, completed = 0, failed = 0;
      for (const a of all) {
        if (a.status === 'pending') pending++;
        else if (a.status === 'running') running++;
        else if (a.status === 'completed') completed++;
        else if (a.status === 'failed') failed++;
      }
      const summary: WaveSummary = {
        wave,
        timestamp: new Date().toISOString(),
        team,
        launched,
        pending,
        running,
        completed,
        failed,
        drained: pending === 0 && running === 0,
      };

      const keepGoing = await opts.onWave(summary);
      if (keepGoing === false) {
        return { waves: wave, stoppedBy: 'callback', elapsed_ms: Date.now() - startedAt };
      }

      // Live budget kill (issue #399). Poll AFTER the wave's callback so the
      // most recent teammate stdout is already flushed to disk. On breach we
      // stop every RUNNING teammate — the DAG effectively drains this wave.
      if (opts.budgetWatcher) {
        await opts.budgetWatcher.poll();
        if (opts.budgetWatcher.breached()) {
          const breach = opts.budgetWatcher.breach();
          await mgr.stopByTask(team);
          if (breach && opts.onBudgetBreach) opts.onBudgetBreach(breach);
          opts.budgetWatcher.dispose();
          return {
            waves: wave,
            stoppedBy: 'budget',
            elapsed_ms: Date.now() - startedAt,
            budgetBreach: breach ?? undefined,
          };
        }
      }

      // Re-check drain AFTER the callback. The callback may have added new
      // teammates mid-flight (that's the whole point of the dynamic DAG), so
      // trusting the pre-callback snapshot would drain prematurely. Rescan
      // too, because the callback could have triggered a sibling process
      // that wrote a fresh meta.json.
      await mgr.rescanFromDisk();
      const afterCallback = await mgr.listByTask(team);
      const stillLive = afterCallback.some(
        (a) => a.status === 'pending' || a.status === 'running'
      );
      if (!stillLive) {
        const failed = afterCallback.filter((a) => a.status === 'failed').length;
        return { waves: wave, stoppedBy: 'drained', failed, elapsed_ms: Date.now() - startedAt };
      }
      if (stopSignal) {
        return { waves: wave, stoppedBy: 'signal', elapsed_ms: Date.now() - startedAt };
      }
      await new Promise((r) => setTimeout(r, intervalMs));
      if (stopSignal) {
        return { waves: wave, stoppedBy: 'signal', elapsed_ms: Date.now() - startedAt };
      }
    }
    return { waves: maxWaves, stoppedBy: 'max-waves', elapsed_ms: Date.now() - startedAt };
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
