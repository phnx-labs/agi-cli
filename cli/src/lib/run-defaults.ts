/**
 * Selector-based defaults for `agents run`.
 *
 * Stored under agents.yaml:
 *
 *   run:
 *     defaults:
 *       "claude:*":
 *         mode: auto
 *         model: opus
 *       "claude:2.1.45":
 *         mode: plan
 */

import type { AgentId, Mode, RunConfig, RunDefaults, RunEffort } from './types.js';
import { ALL_MODES } from './types.js';
import { AGENTS } from './agents.js';
import { readMeta, updateMeta } from './state.js';
import { getProjectRunConfigs } from './run-config.js';
import chalk from 'chalk';

export const VERSION_RE = /^(?:\*|latest|(?!.*\.\.)[A-Za-z0-9._+-]{1,64})$/;

interface ParsedRunDefaultSelector {
  agent: AgentId;
  version: string;
  selector: string;
}

export interface ResolvedRunDefaults extends RunDefaults {
  sources: {
    mode?: string;
    model?: string;
    effort?: string;
  };
}

export interface RunDefaultEntry {
  selector: string;
  defaults: RunDefaults;
}

type RunDefaultsInput = {
  mode?: unknown;
  model?: unknown;
  effort?: unknown;
};

const RUN_EFFORTS: readonly RunEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];

function isAgentId(value: string): value is AgentId {
  return value in AGENTS;
}

export function normalizeRunDefaultMode(input: string): Mode {
  const mode = input.trim().toLowerCase();
  if (mode === 'full') return 'skip';
  if ((ALL_MODES as readonly string[]).includes(mode)) return mode as Mode;
  throw new Error(`Invalid mode '${input}'. Use one of: ${ALL_MODES.join(', ')} (or 'full' as an alias for 'skip').`);
}

function normalizeRunDefaults(defaults: RunDefaultsInput, selector: string): RunDefaults {
  const out: RunDefaults = {};

  if (defaults.mode !== undefined) {
    if (typeof defaults.mode !== 'string') {
      throw new Error(`Invalid mode in run.defaults.${selector}: expected a string.`);
    }
    out.mode = normalizeRunDefaultMode(defaults.mode);
  }

  if (defaults.model !== undefined) {
    if (typeof defaults.model !== 'string' || defaults.model.trim() === '') {
      throw new Error(`Invalid model in run.defaults.${selector}: expected a non-empty string.`);
    }
    out.model = defaults.model.trim();
  }

  if (defaults.effort !== undefined) {
    if (typeof defaults.effort !== 'string' || !RUN_EFFORTS.includes(defaults.effort as RunEffort)) {
      throw new Error('Invalid effort in run.defaults.' + selector + ': use one of: ' + RUN_EFFORTS.join(', ') + '.');
    }
    out.effort = defaults.effort as RunEffort;
  }

  return out;
}

export function parseRunDefaultSelector(input: string): ParsedRunDefaultSelector {
  const raw = input.trim();
  if (!raw) throw new Error('Selector is required. Use <agent>:<version>, <agent>@<version>, or <agent>:*.');

  let agentPart: string;
  let versionPart: string;

  if (raw.includes('@')) {
    const parts = raw.split('@');
    if (parts.length !== 2) throw new Error(`Invalid selector '${input}'. Use <agent>@<version>.`);
    [agentPart, versionPart] = parts;
  } else if (raw.includes(':')) {
    const idx = raw.indexOf(':');
    agentPart = raw.slice(0, idx);
    versionPart = raw.slice(idx + 1);
  } else {
    agentPart = raw;
    versionPart = '*';
  }

  const agent = agentPart.toLowerCase();
  if (!isAgentId(agent)) {
    throw new Error(`Invalid agent '${agentPart}'. Available agents: ${Object.keys(AGENTS).join(', ')}.`);
  }

  if (!VERSION_RE.test(versionPart)) {
    throw new Error(`Invalid selector version '${versionPart}'. Use *, latest, or [A-Za-z0-9._+-]{1,64}.`);
  }

  return {
    agent,
    version: versionPart,
    selector: `${agent}:${versionPart}`,
  };
}

