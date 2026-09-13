/**
 * Top-level resource profiles.
 *
 * These are distinct from model-provider run profiles in lib/profiles.ts. A
 * resource profile is a global mode switch stored in agents.yaml that filters
 * the resolved DotAgents resource view and secrets bundles.
 */

import { readMeta, updateMeta } from './state.js';
import { brandProfileName } from './brand.js';
import type { ResourcePattern, ResourceProfilePreset } from './types.js';

export type ProfiledResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'subagents'
  | 'plugins'
  | 'workflows'
  | 'permissions'
  | 'mcp'
  | 'memory'
  | 'secrets';

type PatternedProfileKind = Exclude<ProfiledResourceKind, 'memory' | 'secrets'>;

interface ActiveResourceProfile {
  name: string;
  preset: ResourceProfilePreset;
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,48}$/i;

function validateResourceProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name '${name}'. Use letters, digits, dash, underscore (max 48 chars).`);
  }
}

function getResourceProfilePreset(name: string): ResourceProfilePreset | null {
  validateResourceProfileName(name);
  return readMeta().profiles?.presets?.[name] ?? null;
}

function getActiveResourceProfileName(): string | null {
  // A white-label brand pins its own profile; when running under a brand
  // (AGENTS_BRAND set) that preset wins over the global `profiles.active`, so
  // every resource filter that keys off the active profile becomes brand-scoped.
  // See lib/brand.ts.
  const branded = brandProfileName();
  if (branded) return branded;
  return readMeta().profiles?.active ?? null;
}

export function getActiveResourceProfile(): ActiveResourceProfile | null {
  const name = getActiveResourceProfileName();
  if (!name) return null;
  const preset = readMeta().profiles?.presets?.[name];
  return preset ? { name, preset } : null;
}

export function upsertResourceProfilePreset(name: string, preset: ResourceProfilePreset): void {
  validateResourceProfileName(name);
  updateMeta((meta) => ({
    ...meta,
    profiles: {
      ...meta.profiles,
      presets: {
        ...(meta.profiles?.presets ?? {}),
        [name]: preset,
      },
    },
  }));
}

export function setActiveResourceProfile(name: string | null): void {
  if (name) {
    validateResourceProfileName(name);
    const preset = getResourceProfilePreset(name);
    if (!preset) throw new Error(`Profile '${name}' not found.`);
  }
  updateMeta((meta) => ({
    ...meta,
    profiles: {
      ...meta.profiles,
      active: name || undefined,
    },
  }));
}

function plainPatternMatches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

function filterByPlainPatterns(names: string[], patterns: string[]): string[] {
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return names.filter((name) =>
    include.some((p) => plainPatternMatches(p, name)) &&
    !exclude.some((p) => plainPatternMatches(p, name)),
  );
}

function sourcePatternMatches(pattern: string, name: string, sourceMap: Map<string, string>): boolean {
  const colon = pattern.indexOf(':');
  if (colon === -1) return false;
  const source = pattern.slice(0, colon);
  const rawName = pattern.slice(colon + 1);
  const actualSource = sourceMap.get(name);
  if (actualSource !== source) return false;
  const patternNames = rawName === '*' ? ['*'] : rawName.split(',').map((n) => n.trim()).filter(Boolean);
  return patternNames.some((patternName) => plainPatternMatches(patternName, name));
}

function expandProfilePatterns(
  names: string[],
  patterns: ResourcePattern[],
  sourceMap?: Map<string, string>,
): string[] {
  if (sourceMap) {
    const included = new Set<string>();
    const excluded = new Set<string>();
    for (const pattern of patterns) {
      const negate = pattern.startsWith('!');
      const raw = negate ? pattern.slice(1) : pattern;
      const target = negate ? excluded : included;
      const matches = raw.includes(':')
        ? names.filter((name) => sourcePatternMatches(raw, name, sourceMap))
        : names.filter((name) => plainPatternMatches(raw, name));
      for (const name of matches) target.add(name);
    }
    return names.filter((name) => included.has(name) && !excluded.has(name));
  }
  return filterByPlainPatterns(names, patterns);
}

export function activeRulesPreset(): string | null {
  const preset = getActiveResourceProfile()?.preset;
  return preset?.rules ?? preset?.rulesPreset ?? null;
}

export function filterNamesForActiveResourceProfile(
  kind: ProfiledResourceKind,
  names: string[],
  sourceMap?: Map<string, string>,
): string[] {
  const profile = getActiveResourceProfile();
  if (!profile) return names;

  if (kind === 'memory') {
    const rules = activeRulesPreset();
    return rules ? names.filter((name) => name === rules) : names;
  }

  const patterns = profile.preset[kind];
  if (!patterns) return names;
  return expandProfilePatterns(names, patterns, sourceMap);
}

export function isNameActiveInResourceProfile(
  kind: ProfiledResourceKind,
  name: string,
  source?: string,
): boolean {
  const sourceMap = source ? new Map([[name, source]]) : undefined;
  return filterNamesForActiveResourceProfile(kind, [name], sourceMap).includes(name);
}
