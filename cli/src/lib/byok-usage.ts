
import type { Profile } from './profiles.js';
import { getKeychainTokenSync, hasKeychainTokenSync } from './secrets-client.js';
import { renderBar, getUsageColor } from './accounting/usage.js';
import chalk from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getCacheDir } from './state.js';
import { atomicWriteFileSync, ensureLockTarget, withFileLock } from './fs-atomic.js';
import { withRefreshLease } from './refresh-coordinator.js';
import { findAccount, resolveCredentialAccount } from './account-registry.js';
import { getAccountProvider } from './account-provider-registry.js';

export interface ByokBudgetInfo {
  limitUsd: number | null;
  remainingUsd: number | null;
  usedUsd: number;
  usedPercent: number | null;
  fetchedAt: Date;
}

export interface ByokUsageResult {
  budget: ByokBudgetInfo | null;
  error: string | null;
}


let _fetch: typeof globalThis.fetch = globalThis.fetch;

export function setByokFetchForTest(fn: typeof globalThis.fetch): void {
  _fetch = fn;
}


interface CacheEntry {
  result: ByokUsageResult;
  fetchedAt: number;
}

let cachePathOverride: string | null = null;

function cachePath(): string {
  return cachePathOverride ?? path.join(getCacheDir(), 'byok-usage.json');
}

function readCache(): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as { version: 1; entries: Record<string, CacheEntry> };
    return parsed?.version === 1 && parsed.entries ? parsed.entries : {};
  } catch { return {}; }
}

function writeCacheEntry(key: string, entry: CacheEntry): void {
  const target = cachePath();
  ensureLockTarget(target, JSON.stringify({ version: 1, entries: {} }));
  withFileLock(target, () => {
    atomicWriteFileSync(target, JSON.stringify({ version: 1, entries: { ...readCache(), [key]: entry } }));
  });
}

function byokCacheKey(profile: Profile): string {
  return createHash('sha256').update(`${profile.provider}\0${profile.account ?? profile.auth?.keychainItem ?? ''}`).digest('hex');
}

export const BYOK_REFRESH_INTERVAL_MS = 5 * 60_000;

export function setByokCachePathForTest(value: string | null): string | null {
  const previous = cachePathOverride;
  cachePathOverride = value;
  return previous;
}

export function resetByokCacheForTest(): void {
  try { fs.unlinkSync(cachePath()); } catch {  }
}


interface ByokProviderEntry {
  fetch(token: string): Promise<ByokUsageResult>;
}

function resolveByokToken(profile: Profile): string | null {
  if (profile.account) {
    try {
      const account = findAccount(profile.account);
      if (!account) return null;
      const resolved = resolveCredentialAccount(profile.account, profile.host.agent, profile.provider);
      return resolved.env[getAccountProvider(account.provider).envFor(profile.host.agent, account.auth)] ?? null;
    } catch {
      return null;
    }
  }
  const keychainItem = profile.auth?.keychainItem;
  if (!keychainItem) return null;
  try {
    if (!hasKeychainTokenSync(keychainItem)) return null;
    return getKeychainTokenSync(keychainItem);
  } catch {
    return null;
  }
}

async function fetchOpenRouter(token: string): Promise<ByokUsageResult> {
  try {
    const res = await _fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { budget: null, error: `HTTP ${res.status}` };
    const json = (await res.json()) as {
      data: { limit: number | null; limit_remaining: number | null; usage: number };
    };
    const { limit, limit_remaining, usage } = json.data;
    const limitUsd = limit ?? null;
    const usedUsd = usage;
    const usedPercent = limitUsd !== null && limitUsd > 0 ? (usedUsd / limitUsd) * 100 : null;
    return {
      budget: {
        limitUsd,
        remainingUsd: limit_remaining ?? null,
        usedUsd,
        usedPercent,
        fetchedAt: new Date(),
      },
      error: null,
    };
  } catch (err) {
    return { budget: null, error: String(err) };
  }
}

