import type { CloudProvider, CloudEvent } from '../cloud/types.js';
import {
  capsFromConfig,
  makeLiveSpendWatcher,
  type BreachInfo,
} from './enforce.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';
import { loadLedger, localDay, spendForDay, spendForProject } from './ledger.js';

interface CloudBudgetGate {
  breached(): boolean;
  breach(): BreachInfo | null;
}

export function wrapStreamWithBudgetGate(args: {
  provider: CloudProvider;
  taskId: string;
  project: string;
  agent: string;
  cwd?: string;
}): {
  wrap: (source: AsyncIterable<CloudEvent>) => AsyncIterable<CloudEvent>;
  gate: CloudBudgetGate;
} | null {
  const cfg = resolveBudgetConfig(args.cwd);
  if (!hasAnyCap(cfg)) return null;

  const today = localDay();
  const entries = loadLedger();
  const caps = capsFromConfig(cfg, {
    daySpend: spendForDay(today, entries),
    projectSpend: spendForProject(args.project, entries),
  });

  let firstBreach: BreachInfo | null = null;
  const watcher = makeLiveSpendWatcher({
    caps,
    onBreach: (b) => {
      firstBreach = b;
    },
  });

  async function* wrap(source: AsyncIterable<CloudEvent>): AsyncIterable<CloudEvent> {
    try {
      for await (const event of source) {
        if (event.type === 'usage') {
          watcher.feedUsage({
            agent: args.agent,
            model: event.model,
            inputTokens: event.inputTokens ?? 0,
            outputTokens: event.outputTokens ?? 0,
          });
          if (watcher.breached() && firstBreach) {
            // Stopping local iteration is insufficient: cancel the provider task server-side.
            try {
              await args.provider.cancel(args.taskId);
            } catch (err) {
              yield {
                type: 'error',
                message: `[budget] cap ${firstBreach.cap} exceeded ($${firstBreach.spend.toFixed(2)} > $${firstBreach.limit.toFixed(2)}); cancel FAILED: ${(err as Error).message}`,
                timestamp: new Date().toISOString(),
              };
              yield { type: 'status', status: 'cancelled', timestamp: new Date().toISOString() };
              return;
            }
            yield {
              type: 'error',
              message: `[budget] cap ${firstBreach.cap} exceeded ($${firstBreach.spend.toFixed(2)} > $${firstBreach.limit.toFixed(2)}) — cancelled cloud task ${args.taskId}`,
              timestamp: new Date().toISOString(),
            };
            yield { type: 'status', status: 'cancelled', timestamp: new Date().toISOString() };
            return;
          }
        }
        yield event;
      }
    } finally {
      watcher.dispose();
    }
  }

  return {
    wrap,
    gate: {
      breached: () => watcher.breached(),
      breach: () => firstBreach,
    },
  };
}
