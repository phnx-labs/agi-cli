/** Live spend watcher and cap math (issue #346), the provider-agnostic surface the loop driver
 * (#332) reuses. It takes parsed usage events and caps, accumulates cost via the pricing module,
 * and fires `onBreach` once. Claude and Codex usage count toward one `per_project`/`per_run` cap. */
import type { AgentId, BudgetConfig } from '../types.js';
import { actualCost } from '../pricing/index.js';

/** A parsed usage event from any agent's stream (fields match session/parse). */
export interface UsageEvent {
  agent?: AgentId | string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Caps the watcher enforces. `priorDaySpend`/`priorProjectSpend` seed the accumulators with ledger
 * spend from before this run, so `per_day` counts earlier runs too. Per-cap fields are USD;
 * undefined means not enforced. */
export interface LiveCaps {
  perRun?: number;
  perDay?: number;
  perProject?: number;
  /** Per-agent daily caps. Each agent's running spend is checked against its own cap. */
  perAgent?: Partial<Record<string, number>>;
  /** Day spend already on the ledger before this run (cross-vendor). */
  priorDaySpend?: number;
  /** Project spend already on the ledger before this run (cross-vendor). */
  priorProjectSpend?: number;
  /** Per-agent day spend already on the ledger before this run, keyed by agent. */
  priorAgentDaySpend?: Partial<Record<string, number>>;
}

/** Which cap tripped, and the spend figures at the moment of the breach. */
export interface BreachInfo {
  cap: 'per_run' | 'per_day' | 'per_project' | 'per_agent';
  /** The configured limit that was crossed (USD). */
  limit: number;
  /** The spend that crossed it (USD). */
  spend: number;
  /** Agent attributed to the breach (only meaningful for per_agent). */
  agent?: string;
  /** This run's accumulated spend so far (USD). */
  runSpend: number;
}

/** Public watcher surface. `feedUsage` is idempotent after a breach (no double-fire). */
export interface LiveSpendWatcher {
  /** Feed one parsed usage event; accrues cost and may fire onBreach. */
  feedUsage(event: UsageEvent): void;
  /** Total USD this run has accumulated across all fed events. */
  runSpend(): number;
  /** True once a cap has been breached. */
  breached(): boolean;
  /** Stop accepting events / release references. Idempotent. */
  dispose(): void;
}

/** Convert a resolved BudgetConfig + prior ledger spend into the caps the watcher needs. */
export function capsFromConfig(
  cfg: BudgetConfig,
  prior?: {
    daySpend?: number;
    projectSpend?: number;
    agentDaySpend?: Partial<Record<string, number>>;
  },
): LiveCaps {
  return {
    perRun: cfg.per_run,
    perDay: cfg.per_day,
    perProject: cfg.per_project,
    perAgent: cfg.per_agent,
    priorDaySpend: prior?.daySpend ?? 0,
    priorProjectSpend: prior?.projectSpend ?? 0,
    priorAgentDaySpend: prior?.agentDaySpend ?? {},
  };
}

/** Create a live spend watcher. `onBreach` fires at most once, on the first event pushing any
 * active cap from at-or-under to over. It keeps accumulating afterward so `runSpend()` stays
 * accurate for the ledger. */
export function makeLiveSpendWatcher(args: {
  caps: LiveCaps;
  onBreach: (breach: BreachInfo) => void;
}): LiveSpendWatcher {
  const { caps, onBreach } = args;
  let run = 0;
  // Cross-vendor accumulators, seeded with pre-run ledger spend.
  let day = caps.priorDaySpend ?? 0;
  let project = caps.priorProjectSpend ?? 0;
  const agentDay: Record<string, number> = {};
  for (const [k, v] of Object.entries(caps.priorAgentDaySpend ?? {})) {
    if (typeof v === 'number') agentDay[k] = v;
  }
  let didBreach = false;
  let disposed = false;

  function checkBreach(agent: string | undefined): BreachInfo | null {
    if (caps.perRun !== undefined && run > caps.perRun) {
      return { cap: 'per_run', limit: caps.perRun, spend: run, runSpend: run };
    }
    if (caps.perDay !== undefined && day > caps.perDay) {
      return { cap: 'per_day', limit: caps.perDay, spend: day, runSpend: run };
    }
    if (caps.perProject !== undefined && project > caps.perProject) {
      return { cap: 'per_project', limit: caps.perProject, spend: project, runSpend: run };
    }
    if (agent && caps.perAgent && caps.perAgent[agent] !== undefined) {
      const limit = caps.perAgent[agent] as number;
      if ((agentDay[agent] ?? 0) > limit) {
        return { cap: 'per_agent', limit, spend: agentDay[agent], agent, runSpend: run };
      }
    }
    return null;
  }

  return {
    feedUsage(event: UsageEvent): void {
      if (disposed) return;
      const { usd } = actualCost(event.model ?? '', {
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
      });
      if (usd <= 0) return;
      const agent = event.agent ? String(event.agent) : undefined;
      run += usd;
      day += usd;
      project += usd;
      if (agent) agentDay[agent] = (agentDay[agent] ?? 0) + usd;

      if (didBreach) return;
      const breach = checkBreach(agent);
      if (breach) {
        didBreach = true;
        onBreach(breach);
      }
    },
    runSpend: () => run,
    breached: () => didBreach,
    dispose() {
      disposed = true;
    },
  };
}

/** Incrementally extract usage events from a stream-json chunk, buffering a partial trailing line
 * (`rest`). Handles Claude/`--json` assistant turns (`message.usage`) and the flatter
 * `usage.record` shape. Non-JSON or usage-less lines are skipped; it never throws on agent output. */
export function extractUsageEvents(
  chunk: string,
  pending: string,
  fallbackModel?: string,
  fallbackAgent?: string,
): { events: UsageEvent[]; rest: string } {
  const combined = pending + chunk;
  const lines = combined.split('\n');
  const rest = lines.pop() ?? '';
  const events: UsageEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ev = usageFromObject(obj, fallbackModel, fallbackAgent);
    if (ev) events.push(ev);
  }
  return { events, rest };
}

