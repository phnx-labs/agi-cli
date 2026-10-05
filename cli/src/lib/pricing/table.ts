import pricesData from './prices.json' with { type: 'json' };

export interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number;
  cacheWritePerToken?: number;
}

interface PricesFile {
  version: string;
  models: Record<string, ModelPricing>;
}

const PRICES = pricesData as PricesFile;

export const PRICING_VERSION: string = PRICES.version;

const MODELS: Record<string, ModelPricing> = PRICES.models;

const KEYS_BY_LENGTH = Object.keys(MODELS).sort((a, b) => b.length - a.length);

function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  id = id.replace(/^[a-z]+\//, '');
  id = id.replace(/^[a-z]+\.[a-z]+\./, '');
  id = id.replace(/^models\//, '');
  id = id.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return id;
}

export function getModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  const norm = normalizeModelId(modelId);

  if (MODELS[norm]) return MODELS[norm];

  for (const key of KEYS_BY_LENGTH) {
    if (norm === key || norm.startsWith(key + '-') || norm.startsWith(key + '.')) {
      return MODELS[key];
    }
  }

  for (const key of KEYS_BY_LENGTH) {
    if (norm.includes(key)) return MODELS[key];
  }

  return null;
}

export function listPricedModels(): string[] {
  return Object.keys(MODELS);
}
