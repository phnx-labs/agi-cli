/**
 * Pre-flight cost estimate + gate (issue #346).
 *
 * Before a run spawns we estimate its cost and decide whether to allow it. The
 * estimate's token basis comes from recent ledger averages for the same agent
 * (the most accurate signal we have), falling back to a prompt-character
 * heuristic when there's no history. Cost is computed via the canonical pricing
 * module — never reimplemented here.
 *
 * `enforcePreflight` is the decision: with `on_exceed: block`, if launching
 * this run would push any cap (per_run / per_day / per_agent / per_project)
 * over the line, it denies. With `on_exceed: warn` it always allows but reports
 * the projected overrun.
 */
import type { BudgetConfig } from '../types.js';
import { estimateCost, formatUsd } from '../pricing/index.js';
import { loadLedger, spendForDay, spendForAgentDay, spendForProject, localDay } from './ledger.js';
import type { SpendEntry } from './ledger.js';
import { resolveBudgetConfig, hasAnyCap } from './config.js';

/** A pre-flight cost estimate for one run. */
interface RunEstimate {
  /** Estimated USD for this run. 0 when the model is unpriced. */
  estUsd: number;
  /** How the token count was derived. */
  basis: 'ledger-average' | 'prompt-heuristic' | 'none';
  /** True when the model resolved to a priced entry. */
  priced: boolean;
  estInputTokens: number;
  estOutputTokens: number;
}

/** Roughly 4 characters per token — the standard coarse heuristic for English text. */
const CHARS_PER_TOKEN = 4;
/**
 * Output is typically a multiple of the visible prompt for an agentic run
 * (tool calls, file reads, reasoning). 6x is a deliberately conservative
 * lower bound so the estimate doesn't wildly under-report and wave through a
 * run that then blows the cap on its first turn.
 */
const HEURISTIC_OUTPUT_MULTIPLIER = 6;

/**
 * Estimate the cost of a run. When the ledger has prior runs for this agent we
 * use their average input/output tokens; otherwise we fall back to a
 * prompt-character heuristic. `recentAvgTokens` lets callers inject a
 * precomputed average (e.g. from a scoped ledger) for testability.
 */
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

/** Average input/output tokens per RUN for an agent, from the ledger. Null when no history. */
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

/** Decision returned by the pre-flight gate. */
interface PreflightDecision {
  /** Whether the run may proceed. */
  allow: boolean;
  /** Whether the caller must interactively confirm (estimate >= require_confirm_over). */
  needsConfirm: boolean;
  /** Human reason when blocked or confirming. */
  reason?: string;
  /** Which cap blocked, if any. */
  blockedCap?: 'per_run' | 'per_day' | 'per_agent' | 'per_project';
  /** Projected day spend if this run lands at its estimate. */
  projectedDaySpend: number;
  /** Projected project spend if this run lands at its estimate. */
  projectedProjectSpend: number;
}

/** Current spend snapshot the gate compares the estimate against. */
export interface LedgerState {
  /** Agent this snapshot is for (used to pick the matching per_agent cap). */
  agent: string;
  daySpend: number;
  projectSpend: number;
  agentDaySpend: number;
}

/** Read the ledger snapshot the gate needs for `agent` / `project` / today. */
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

/**
 * The pre-flight gate. Projects this run's estimate on top of current spend and
 * decides allow/deny. `on_exceed: warn` never blocks (allow:true) but still
 * reports the projected overrun via `reason`. A hard block sets allow:false —
 * `--yes` MUST NOT override it (the caller enforces that; this function only
 * reports the truth).
 */
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

  // require_confirm_over only governs interactive confirm, not a hard block.
  let needsConfirm =
    cfg.require_confirm_over !== undefined && est.estUsd >= cfg.require_confirm_over;

  // Unpriced model + active caps: the estimate is $0 because we have no price
  // for this model, so NONE of the per_run/per_day caps above can ever trip and
  // we'd silently wave the run through. Never $0-wave-through (#346): when caps
  // are set but the model is unpriced, require confirmation so the user is told
  // the cap cannot be enforced for this model rather than getting a false pass.
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

/** Build a one-line human estimate banner for `agents run` preamble. */
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

/** Result of the high-level run gate consumed by `agents run` / teams / cloud. */
interface PreflightGateResult {
  /** True when no caps are configured — budget feature dormant, nothing to do. */
  dormant: boolean;
  cfg: BudgetConfig;
  estimate: RunEstimate;
  decision: PreflightDecision;
  banner: string;
}

/**
 * High-level pre-flight gate: resolve the effective budget for `cwd`, estimate
 * the run, and evaluate every cap. Returns `dormant:true` (and skips all work)
 * when no caps are set, so the gate is zero-cost for users who never configure
 * a budget. The CLI layer decides how to act on `decision` (print banner,
 * confirm, or block + exit non-zero).
 */
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

// Re-export so the per_agent projection is available to the gate's caller without
// a second ledger import. (agentDaySpend projection is used by exec wiring.)
export type { SpendEntry };
