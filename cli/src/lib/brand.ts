import { readMeta, updateMeta } from './state.js';
import { AGENT_CLI_COMMANDS } from './agent-cli-commands.js';
import type { BrandConfig } from './types.js';

export const DEFAULT_CLI_NAME = 'agents';

const BRAND_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function resolveBrandName(): string {
  const raw = process.env.AGENTS_BRAND?.trim();
  if (raw && BRAND_NAME_PATTERN.test(raw)) return raw;
  return DEFAULT_CLI_NAME;
}

export function activeBrandName(): string | null {
  const name = resolveBrandName();
  return name === DEFAULT_CLI_NAME ? null : name;
}

export function isBranded(): boolean {
  return activeBrandName() !== null;
}

export function reservedBrandNames(): Set<string> {
  const reserved = new Set<string>([DEFAULT_CLI_NAME, 'ag']);
  for (const cmd of AGENT_CLI_COMMANDS) reserved.add(cmd);
  return reserved;
}

export function validateBrandName(name: string): string | null {
  if (!BRAND_NAME_PATTERN.test(name)) {
    return `Invalid name "${name}". Use a letter, then letters, digits, _ or -.`;
  }
  if (reservedBrandNames().has(name)) {
    return `"${name}" is reserved (collides with an agent CLI or the agents binary).`;
  }
  return null;
}

export function listBrands(): Record<string, BrandConfig> {
  return readMeta().brands ?? {};
}

export function getBrandConfig(name: string): BrandConfig | undefined {
  return listBrands()[name];
}

function getActiveBrandConfig(): BrandConfig | null {
  const name = activeBrandName();
  if (!name) return null;
  const cfg = getBrandConfig(name);
  if (!cfg || cfg.enabled === false) return null;
  return cfg;
}

export function brandProfileName(): string | null {
  const cfg = getActiveBrandConfig();
  return cfg?.profile ?? null;
}

export function disabledCommandsForActiveBrand(): Set<string> {
  const cfg = getActiveBrandConfig();
  return new Set(cfg?.disabledCommands ?? []);
}

export function brandPresetName(name: string): string {
  return `mine-${name}`;
}

export function upsertBrand(cfg: BrandConfig): void {
  updateMeta((meta) => {
    const brands = { ...(meta.brands ?? {}) };
    brands[cfg.name] = cfg;
    return { ...meta, brands };
  });
}

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