function usageFromObject(obj: any, fallbackModel?: string, fallbackAgent?: string): UsageEvent | null {
  // Claude's final `type:"result"` event carries a cumulative top-level `usage` summing every
  // per-turn `message.usage`, so counting both double-counts (~2x). The canonical parser
  // (src/lib/session/parse.ts) reads only `message.usage`; skip result lines for usage.
  if (obj?.type === 'result') return null;

  // Claude stream-json assistant turn.
  const mu = obj?.message?.usage;
  if (mu && (typeof mu.input_tokens === 'number' || typeof mu.output_tokens === 'number')) {
    return {
      agent: fallbackAgent,
      model: obj.message.model ?? fallbackModel,
      inputTokens: mu.input_tokens ?? 0,
      outputTokens: mu.output_tokens ?? 0,
      cacheReadTokens: mu.cache_read_input_tokens,
      cacheCreationTokens: mu.cache_creation_input_tokens,
    };
  }
  // Flatter usage.record / usage shape (Codex / `usage.record`). The result-line
  // guard above already excludes Claude's cumulative result usage, so this only
  // matches genuine per-event usage records.
  const u = obj?.usage;
  if (u && (typeof u.input_tokens === 'number' || typeof u.output === 'number' || typeof u.output_tokens === 'number')) {
    return {
      agent: fallbackAgent,
      model: obj.model ?? u.model ?? fallbackModel,
      inputTokens: u.input_tokens ?? u.inputOther ?? 0,
      outputTokens: u.output_tokens ?? u.output ?? 0,
      cacheReadTokens: u.cache_read_input_tokens,
      cacheCreationTokens: u.cache_creation_input_tokens,
    };
  }
  return null;
}
