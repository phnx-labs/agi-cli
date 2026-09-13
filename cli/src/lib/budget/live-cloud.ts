/**
 * Live budget kill-switch for `agents cloud` dispatch (issue #399).
 *
 * Follow-up to #346, which shipped a pre-flight budget gate for cloud runs but
 * no live mid-run enforcement — a runaway cloud task would keep spending until
 * the user hit Ctrl-C. This wires the same `makeLiveSpendWatcher` the local
 * headless run uses (src/lib/exec.ts) into the cloud SSE stream: each `usage`
 * event from the provider feeds the watcher, and on breach we call
 * `provider.cancel(taskId)` to terminate server-side.
 *
 * Wrapper shape mirrors `renderStream`'s input — it takes an
 * `AsyncIterable<CloudEvent>` and yields the same events downstream. Dormant
 * (returns the source stream unchanged) when no caps are configured.
 */
import type { CloudProvider, CloudEvent } from '../cloud/types.js';
import {
  capsFromConfig,
  makeLiveSpendWatcher,
  type BreachInfo,
} from './enforce.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';
import { loadLedger, localDay, spendForDay, spendForProject } from './ledger.js';

/** Result surface exposed to the caller so it can act on a mid-stream breach. */
interface CloudBudgetGate {
  /** True once a cap crossed and cancel() was invoked. */
  breached(): boolean;
  breach(): BreachInfo | null;
}

/**
 * Wrap a cloud event stream with a live budget watcher. On a `usage` event we
 * feed the shared watcher; on the first breach we call `provider.cancel(taskId)`
 * and forward a synthetic `status:'cancelled'` + `error` frame so the renderer
 * shows why the task stopped. Returns null when no caps are configured; callers
 * fall through to the raw stream in that case.
 */
export function wrapStreamWithBudgetGate(args: {
  provider: CloudProvider;
  taskId: string;
  /** Project attribution key — repo slug for Rush, or cwd. */
  project: string;
  /** Agent the dispatch runs under (for per_agent cap accounting). */
  agent: string;
  /** cwd used to resolve the effective budget config. */
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
            // Cancel server-side FIRST so we stop the meter; then surface the
            // breach to the renderer as an error + cancelled status so the CLI
            // exits with a visible reason (not a silent stream close).
            try {
              await args.provider.cancel(args.taskId);
            } catch (err) {
              // Best-effort — even if cancel fails, break the stream: the
              // caller sees the error frame and can retry manually.
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