function sortedDefaults(defaults: Record<string, RunDefaults>): Record<string, RunDefaults> {
  return Object.fromEntries(
    Object.entries(defaults).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function resolveRunDefaultsFromConfig(
  runConfig: RunConfig | undefined,
  agent: AgentId,
  version?: string | null,
): ResolvedRunDefaults {
  const defaults = runConfig?.defaults ?? {};
  const wildcardSelector = `${agent}:*`;
  const exactSelector = version ? `${agent}:${version}` : null;
  const resolved: ResolvedRunDefaults = { sources: {} };

  const wildcard = defaults[wildcardSelector]
    ? normalizeRunDefaults(defaults[wildcardSelector], wildcardSelector)
    : null;
  if (wildcard?.mode) {
    resolved.mode = wildcard.mode;
    resolved.sources.mode = wildcardSelector;
  }
  if (wildcard?.model) {
    resolved.model = wildcard.model;
    resolved.sources.model = wildcardSelector;
  }
  if (wildcard?.effort) {
    resolved.effort = wildcard.effort;
    resolved.sources.effort = wildcardSelector;
  }

  if (exactSelector && defaults[exactSelector]) {
    const exact = normalizeRunDefaults(defaults[exactSelector], exactSelector);
    if (exact.mode) {
      resolved.mode = exact.mode;
      resolved.sources.mode = exactSelector;
    }
    if (exact.model) {
      resolved.model = exact.model;
      resolved.sources.model = exactSelector;
    }
    if (exact.effort) {
      resolved.effort = exact.effort;
      resolved.sources.effort = exactSelector;
    }
  }

  return resolved;
}

export function resolveRunDefaultsFromConfigs(
  runConfigs: Array<RunConfig | undefined>,
  agent: AgentId,
  version?: string | null,
): ResolvedRunDefaults {
  const resolved: ResolvedRunDefaults = { sources: {} };

  for (const runConfig of runConfigs) {
    const next = resolveRunDefaultsFromConfig(runConfig, agent, version);
    if (next.mode) {
      resolved.mode = next.mode;
      resolved.sources.mode = next.sources.mode;
    }
    if (next.model) {
      resolved.model = next.model;
      resolved.sources.model = next.sources.model;
    }
    if (next.effort) {
      resolved.effort = next.effort;
      resolved.sources.effort = next.sources.effort;
    }
  }

  return resolved;
}

export function resolveRunDefaults(
  agent: AgentId,
  version?: string | null,
  startPath: string = process.cwd(),
): ResolvedRunDefaults {
  const projectRunConfigs = getProjectRunConfigs(startPath).reverse();
  return resolveRunDefaultsFromConfigs([readMeta().run, ...projectRunConfigs], agent, version);
}

export function formatRunDefaultEntry(entry: RunDefaultEntry): string {
  const parts: string[] = [];
  if (entry.defaults.mode) parts.push(`mode ${chalk.white(entry.defaults.mode)}`);
  if (entry.defaults.model) parts.push(`model ${chalk.white(entry.defaults.model)}`);
  if (entry.defaults.effort) parts.push('effort ' + chalk.white(entry.defaults.effort));
  return `${chalk.cyan(entry.selector.padEnd(22))} ${parts.join('  ')}`;
}

export function listRunDefaults(): RunDefaultEntry[] {
  const defaults = readMeta().run?.defaults ?? {};
  return Object.entries(defaults)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([selector, value]) => ({
      selector,
      defaults: normalizeRunDefaults(value, selector),
    }));
}

export function setRunDefault(selectorInput: string, defaultsInput: RunDefaultsInput): RunDefaultEntry {
  const parsed = parseRunDefaultSelector(selectorInput);
  const defaults = normalizeRunDefaults(defaultsInput, parsed.selector);
  if (!defaults.mode && !defaults.model && !defaults.effort) {
    throw new Error('Set at least one default: --mode <mode>, --model <model>, or --effort <effort>.');
  }

  updateMeta((meta) => {
    const run = { ...(meta.run ?? {}) } as RunConfig;
    const currentDefaults = { ...(run.defaults ?? {}) };
    currentDefaults[parsed.selector] = {
      ...(currentDefaults[parsed.selector] ?? {}),
      ...defaults,
    };
    run.defaults = sortedDefaults(currentDefaults);
    return { ...meta, run };
  });

  return {
    selector: parsed.selector,
    defaults: {
      ...(readMeta().run?.defaults?.[parsed.selector] ?? {}),
    },
  };
}

export function unsetRunDefault(selectorInput: string): boolean {
  const parsed = parseRunDefaultSelector(selectorInput);
  let removed = false;

  updateMeta((meta) => {
    const run = { ...(meta.run ?? {}) } as RunConfig;
    const currentDefaults = { ...(run.defaults ?? {}) };
    removed = Object.prototype.hasOwnProperty.call(currentDefaults, parsed.selector);
    delete currentDefaults[parsed.selector];
    if (Object.keys(currentDefaults).length > 0) {
      run.defaults = sortedDefaults(currentDefaults);
    } else {
      delete run.defaults;
    }
    return { ...meta, run };
  });

  return removed;
}

/** Convenience setters used by `agents config` for single-field updates. */
export function setRunDefaultModel(selectorInput: string, model: string): RunDefaultEntry {
  return setRunDefault(selectorInput, { model });
}

export function setRunDefaultMode(selectorInput: string, mode: string): RunDefaultEntry {
  return setRunDefault(selectorInput, { mode });
}

export function setRunDefaultEffort(selectorInput: string, effort: string): RunDefaultEntry {
  return setRunDefault(selectorInput, { effort });
}
