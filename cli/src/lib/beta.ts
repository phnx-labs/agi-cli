
import * as path from 'path';
import type { BetaFeatureName, Manifest, Meta } from './types.js';
import { getAgentsDir, getOptionalUserAgentsDir, readMeta, writeMeta } from './state.js';
import { readManifest, writeManifest } from './manifest.js';

export const ALL_BETA_FEATURES = ['factory'] as const satisfies readonly BetaFeatureName[];

function isBetaFeatureName(value: unknown): value is BetaFeatureName {
  return typeof value === 'string' && ALL_BETA_FEATURES.includes(value as BetaFeatureName);
}

function normalizeEnabledFeatures(input: unknown): BetaFeatureName[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<BetaFeatureName>();
  for (const value of input) {
    if (!isBetaFeatureName(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

function readUserManifestBeta(): BetaFeatureName[] | null {
  const userAgentsDir = getOptionalUserAgentsDir();
  if (!userAgentsDir) return null;
  const manifest = readManifest(userAgentsDir);
  if (!manifest?.beta) return null;
  return normalizeEnabledFeatures(manifest.beta.enabled);
}

function readSystemMetaBeta(): BetaFeatureName[] {
  return normalizeEnabledFeatures(readMeta().beta?.enabled);
}

export function getEnabledBetaFeatures(): BetaFeatureName[] {
  return readUserManifestBeta() ?? readSystemMetaBeta();
}

export function isBetaEnabled(feature: BetaFeatureName): boolean {
  return getEnabledBetaFeatures().includes(feature);
}

export function getBetaConfigLocation(): { scope: 'user' | 'system'; path: string } {
  const userAgentsDir = getOptionalUserAgentsDir();
  if (userAgentsDir) {
    return { scope: 'user', path: path.join(userAgentsDir, 'agents.yaml') };
  }
  return { scope: 'system', path: path.join(getAgentsDir(), 'agents.yaml') };
}

export function setBetaEnabled(features: readonly BetaFeatureName[], enabled: boolean): {
  scope: 'user' | 'system';
  path: string;
  enabledFeatures: BetaFeatureName[];
} {
  const location = getBetaConfigLocation();
  const next = new Set(getEnabledBetaFeatures());
  for (const feature of features) {
    if (enabled) next.add(feature);
    else next.delete(feature);
  }
  const enabledFeatures = [...next];

  if (location.scope === 'user') {
    const userAgentsDir = getOptionalUserAgentsDir();
    if (!userAgentsDir) {
      throw new Error('Expected ~/.agents/ to exist while writing beta config.');
    }
    const manifest: Manifest = readManifest(userAgentsDir) ?? {};
    if (enabledFeatures.length > 0) {
      manifest.beta = { enabled: enabledFeatures };
    } else {
      delete manifest.beta;
    }
    writeManifest(userAgentsDir, manifest);
    return { ...location, enabledFeatures };
  }

  const meta: Meta = readMeta();
  if (enabledFeatures.length > 0) {
    meta.beta = { enabled: enabledFeatures };
  } else {
    delete meta.beta;
  }
  writeMeta(meta);
  return { ...location, enabledFeatures };
}

export function betaEnableHint(feature: BetaFeatureName): string {
  return `Enable it with: agents setup beta enable ${feature}`;
}
