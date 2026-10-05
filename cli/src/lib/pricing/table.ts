/** Offline per-model pricing table from `prices.json`. A model missing from it prices to $0
 * silently (478 `claude-opus-5` sessions read free), so add new models in the same change. Sonnet
 * 5 intro rate $2/$10 ends 2026-08-31; update to $3/$15 from 2026-09-01 (table has no dates). */
import pricesData from './prices.json' with { type: 'json' };

/** Per-token USD prices for a single model. Cache fields optional (not all vendors expose them). */
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

/** Date-stamped version of the pricing table (e.g. "2026-06-24"). */
export const PRICING_VERSION: string = PRICES.version;

const MODELS: Record<string, ModelPricing> = PRICES.models;

// Canonical keys sorted longest-first so containment matching prefers the most
// specific key (e.g. "gemini-2.5-flash-lite" before "gemini-2.5-flash").
const KEYS_BY_LENGTH = Object.keys(MODELS).sort((a, b) => b.length - a.length);

/** Normalize a model id to the dash-delimited key space: strip vendor prefixes (`anthropic/`,
 * `us.anthropic.`, `models/`, `openai/`), lowercase, and collapse non [a-z0-9.] runs to one dash. */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  // Drop a leading vendor segment: "anthropic/claude-..", "us.anthropic.claude-..",
  // "google/gemini-..", "models/gemini-..", "openai/gpt-..".
  id = id.replace(/^[a-z]+\//, '');                 // "anthropic/x" -> "x"
  id = id.replace(/^[a-z]+\.[a-z]+\./, '');         // "us.anthropic.x" -> "x"
  id = id.replace(/^models\//, '');                 // already handled, defensive
  // Collapse separators to single dashes, keep dots (gpt-5.4) intact.
  id = id.replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return id;
}

/** Resolve per-token pricing for a model id, tolerant of vendor prefixes, version dashes and date
 * suffixes; null when no canonical key is a substring (unknown model). */
export function getModelPricing(modelId: string): ModelPricing | null {
  if (!modelId) return null;
  const norm = normalizeModelId(modelId);

  // Exact key first (fast path + unambiguous).
  if (MODELS[norm]) return MODELS[norm];

  // Containment match, longest canonical key wins, dash-bounded: "claude-opus-4" matches
  // "claude-opus-4-8" and "claude-opus-4-20250514".
  for (const key of KEYS_BY_LENGTH) {
    if (norm === key || norm.startsWith(key + '-') || norm.startsWith(key + '.')) {
      return MODELS[key];
    }
  }

  // Last resort: canonical key contained anywhere (handles "anthropic-claude-opus-4"
  // style ids the prefix strip missed). Still longest-first.
  for (const key of KEYS_BY_LENGTH) {
    if (norm.includes(key)) return MODELS[key];
  }

  return null;
}

/** List every canonical model id that carries a price. */
export function listPricedModels(): string[] {
  return Object.keys(MODELS);
}
