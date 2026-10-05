// Pure agent-spec resolution, the engine core. Takes a VersionProvider instead of the filesystem
// so every branch is unit-testable with in-memory fixtures. Domain is installed versions. Never
// calls process.exit; throws AgentSpecError on bad input.

import type { AgentId } from '../types.js';
import { AGENTS, ALL_AGENT_IDS, resolveAgentName, formatAgentError } from '../agents.js';
import { VERSION_RE } from './primitives.js';
import {
  AgentSpecError,
  type AgentTarget,
  type VersionProvider,
  type VersionSource,
  type ResolveOptions,
  type VersionFilter,
} from './types.js';

/** Resolve an agent spec (single or comma-list) into concrete installed targets;
 * `@latest`/`@oldest`/`@all` range over installed versions. */
export function resolveAgentTargets(
  spec: string,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): AgentTarget[] {
  const cwd = opts.cwd ?? process.cwd();
  const available = opts.availableAgents ?? ALL_AGENT_IDS;
  const onAmbiguous = opts.onAmbiguous ?? 'error';

  const rawEntries = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (rawEntries.length === 0) {
    throw new AgentSpecError('Empty agent spec.', 'empty');
  }

  // Expand the bare literal `all` (or `all@all`) into every available agent that
  // has ≥1 installed version. Lenient: agents with nothing installed are skipped.
  const entries: string[] = [];
  for (const e of rawEntries) {
    if (e === 'all' || e === 'all@all') {
      for (const a of available) {
        if (provider.listInstalled(a).length > 0) entries.push(`${a}@all`);
      }
    } else {
      entries.push(e);
    }
  }

  const out: AgentTarget[] = [];
  const seen = new Set<string>();
  const push = (agent: AgentId, version: string | null, source: VersionSource) => {
    const key = `${agent}@${version ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ agent, version, source });
    }
  };

  for (const entry of entries) {
    const at = entry.indexOf('@');
    const agentToken = (at === -1 ? entry : entry.slice(0, at)).trim();
    const qualifier = at === -1 ? null : entry.slice(at + 1).trim();

    if (!agentToken) continue;
    if (at !== -1 && !qualifier) {
      throw new AgentSpecError(
        `Missing version in '${entry}'. Use ${agentToken}@x.y.z, @latest, @oldest, @pinned, @default, or @all.`,
        'missing-version',
      );
    }

    const agent = resolveAgentName(agentToken);
    if (!agent || !available.includes(agent)) {
      throw new AgentSpecError(formatAgentError(agentToken, [...available]), 'unknown-agent');
    }
    const name = AGENTS[agent].name;

    // ----- bare: project pin → global default → sole/ambiguous installed -----
    if (qualifier === null) {
      const proj = provider.getProjectVersion(agent, cwd);
      if (proj) { push(agent, proj, 'project-pin'); continue; }
      const glob = provider.getGlobalDefault(agent);
      if (glob) { push(agent, glob, 'global-default'); continue; }
      // An isolated-only agent never has a global default, so without this step `--agents codex`
      // threw "No default version set" after an explicit `agents use codex@<v>`. resolveVersion
      // had the fallback; the resolvers drifted.
      const iso = provider.getIsolatedDefault(agent);
      if (iso) { push(agent, iso, 'isolated-default'); continue; }
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) { push(agent, null, 'none'); continue; }
      if (installed.length === 1) { push(agent, installed[0], 'sole-installed'); continue; }
      if (onAmbiguous === 'newest') { push(agent, installed[installed.length - 1], 'newest-installed'); continue; }
      throw new AgentSpecError(
        `No default version set for ${name}. Specify one (${agent}@<version>) or set it: agents use ${agent}@<version>.`,
        'no-default', agent, installed,
      );
    }

    // ----- @pinned / @default: the configured default (global, else isolated) -----
    if (qualifier === 'pinned' || qualifier === 'default') {
      const glob = provider.getGlobalDefault(agent);
      // Report which kind it was: an isolated default owns none of the launcher /
      // shim / config-symlink machinery a global default does, and callers that log
      // the source shouldn't claim otherwise.
      const def = glob ?? provider.getIsolatedDefault(agent);
      if (!def) {
        throw new AgentSpecError(
          `No default version set for ${name}. Run: agents use ${agent}@<version>`,
          'no-default', agent, provider.listInstalled(agent),
        );
      }
      push(agent, def, glob ? 'global-default(@pinned)' : 'isolated-default');
      continue;
    }

    // ----- @all: every installed version -----
    if (qualifier === 'all') {
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`, 'none-installed', agent);
      }
      for (const v of installed) push(agent, v, 'explicit');
      continue;
    }

    // ----- @latest / @oldest: ends of the installed range -----
    if (qualifier === 'latest' || qualifier === 'oldest') {
      const installed = provider.listInstalled(agent);
      if (installed.length === 0) {
        throw new AgentSpecError(`No managed versions are installed for ${name}. Run: agents add ${agent}@latest`, 'none-installed', agent);
      }
      const isOldest = qualifier === 'oldest';
      push(agent, isOldest ? installed[0] : installed[installed.length - 1], isOldest ? 'alias-oldest' : 'alias-latest');
      continue;
    }

    // ----- exact version: validate then existence-check (no enumeration) -----
    if (!VERSION_RE.test(qualifier)) {
      throw new AgentSpecError(`Invalid version '${qualifier}' for ${name}. Allowed: latest or [A-Za-z0-9._+-]{1,64}.`, 'invalid-version', agent);
    }
    if (!provider.isInstalled(agent, qualifier)) {
      const installed = provider.listInstalled(agent);
      const hint = installed.length ? ` Installed: ${installed.join(', ')}.` : '';
      throw new AgentSpecError(`${name}@${qualifier} is not installed.${hint} Install it: agents add ${agent}@${qualifier}`, 'not-installed', agent, installed);
    }
    push(agent, qualifier, 'explicit');
  }

  return out;
}

