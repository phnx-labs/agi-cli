import { getModelPricing } from './table.js';

export interface TokenUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

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
