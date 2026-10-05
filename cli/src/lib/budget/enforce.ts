import type { AgentId, BudgetConfig } from '../types.js';
import { actualCost } from '../pricing/index.js';

export interface UsageEvent {
  agent?: AgentId | string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LiveCaps {
  perRun?: number;
  perDay?: number;
  perProject?: number;
  perAgent?: Partial<Record<string, number>>;
  priorDaySpend?: number;
  priorProjectSpend?: number;
  priorAgentDaySpend?: Partial<Record<string, number>>;
}

export interface BreachInfo {
  cap: 'per_run' | 'per_day' | 'per_project' | 'per_agent';
  limit: number;
  spend: number;
  agent?: string;
  runSpend: number;
}

export interface LiveSpendWatcher {
  feedUsage(event: UsageEvent): void;
  runSpend(): number;
  breached(): boolean;
  dispose(): void;
}

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

export function makeLiveSpendWatcher(args: {
  caps: LiveCaps;
  onBreach: (breach: BreachInfo) => void;
}): LiveSpendWatcher {
  const { caps, onBreach } = args;
  let run = 0;
  // Persisted ledger spend seeds shared day/project/agent caps; only run spend starts at zero.
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

      // Keep accounting after the first breach, but invoke the destructive callback only once.
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

export function extractUsageEvents(
  chunk: string,
  pending: string,
  fallbackModel?: string,
  fallbackAgent?: string,
): { events: UsageEvent[]; rest: string } {
  // stdout chunks may split a JSON record; retain the incomplete final line for the next feed.
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
  // Claude result events repeat message usage, so charging them would double-count the run.
  if (obj?.type === 'result') return null;

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
