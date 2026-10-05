import type { AgentId } from './types.js';
import { getModelCatalog, type ModelInfo } from './models.js';
import { getModelPricing } from './pricing/index.js';
import { resolveTierOverride } from './model-tier-overrides.js';

export const MODEL_TIERS = ['cheap', 'default', 'best', 'ultra'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export function isTierToken(s: string | undefined | null): s is ModelTier {
  return !!s && (MODEL_TIERS as readonly string[]).includes(s);
}

export interface TierResolution {
  tier: ModelTier;
  model: string | null;
  effort?: string;
  clampedFrom?: ModelTier;
  note?: string;
  source?: 'auto' | 'override' | 'curated';
}

const CURATED_LADDERS: Partial<Record<AgentId, Array<{ tier: ModelTier; match: RegExp }>>> = {
  kimi: [
    { tier: 'cheap', match: /highspeed/i },
    { tier: 'default', match: /for-coding(?!.*highspeed)/i },
    { tier: 'best', match: /(^|[-/])k3\b/i },
  ],
};

const TIER_EFFORT: Record<ModelTier, string> = {
  cheap: 'low',
  default: 'medium',
  best: 'high',
  ultra: 'xhigh',
};

const DROID_TIERS: Record<ModelTier, string> = {
  cheap: 'glm-5.2',
  default: 'kimi-k3',
  best: 'claude-opus-5',
  ultra: 'claude-opus-5',
};

const PSEUDO = /(^|[-/])(auto|auto-review|router|dynamic)([-/]|$)/i;

const AGGREGATOR_SUFFIX = /-(low|medium|high|xhigh|thinking|fast|reasoning)\b/gi;

function anthropicFamilyRank(id: string): number | null {
  if (/(^|[-/])claude-haiku|(^|[-/])haiku/.test(id)) return 0;
  if (/claude-sonnet|(^|[-/])sonnet/.test(id)) return 1;
  if (/claude-opus|(^|[-/])opus/.test(id)) return 2;
  if (/claude-(fable|mythos)|(^|[-/])(fable|mythos)/.test(id)) return 3;
  return null;
}

function descriptionRank(desc: string | undefined): number | null {
  if (!desc) return null;
  const d = desc.toLowerCase();
  if (/(fast|affordable|cost-efficient|small|cheap|mini|nano|lightweight|spark)/.test(d)) return 0;
  if (/(balanced|everyday|strong|general)/.test(d)) return 1;
  if (/(frontier|latest|flagship|most capable|complex|advanced|professional)/.test(d)) return 2;
  return null;
}

function sizeTokenRank(id: string): number {
  if (/(nano|mini|lite|flash|highspeed|small|air|spark)/.test(id)) return 0;
  if (/(pro|max|ultra|opus|sol|large|frontier|heavy|thinking)/.test(id)) return 2;
  return 1;
}

const blended = (id: string): number | null => {
  const p = getModelPricing(id);
  return p ? p.inputPerToken + p.outputPerToken : null;
};

function normalizeAggregatorId(id: string): string {
  return id.replace(AGGREGATOR_SUFFIX, '').replace(/-+$/,'');
}

interface Ranked {
  id: string;
  rank: number;
  family: string;
  price: number | null;
}

function cleanForCompare(id: string): string {

  return id
    .replace(/-\d{8}(?=($|-))/, '')
    .replace(/-v\d+$/, '')
    .replace(/-fast$/, '');
}
function versionSegments(id: string): number[] {
  const m = cleanForCompare(id).match(/\d+/g);
  return m ? m.map((n) => parseInt(n, 10)) : [];
}
function newer(a: string, b: string): number {

  const A = versionSegments(a);
  const B = versionSegments(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function rankCatalog(agent: AgentId, models: ModelInfo[]): Ranked[] {
  const usable = models.filter((m) => !PSEUDO.test(m.id));
  const aggregator = agent === 'cursor';

  const scored = usable.map((m) => {
    const rawId = m.id;
    const baseId = aggregator ? normalizeAggregatorId(rawId) : rawId;
    const lc = baseId.toLowerCase();
    const price = blended(baseId) ?? blended(rawId);

    let rank: number;
    let family: string;
    if (aggregator) {
      rank = price != null ? price * 1e6 : 100 + sizeTokenRank(lc);
      family = baseId;
    } else {
      const fam = anthropicFamilyRank(lc);
      const desc = descriptionRank(m.description);
      if (fam != null) {
        rank = fam;
        family = `anthropic-${fam}`;
      } else if (desc != null) {
        rank = desc;
        family = `desc-${desc}-${baseId.replace(/[0-9].*$/, '')}`;
      } else if (price != null) {
        rank = 10 + price * 1e6;
        family = cleanForCompare(baseId);
      } else {
        rank = 20 + sizeTokenRank(lc);
        family = cleanForCompare(baseId);
      }
    }
    return { id: rawId, baseId, rank, family, price } as Ranked & { baseId: string };
  });

  const byFamily = new Map<string, Ranked>();
  for (const s of scored) {
    const prev = byFamily.get(s.family);
    if (!prev) { byFamily.set(s.family, s); continue; }
    if (newer(s.id, prev.id) > 0) prev.id = s.id;
    if (s.rank < prev.rank) prev.rank = s.rank;
    if (prev.price == null && s.price != null) prev.price = s.price;
  }
  return [...byFamily.values()].sort((a, b) => a.rank - b.rank || newer(b.id, a.id));
}

function rungIndexFor(tierIndex: number, n: number): number {
  return n >= 4 ? Math.round((tierIndex / 3) * (n - 1)) : Math.min(tierIndex, n - 1);
}

function bucketRungs(rungs: Array<{ id: string }>): Record<ModelTier, TierResolution> {
  const n = rungs.length;
  const map = {} as Record<ModelTier, TierResolution>;
  if (n === 0) {
    for (const t of MODEL_TIERS) map[t] = { tier: t, model: null };
    return map;
  }
  for (let i = 0; i < MODEL_TIERS.length; i++) {
    const t = MODEL_TIERS[i];
    const idx = rungIndexFor(i, n);
    const shared = i > 0 && rungIndexFor(i - 1, n) === idx;
    map[t] = shared
      ? { tier: t, model: rungs[idx].id, clampedFrom: MODEL_TIERS[i - 1], note: `no distinct ${t} rung; using ${MODEL_TIERS[i - 1]}`, source: 'auto' }
      : { tier: t, model: rungs[idx].id, source: 'auto' };
  }
  return map;
}

function tierizeFromLadder(
  ladder: Array<{ tier: ModelTier; match: RegExp }>,
  models: ModelInfo[],
): Record<ModelTier, TierResolution> {
  const usable = models.filter((m) => !PSEUDO.test(m.id));
  const rungs: Array<{ id: string }> = [];
  for (const rung of ladder) {
    const matches = usable.filter((m) => rung.match.test(m.id));
    if (matches.length === 0) continue;
    const plain = matches.filter((m) => !/-\d+[km]\b/i.test(m.id));
    const pool = plain.length ? plain : matches;
    rungs.push({ id: pool.reduce((a, b) => (newer(b.id, a.id) > 0 ? b : a)).id });
  }
  const map = bucketRungs(rungs);
  for (const t of MODEL_TIERS) if (map[t].model) map[t].source = 'curated';
  return map;
}

export function resolveTierMap(agent: AgentId, version: string): Record<ModelTier, TierResolution> {
  let base: Record<ModelTier, TierResolution>;
  let catalogIds: Set<string> | null;

  if (agent === 'droid') {
    base = {
      cheap: { tier: 'cheap', model: DROID_TIERS.cheap, note: 'Droid Core 0.55x', source: 'curated' },
      default: { tier: 'default', model: DROID_TIERS.default, note: 'Droid Core 0.6x', source: 'curated' },
      best: { tier: 'best', model: DROID_TIERS.best, note: '2x', source: 'curated' },
      ultra: { tier: 'ultra', model: DROID_TIERS.ultra, clampedFrom: 'best', note: 'capped at 2x (4x excluded)', source: 'curated' },
    };
    catalogIds = null;
  } else {
    const catalog = getModelCatalog(agent, version);
    const models = catalog?.models ?? [];
    const ladder = CURATED_LADDERS[agent];
    base = ladder ? tierizeFromLadder(ladder, models) : tierizeModels(agent, models);
    catalogIds = catalog ? new Set(models.map((m) => m.id)) : null;
  }


  const overrides = resolveTierOverride(agent, version);
  return applyTierOverrides(overrides, `${agent}@${version}`, catalogIds, base);
}

export function applyTierOverrides(
  overrides: Partial<Record<ModelTier, string>>,
  label: string,
  catalogIds: Set<string> | null,
  base: Record<ModelTier, TierResolution>,
): Record<ModelTier, TierResolution> {
  if (Object.keys(overrides).length === 0) return base;
  const out = { ...base };
  for (const t of MODEL_TIERS) {
    const id = overrides[t];
    if (!id) continue;
    if (!catalogIds || catalogIds.has(id)) {
      out[t] = { tier: t, model: id, source: 'override' };
    } else {
      out[t] = { ...base[t], note: `override "${id}" not shipped by ${label}; kept the ${base[t].source ?? 'auto'} pick`, source: base[t].source ?? 'auto' };
    }
  }
  return out;
}

export function tierizeModels(agent: AgentId, models: ModelInfo[]): Record<ModelTier, TierResolution> {
  const rungs = rankCatalog(agent, models);

  if (rungs.length === 1) {
    const only = rungs[0].id;
    const map = {} as Record<ModelTier, TierResolution>;
    for (const t of MODEL_TIERS) map[t] = { tier: t, model: only, effort: TIER_EFFORT[t], note: 'single model — tier maps to reasoning effort', source: 'auto' };
    return map;
  }
  return bucketRungs(rungs);
}

export function resolveTier(agent: AgentId, version: string, tier: ModelTier): TierResolution {
  return resolveTierMap(agent, version)[tier];
}