async function fetchDeepInfra(token: string): Promise<ByokUsageResult> {
  try {
    const res = await _fetch('https://api.deepinfra.com/payment/checklist', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { budget: null, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { stripe_balance: number; recent: number; limit: number | null };
    const limitUsd = json.limit !== null && json.limit >= 0 ? json.limit : null;
    const usedUsd = json.recent;
    const remainingUsd = limitUsd !== null
      ? Math.max(0, limitUsd - usedUsd)
      : json.stripe_balance < 0 ? -json.stripe_balance : null;
    return {
      budget: {
        limitUsd,
        remainingUsd,
        usedUsd,
        usedPercent: limitUsd !== null && limitUsd > 0 ? (usedUsd / limitUsd) * 100 : null,
        fetchedAt: new Date(),
      },
      error: null,
    };
  } catch (err) {
    return { budget: null, error: String(err) };
  }
}

const BYOK_REGISTRY: Record<string, ByokProviderEntry> = {
  openrouter: { fetch: fetchOpenRouter },
  deepinfra: { fetch: fetchDeepInfra },
};

export function hasByokProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(BYOK_REGISTRY, provider);
}


export function renderByokBar(result: ByokUsageResult): string {
  if (!result.budget) return '';
  const { budget } = result;
  if (budget.limitUsd === null) {
    const bar = renderBar(0, 10);
    const credit = budget.remainingUsd !== null ? `$${budget.remainingUsd.toFixed(2)} credit, ` : '';
    return `$: ${bar} ${credit}$${budget.usedUsd.toFixed(2)} used (no spending limit)`;
  }
  const pct = budget.usedPercent ?? 0;
  const bar = renderBar(pct, 10);
  const color = getUsageColor(pct);
  const remaining = budget.remainingUsd !== null ? `$${budget.remainingUsd.toFixed(2)}` : '?';
  const limit = `$${budget.limitUsd.toFixed(2)}`;
  return `$: ${bar} ${color(`${Math.round(pct)}%`)} (${remaining} left of ${limit})`;
}


export async function getByokUsageForHarness(
  profile: Profile,
  opts?: { forceRefresh?: boolean },
): Promise<ByokUsageResult | null> {
  if (!profile.provider || !hasByokProvider(profile.provider) || (!profile.auth && !profile.account)) return null;
  const provider = BYOK_REGISTRY[profile.provider];
  const cacheKey = byokCacheKey(profile);
  const cached = readCache()[cacheKey];
  if (!opts?.forceRefresh) return cached?.result ?? { budget: null, error: 'stale' };

  const previousFetchedAt = cached?.fetchedAt ?? 0;
  return withRefreshLease({
    scope: 'byok-usage',
    key: cacheKey,
    readCompleted: () => readCache()[cacheKey] ?? null,
    isCompleted: (entry) => entry.fetchedAt > previousFetchedAt,
    refresh: async () => {
      const token = resolveByokToken(profile);
      const result = token ? await provider.fetch(token) : { budget: null, error: null };
      const entry = { result, fetchedAt: Math.max(Date.now(), previousFetchedAt + 1) };
      writeCacheEntry(cacheKey, entry);
      return entry;
    },
  }).then((entry) => entry.result);
}

export async function refreshDueByokUsage(
  profiles: Profile[],
  now = Date.now(),
): Promise<{ refreshed: number; skipped: number }> {
  const due = new Map<string, Profile>();
  for (const profile of profiles) {
    if (!profile.provider || (!profile.auth && !profile.account) || !hasByokProvider(profile.provider)) continue;
    due.set(byokCacheKey(profile), profile);
  }

  let refreshed = 0;
  let skipped = 0;
  const cache = readCache();
  for (const [key, profile] of due) {
    const entry = cache[key];
    if (entry && now - entry.fetchedAt < BYOK_REFRESH_INTERVAL_MS) {
      skipped += 1;
      continue;
    }
    await getByokUsageForHarness(profile, { forceRefresh: true });
    refreshed += 1;
  }
  return { refreshed, skipped };
}
