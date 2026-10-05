import type { BudgetConfig } from '../types.js';
import { estimateCost, formatUsd } from '../pricing/index.js';
import { loadLedger, spendForDay, spendForAgentDay, spendForProject, localDay } from './ledger.js';
import type { SpendEntry } from './ledger.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';

interface RunEstimate {
  estUsd: number;
  basis: 'ledger-average' | 'prompt-heuristic' | 'none';
  priced: boolean;
  estInputTokens: number;
  estOutputTokens: number;
}

const CHARS_PER_TOKEN = 4;
const HEURISTIC_OUTPUT_MULTIPLIER = 6;

export function estimateRunCost(args: {
  agent: string;
  model: string;
  mode?: string;
  promptChars?: number;
  recentAvgTokens?: { input: number; output: number };
  ledger?: SpendEntry[];
}): RunEstimate {
  const ledger = args.ledger ?? loadLedger();
  let estInputTokens = 0;
  let estOutputTokens = 0;
  let basis: RunEstimate['basis'] = 'none';

  const avg = args.recentAvgTokens ?? ledgerAverageTokens(args.agent, ledger);
  if (avg && (avg.input > 0 || avg.output > 0)) {
    estInputTokens = avg.input;
    estOutputTokens = avg.output;
    basis = 'ledger-average';
  } else if (args.promptChars && args.promptChars > 0) {
    estInputTokens = Math.ceil(args.promptChars / CHARS_PER_TOKEN);
    estOutputTokens = estInputTokens * HEURISTIC_OUTPUT_MULTIPLIER;
    basis = 'prompt-heuristic';
  }

  const { usd, modelMatched } = estimateCost(args.model, {
    inputTokens: estInputTokens,
    outputTokens: estOutputTokens,
  });

  return {
    estUsd: usd,
    basis: estInputTokens === 0 && estOutputTokens === 0 ? 'none' : basis,
    priced: modelMatched !== null,
    estInputTokens,
    estOutputTokens,
  };
}

export function ledgerAverageTokens(
  agent: string,
  ledger: SpendEntry[],
): { input: number; output: number } | null {
  const runs = new Map<string, { input: number; output: number }>();
  for (const e of ledger) {
    if (e.agent !== agent) continue;
    const acc = runs.get(e.runId) ?? { input: 0, output: 0 };
    acc.input += e.inputTok;
    acc.output += e.outputTok;
    runs.set(e.runId, acc);
  }
  if (runs.size === 0) return null;
  let input = 0;
  let output = 0;
  for (const r of runs.values()) {
    input += r.input;
    output += r.output;
  }
  return { input: Math.round(input / runs.size), output: Math.round(output / runs.size) };
}

interface PreflightDecision {
  allow: boolean;
  needsConfirm: boolean;
  reason?: string;
  blockedCap?: 'per_run' | 'per_day' | 'per_agent' | 'per_project';
  projectedDaySpend: number;
  projectedProjectSpend: number;
}

export interface LedgerState {
  agent: string;
  daySpend: number;
  projectSpend: number;
  agentDaySpend: number;
}

export function ledgerStateFor(agent: string, project: string, ledger?: SpendEntry[]): LedgerState {
  const entries = ledger ?? loadLedger();
  const today = localDay();
  return {
    agent,
    daySpend: spendForDay(today, entries),
    projectSpend: spendForProject(project, entries),
    agentDaySpend: spendForAgentDay(agent, today, entries),
  };
}

