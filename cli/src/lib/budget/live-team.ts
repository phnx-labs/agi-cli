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

export interface TeamBudgetWatcher {
  poll(): Promise<void>;
  breached(): boolean;
  breach(): BreachInfo | null;
  dispose(): void;
}

interface StreamCursor {
  offset: number;
  pending: string;
}

export function createTeamBudgetWatcher(args: {
  manager: AgentManager;
  team: string;
  cwd: string;
  onBreach: (breach: BreachInfo) => void;
}): TeamBudgetWatcher | null {
  // One watcher aggregates every local teammate against the team's shared persisted caps.
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
        if (agent.status !== 'running') continue;
        if (agent.cloudProvider) continue; // Cloud streams enforce their own server-side gate.

        const stdoutPath = await agent.getStdoutPath();
        let stat: fs.Stats;
        try {
          stat = fs.statSync(stdoutPath);
        } catch {
          continue;
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
