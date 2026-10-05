/** Live budget kill-switch for the teams supervisor (issue #399). Per-teammate `per_run` caps fire
 * in child watchers, but aggregate caps (`per_project`/`per_day`/`per_agent`) were missed since
 * the ledger is written on child close. Each wave tails teammate logs into a shared watcher. */
import * as fs from 'fs';
import type { AgentManager } from '../teams/agents.js';
import {
  capsFromConfig,
  extractUsageEvents,
  makeLiveSpendWatcher,
  type BreachInfo,
  type LiveSpendWatcher,
} from './enforce.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';
import { loadLedger, localDay, spendForDay, spendForProject } from './ledger.js';

/** Public surface of the team-scoped budget watcher. */
export interface TeamBudgetWatcher {
  /** Feed any new usage events from every running teammate's stdout.log. */
  poll(): Promise<void>;
  /** True once any cap has been crossed (mirrors LiveSpendWatcher). */
  breached(): boolean;
  /** The first breach seen, or null if none yet. */
  breach(): BreachInfo | null;
  /** Release references and stop tapping streams. Idempotent. */
  dispose(): void;
}

/** Per-teammate cursor tracking how far we've read the stdout.log. */
interface StreamCursor {
  offset: number;
  pending: string;
}

/** Build a team-scoped budget watcher; null when the effective budget has no caps (dormant, like
 * the local watcher). Seeded with prior-day and prior-project ledger spend, each `poll()` feeds
 * new teammate stdout usage into the shared watcher, and `onBreach` fires once. */
export function createTeamBudgetWatcher(args: {
  manager: AgentManager;
  team: string;
  /** Project/cwd used to (a) resolve budget config and (b) seed project spend. */
  cwd: string;
  onBreach: (breach: BreachInfo) => void;
}): TeamBudgetWatcher | null {
  const cfg = resolveBudgetConfig(args.cwd);
  if (!hasAnyCap(cfg)) return null;

  const today = localDay();
  const entries = loadLedger();
  const caps = capsFromConfig(cfg, {
    daySpend: spendForDay(today, entries),
    projectSpend: spendForProject(args.cwd, entries),
  });

  let firstBreach: BreachInfo | null = null;
  const watcher: LiveSpendWatcher = makeLiveSpendWatcher({
    caps,
    onBreach: (b) => {
      firstBreach = b;
      args.onBreach(b);
    },
  });

  const cursors = new Map<string, StreamCursor>();
  let disposed = false;

  return {
    async poll(): Promise<void> {
      if (disposed || watcher.breached()) return;
      const teammates = await args.manager.listByTask(args.team);
      for (const agent of teammates) {
        // Only tap running local teammates: PENDING has no output yet, cloud
        // teammates emit through a different channel (their own SSE stream),
        // and terminal states produce no new bytes.
        if (agent.status !== 'running') continue;
        if (agent.cloudProvider) continue;

        const stdoutPath = await agent.getStdoutPath();
        let stat: fs.Stats;
        try {
          stat = fs.statSync(stdoutPath);
        } catch {
          continue; // File not yet created — nothing to read.
        }

        const cursor = cursors.get(agent.agentId) ?? { offset: 0, pending: '' };
        if (stat.size <= cursor.offset) {
          cursors.set(agent.agentId, cursor);
          continue;
        }

        const fd = fs.openSync(stdoutPath, 'r');
        try {
          const toRead = stat.size - cursor.offset;
          const buffer = Buffer.alloc(toRead);
          const bytesRead = fs.readSync(fd, buffer, 0, toRead, cursor.offset);
          const chunk = buffer.toString('utf-8', 0, bytesRead);
          cursor.offset += bytesRead;

          const { events, rest } = extractUsageEvents(
            chunk,
            cursor.pending,
            undefined,
            agent.agentType,
          );
          cursor.pending = rest;
          for (const ev of events) {
            watcher.feedUsage(ev);
            if (watcher.breached()) break;
          }
        } finally {
          fs.closeSync(fd);
        }
        cursors.set(agent.agentId, cursor);
        if (watcher.breached()) return;
      }
    },
    breached: () => watcher.breached(),
    breach: () => firstBreach,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      watcher.dispose();
      cursors.clear();
    },
  };
}
