/**
 * Brand ("white-label") support — let a user run agents-cli under their own
 * personally-named binary (e.g. `jack` instead of `agents`), skinned with their
 * name and pinned to the exact feature set they enable.
 *
 * A brand is minted by `agents setup mine` / `agents setup mine init <name>`, which
 * writes a pure pass-through shim (`~/.agents/.cache/shims/<name>`) that sets
 * `AGENTS_BRAND=<name>` then execs the real agents-cli entrypoint. The entrypoint
 * reads `AGENTS_BRAND` to (a) present its own name/help/errors as the brand, and
 * (b) apply the brand's config: a list of disabled built-in commands plus an
 * optional resource-profile preset that curates skills/plugins/mcp/etc.
 *
 * Brand config lives in `meta.brands[<name>]` (agents.yaml), so it rides
 * `agents repo push/pull` across the fleet like every other user config. The
 * curated resource set reuses the existing resource-profile engine — a brand
 * pins a preset name (`meta.profiles.presets[...]`); see resource-profiles.ts,
 * where the active profile is resolved brand-first.
 */
import { readMeta, updateMeta } from './state.js';
// Leaf list only — do NOT import agents.js here. index.ts imports brand on
// every invocation (resolveBrandName / disabledCommandsForActiveBrand); a
// static agents import pulls the full agents.ts → versions.ts graph (~90ms)
// into --version/--help and the secrets-broker hot path (RUSH-2331).
// reservedBrandNames is only called when minting a brand; AGENT_CLI_COMMANDS
// is pinned equal to AGENTS[*].cliCommand by agent-cli-commands.test.ts.
import { AGENT_CLI_COMMANDS } from './agent-cli-commands.js';
import type { BrandConfig } from './types.js';

/** The default (unbranded) program name. */
export const DEFAULT_CLI_NAME = 'agents';

/** Valid brand names: a letter, then letters/digits/_/- (matches alias rules). */
const BRAND_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Resolve the name this invocation runs under. The brand shim exports
 * `AGENTS_BRAND`; when unset (a normal `agents`/`ag` call) we are unbranded and
 * everything is byte-identical to before.
 */
export function resolveBrandName(): string {
  const raw = process.env.AGENTS_BRAND?.trim();
  if (raw && BRAND_NAME_PATTERN.test(raw)) return raw;
  return DEFAULT_CLI_NAME;
}

/** The active brand name, or null when unbranded. */
function activeBrandName(): string | null {
  const name = resolveBrandName();
  return name === DEFAULT_CLI_NAME ? null : name;
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

/**
 * The active brand's config (from AGENTS_BRAND), or null when unbranded or when
 * the brand is explicitly disabled (`enabled: false`) — a disabled brand's shim
 * still works as a plain pass-through but applies no command/resource curation.
 */
function getActiveBrandConfig(): BrandConfig | null {
  const name = activeBrandName();
  if (!name) return null;
  const cfg = getBrandConfig(name);
  if (!cfg || cfg.enabled === false) return null;
  return cfg;
}

/**
 * The resource-profile preset name a brand pins, or null. Read on the hot path
 * by resource-profiles.ts to make the active profile brand-scoped.
 */
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