export function enforcePreflight(
  cfg: BudgetConfig,
  state: LedgerState,
  est: RunEstimate,
): PreflightDecision {
  const projectedDaySpend = state.daySpend + est.estUsd;
  const projectedProjectSpend = state.projectSpend + est.estUsd;
  const projectedAgentDaySpend = state.agentDaySpend + est.estUsd;
  const warnOnly = cfg.on_exceed === 'warn';

  const breaches: { cap: PreflightDecision['blockedCap']; reason: string }[] = [];
  if (cfg.per_run !== undefined && est.estUsd > cfg.per_run) {
    breaches.push({
      cap: 'per_run',
      reason: `estimated ${formatUsd(est.estUsd)} exceeds per_run cap ${formatUsd(cfg.per_run)}`,
    });
  }
  if (cfg.per_day !== undefined && projectedDaySpend > cfg.per_day) {
    breaches.push({
      cap: 'per_day',
      reason: `projected day spend ${formatUsd(projectedDaySpend)} exceeds per_day cap ${formatUsd(cfg.per_day)}`,
    });
  }
  if (cfg.per_project !== undefined && projectedProjectSpend > cfg.per_project) {
    breaches.push({
      cap: 'per_project',
      reason: `projected project spend ${formatUsd(projectedProjectSpend)} exceeds per_project cap ${formatUsd(cfg.per_project)}`,
    });
  }
  const agentCap = cfg.per_agent?.[state.agent as keyof typeof cfg.per_agent];
  if (agentCap !== undefined && projectedAgentDaySpend > agentCap) {
    breaches.push({
      cap: 'per_agent',
      reason: `projected agent day spend ${formatUsd(projectedAgentDaySpend)} exceeds per_agent cap ${formatUsd(agentCap)}`,
    });
  }

  let needsConfirm =
    cfg.require_confirm_over !== undefined && est.estUsd >= cfg.require_confirm_over;

  if (!est.priced && hasAnyCap(cfg) && breaches.length === 0) {
    needsConfirm = true;
    return {
      allow: true,
      needsConfirm: true,
      reason: `model is unpriced — budget caps cannot be enforced for this run (estimate is $0); confirm to proceed`,
      projectedDaySpend,
      projectedProjectSpend,
    };
  }

  if (breaches.length > 0) {
    const first = breaches[0];
    return {
      allow: warnOnly,
      needsConfirm: warnOnly ? needsConfirm : false,
      reason: first.reason,
      blockedCap: first.cap,
      projectedDaySpend,
      projectedProjectSpend,
    };
  }

  return {
    allow: true,
    needsConfirm,
    reason: needsConfirm
      ? `estimated ${formatUsd(est.estUsd)} is at or above confirm threshold ${formatUsd(cfg.require_confirm_over as number)}`
      : undefined,
    projectedDaySpend,
    projectedProjectSpend,
  };
}

function formatEstimateBanner(agent: string, model: string, est: RunEstimate): string {
  const cost = est.priced ? formatUsd(est.estUsd) : 'unpriced';
  const basisLabel =
    est.basis === 'ledger-average'
      ? 'recent average'
      : est.basis === 'prompt-heuristic'
        ? 'prompt size'
        : 'no basis';
  return `[budget] est. ${cost} for this ${agent} run (${model}, ${basisLabel})`;
}

interface PreflightGateResult {
  dormant: boolean;
  cfg: BudgetConfig;
  estimate: RunEstimate;
  decision: PreflightDecision;
  banner: string;
}

export function runPreflightGate(args: {
  agent: string;
  model: string;
  mode?: string;
  prompt?: string;
  project: string;
  cwd?: string;
  ledger?: SpendEntry[];
}): PreflightGateResult {
  const cfg = resolveBudgetConfig(args.cwd);
  const ledger = args.ledger ?? loadLedger();
  const estimate = estimateRunCost({
    agent: args.agent,
    model: args.model,
    mode: args.mode,
    promptChars: args.prompt?.length,
    ledger,
  });
  const banner = formatEstimateBanner(args.agent, args.model, estimate);

  if (!hasAnyCap(cfg)) {
    return {
      dormant: true,
      cfg,
      estimate,
      decision: {
        allow: true,
        needsConfirm: false,
        projectedDaySpend: 0,
        projectedProjectSpend: 0,
      },
      banner,
    };
  }

  const state = ledgerStateFor(args.agent, args.project, ledger);
  const decision = enforcePreflight(cfg, state, estimate);
  return { dormant: false, cfg, estimate, decision, banner };
}

export type { SpendEntry };
