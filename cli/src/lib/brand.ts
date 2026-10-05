/** Brand (white-label) support: run agents-cli under a personal binary name (e.g. `jack`). `agents
 * setup mine` writes a pass-through shim setting `AGENTS_BRAND=<name>`, which skins
 * name/help/errors and applies the brand's disabled commands and resource-profile preset. */
import { readMeta, updateMeta } from './state.js';
// Leaf list only; do not import agents.js here. index.ts imports brand on every invocation, and a
// static agents import pulls the agents.ts -> versions.ts graph (~90ms) into --version/--help
// (RUSH-2331). AGENT_CLI_COMMANDS is pinned to AGENTS[*].cliCommand by agent-cli-commands.test.ts.
import { AGENT_CLI_COMMANDS } from './agent-cli-commands.js';
import type { BrandConfig } from './types.js';

/** The default (unbranded) program name. */
export const DEFAULT_CLI_NAME = 'agents';

/** Valid brand names: a letter, then letters/digits/_/- (matches alias rules). */
const BRAND_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Resolve the name this invocation runs under from `AGENTS_BRAND`; when unset (normal
 * `agents`/`ag`) we are unbranded and everything is byte-identical to before. */
export function resolveBrandName(): string {
  const raw = process.env.AGENTS_BRAND?.trim();
  if (raw && BRAND_NAME_PATTERN.test(raw)) return raw;
  return DEFAULT_CLI_NAME;
}

/** The active brand name, or null when unbranded. */
export function activeBrandName(): string | null {
  const name = resolveBrandName();
  return name === DEFAULT_CLI_NAME ? null : name;
}

/** True when this process is running under a brand (not the plain `agents` CLI). */
export function isBranded(): boolean {
  return activeBrandName() !== null;
}

/** Names that would clobber an agent CLI shim or the `agents`/`ag` binary. */
export function reservedBrandNames(): Set<string> {
  const reserved = new Set<string>([DEFAULT_CLI_NAME, 'ag']);
  for (const cmd of AGENT_CLI_COMMANDS) reserved.add(cmd);
  return reserved;
}

/** Validate a proposed brand name; returns an error string or null when ok. */
export function validateBrandName(name: string): string | null {
  if (!BRAND_NAME_PATTERN.test(name)) {
    return `Invalid name "${name}". Use a letter, then letters, digits, _ or -.`;
  }
  if (reservedBrandNames().has(name)) {
    return `"${name}" is reserved (collides with an agent CLI or the agents binary).`;
  }
  return null;
}

/** All configured brands, keyed by name. */
export function listBrands(): Record<string, BrandConfig> {
  return readMeta().brands ?? {};
}

/** One brand's config, or undefined. */
export function getBrandConfig(name: string): BrandConfig | undefined {
  return listBrands()[name];
}

/** The active brand's config (from AGENTS_BRAND), or null when unbranded or disabled (`enabled:
 * false`); a disabled brand's shim still passes through but applies no curation. */
function getActiveBrandConfig(): BrandConfig | null {
  const name = activeBrandName();
  if (!name) return null;
  const cfg = getBrandConfig(name);
  if (!cfg || cfg.enabled === false) return null;
  return cfg;
}

/** The resource-profile preset name a brand pins, or null; read on the hot path by
 * resource-profiles.ts to scope the active profile to the brand. */
export function brandProfileName(): string | null {
  const cfg = getActiveBrandConfig();
  return cfg?.profile ?? null;
}

/** Built-in top-level commands the active brand has turned off. */
export function disabledCommandsForActiveBrand(): Set<string> {
  const cfg = getActiveBrandConfig();
  return new Set(cfg?.disabledCommands ?? []);
}

/** The preset name a brand owns (one resource profile per brand). */
export function brandPresetName(name: string): string {
  return `mine-${name}`;
}

/** Create or replace a brand's config in agents.yaml. */
export function upsertBrand(cfg: BrandConfig): void {
  updateMeta((meta) => {
    const brands = { ...(meta.brands ?? {}) };
    brands[cfg.name] = cfg;
    return { ...meta, brands };
  });
}

/** Remove a brand's config (leaves its resource preset unless `purgePreset`). */
export function removeBrand(name: string, purgePreset = false): void {
  updateMeta((meta) => {
    const brands = { ...(meta.brands ?? {}) };
    delete brands[name];
    let profiles = meta.profiles;
    if (purgePreset && profiles?.presets) {
      const presets = { ...profiles.presets };
      delete presets[brandPresetName(name)];
      profiles = { ...profiles, presets };
    }
    return { ...meta, brands, ...(profiles ? { profiles } : {}) };
  });
}
