// Exact agent/version overrides merge over agent wildcards, then auto-ranking; removing the last override removes the empty config container.
import type { AgentId } from './types.js';
import { readMeta, updateMeta } from './state.js';
import { parseRunDefaultSelector } from './run-defaults.js';
import { MODEL_TIERS, type ModelTier } from './model-tiers.js';

type TierOverrideMap = Partial<Record<ModelTier, string>>;

interface TierOverrideEntry {
  selector: string;
  tiers: TierOverrideMap;
}

function isTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

export function parseTier(input: string): ModelTier {
  const t = input.trim().toLowerCase();
  if (!isTier(t)) {
    throw new Error(`Invalid tier '${input}'. Use one of: ${MODEL_TIERS.join(', ')}.`);
  }
  return t;
}

function normalize(raw: unknown): TierOverrideMap {
  const out: TierOverrideMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isTier(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function sortedSelectors<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
}

export function resolveTierOverrideFrom(
  all: Record<string, unknown>,
  agent: AgentId,
  version?: string | null,
): TierOverrideMap {
  const merged: TierOverrideMap = { ...normalize(all[`${agent}:*`]) };
  if (version) {
    for (const [tier, model] of Object.entries(normalize(all[`${agent}:${version}`]))) {
      merged[tier as ModelTier] = model;
    }
  }
  return merged;
}

export function resolveTierOverride(agent: AgentId, version?: string | null): TierOverrideMap {
  return resolveTierOverrideFrom(readMeta().model?.tiers ?? {}, agent, version);
}

export function listTierOverrides(): TierOverrideEntry[] {
  const all = readMeta().model?.tiers ?? {};
  return Object.entries(all)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([selector, tiers]) => ({ selector, tiers: normalize(tiers) }));
}

export function setTierOverride(selectorInput: string, tierInput: string | ModelTier, model: string): TierOverrideEntry {
  const parsed = parseRunDefaultSelector(selectorInput);
  const tier = parseTier(tierInput);
  const id = model.trim();
  if (!id) throw new Error('A model id is required.');

  updateMeta((meta) => {
    const modelCfg = { ...(meta.model ?? {}) };
    const tiers = { ...(modelCfg.tiers ?? {}) };
    tiers[parsed.selector] = { ...(tiers[parsed.selector] ?? {}), [tier]: id };
    modelCfg.tiers = sortedSelectors(tiers);
    return { ...meta, model: modelCfg };
  });

  return { selector: parsed.selector, tiers: normalize(readMeta().model?.tiers?.[parsed.selector]) };
}

export function clearTierOverride(selectorInput: string, tierInput?: string): boolean {
  const parsed = parseRunDefaultSelector(selectorInput);
  const tier = tierInput ? parseTier(tierInput) : null;
  let changed = false;

  updateMeta((meta) => {
    if (!meta.model?.tiers?.[parsed.selector]) return meta;
    const model = { ...meta.model };
    const tiers = { ...(model.tiers ?? {}) };
    if (tier) {
      const entry = { ...tiers[parsed.selector] };
      if (entry[tier] !== undefined) {
        delete entry[tier];
        changed = true;
      }
      if (Object.keys(entry).length === 0) delete tiers[parsed.selector];
      else tiers[parsed.selector] = entry;
    } else {
      delete tiers[parsed.selector];
      changed = true;
    }
    if (Object.keys(tiers).length > 0) {
      model.tiers = tiers;
      return { ...meta, model };
    }
    delete model.tiers;
    if (Object.keys(model).length > 0) return { ...meta, model };
    const { model: _dropped, ...rest } = meta;
    void _dropped;
    return rest;
  });

  return changed;
}
