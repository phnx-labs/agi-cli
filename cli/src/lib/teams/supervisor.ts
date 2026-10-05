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
  onWave: (summary: WaveSummary) => void | Promise<void> | boolean | Promise<boolean>;
  budgetWatcher?: TeamBudgetWatcher | null;
  onBudgetBreach?: (breach: BreachInfo) => void;
}

interface SupervisorResult {
  waves: number;
  stoppedBy: 'drained' | 'max-waves' | 'signal' | 'callback' | 'budget';
  elapsed_ms: number;
  failed?: number;
  budgetBreach?: BreachInfo;
}

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
      // Rescan external additions, then prefetch remote state once before per-agent reads.
      await mgr.rescanFromDisk();
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

      if (opts.budgetWatcher) {
        // Poll after output/callbacks, then rescan again before declaring the DAG drained.
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