/** Single-target commands (`run`, `sync`, `inspect`): resolve a spec naming exactly one installed
 * version; rejects `@all` and multi-target specs. */
export function resolveSingleAgentTarget(
  spec: string,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): { agent: AgentId; version: string; source: VersionSource } {
  const targets = resolveAgentTargets(spec, provider, opts);
  if (targets.length !== 1) {
    throw new AgentSpecError(`'${spec}' resolves to ${targets.length} targets; this command needs exactly one.`, 'multi-not-allowed');
  }
  const t = targets[0];
  if (t.version === null) {
    throw new AgentSpecError(`No installed version for ${AGENTS[t.agent].name}. Run: agents add ${t.agent}@latest`, 'none-installed', t.agent);
  }
  return { agent: t.agent, version: t.version, source: t.source };
}

/** Read/list commands: resolve a qualifier into a version filter. No qualifier or @any: no filter;
 * @default/@pinned: the `'default'` sentinel; @latest/@oldest/x.y.z: a concrete version (throws if
 * not installed). Uniform `@default` handling fixes the rules-vs-view inconsistency. */
export function resolveVersionFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): VersionFilter {
  const q = qualifier?.trim();
  if (!q) return { version: null, source: 'all-versions' };
  if (q === 'default' || q === 'pinned') return { version: 'default', source: 'default' };
  if (q === 'any') return { version: null, source: 'all-versions' };
  const { version, source } = resolveSingleAgentTarget(`${agent}@${q}`, provider, { ...opts, availableAgents: [agent] });
  return { version, source };
}

/** Concrete version filter for list/display commands that filter by exact version, not the
 * `'default'` sentinel. @default/@pinned gives the configured default, or undefined (show all) if
 * none is set; concrete qualifiers throw AgentSpecError if bad. */
export function resolveListFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  provider: VersionProvider,
  opts: ResolveOptions = {},
): string | undefined {
  const q = qualifier?.trim();
  if (!q || q === 'any') return undefined;
  if (q === 'default' || q === 'pinned') {
    return provider.getGlobalDefault(agent) ?? provider.getIsolatedDefault(agent) ?? undefined;
  }
  return resolveSingleAgentTarget(`${agent}@${q}`, provider, { ...opts, availableAgents: [agent] }).version;
}
