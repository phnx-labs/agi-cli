/** Token-usage to USD cost math on the offline pricing table. `costOfUsage` is the single
 * multiply-by-price primitive (also used by issue #346's estimator). It returns 0 for
 * unknown/unpriced models rather than throwing, so one unknown model can't break a rollup. */
import { getModelPricing } from './table.js';

export interface TokenUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** USD cost of one usage record; 0 when the model is missing or unpriced (additive, never NaN).
 * Cache tokens use dedicated rates when the table has them, else the input rate (LiteLLM
 * convention). */
export function costOfUsage(u: TokenUsage): number {
  if (!u.model) return 0;
  const pricing = getModelPricing(u.model);
  if (!pricing) return 0;

  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheCreationTokens ?? 0;

  const cacheReadRate = pricing.cacheReadPerToken ?? pricing.inputPerToken;
  const cacheWriteRate = pricing.cacheWritePerToken ?? pricing.inputPerToken;

  return (
    input * pricing.inputPerToken +
    output * pricing.outputPerToken +
    cacheRead * cacheReadRate +
    cacheWrite * cacheWriteRate
  );
}

/** USD cost of a usage record as if caching were OFF: cache read/write tokens billed at the full
 * INPUT rate (`agents insights output --pricing no-cache`). Output and uncached input are
 * unchanged; returns 0 for an unpriced model like costOfUsage. */
export function costOfUsageNoCache(u: TokenUsage): number {
  if (!u.model) return 0;
  const pricing = getModelPricing(u.model);
  if (!pricing) return 0;

  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheCreationTokens ?? 0;

  return (
    input * pricing.inputPerToken +
    output * pricing.outputPerToken +
    cacheRead * pricing.inputPerToken +
    cacheWrite * pricing.inputPerToken
  );
}

export function costOfSession(usages: TokenUsage[]): number {
  let total = 0;
  for (const u of usages) total += costOfUsage(u);
  return total;
}

/** Format USD for display, cents-precise with a "<$0.01" floor so tiny nonzero sessions don't read
 * as free. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

interface EstimatorTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Pre-flight cost estimate for a model + token bundle (issue #346's budget check). Returns the
 * resolved model id (`modelMatched`) so callers can warn when an unpriced model fell back to $0. */
export function estimateCost(
  model: string,
  tokens: EstimatorTokens,
): { usd: number; modelMatched: string | null } {
  const pricing = getModelPricing(model);
  const usd = costOfUsage({ model, ...tokens });
  return { usd, modelMatched: pricing ? model : null };
}

export function actualCost(model: string, usage: EstimatorTokens): { usd: number } {
  return { usd: costOfUsage({ model, ...usage }) };
}

export function isModelPriced(model: string): boolean {
  return getModelPricing(model) !== null;
}
