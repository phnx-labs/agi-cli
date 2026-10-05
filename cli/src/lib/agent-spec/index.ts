// Public API for the agent-spec engine: one vocabulary and resolver for every
// `<agent>[@<qualifier>]` command. Exact/@pinned/bare specs resolve without enumeration; only
// @latest/@oldest/@all enumerate, via the mtime-cached provider.

import type { AgentId } from '../types.js';
import { defaultVersionProvider } from './provider.js';
import * as core from './resolve.js';
import type { AgentTarget, ResolveOptions, VersionFilter } from './types.js';

export * from './types.js';
export * from './primitives.js';

// Portable agent-package resolver + native-home materializer (PHNX-3838).
export * from './package-types.js';
export { parseAgentPackageManifest, loadAgentPackageManifest } from './package-schema.js';
export { resolveAgentPackage, effectiveResources } from './package-resolve.js';
export { materializeAgentPackage, sha256OfReceiptFile } from './materialize.js';

/** Shared `--help` epilog so every agent-spec command documents the same grammar. */
export const AGENT_SPEC_HELP =
  'Agent spec: <agent>[@<qualifier>]. Qualifiers: ' +
  '@latest (highest installed), @oldest (lowest installed), ' +
  '@pinned / @default (your configured default — synonyms), ' +
  '@all (every installed version), or an exact @x.y.z. ' +
  'Bare <agent> uses the resolved default (project pin → global default). ' +
  'Comma-separate to combine: claude@all,codex@latest.';

/** Resolve a spec (single or comma-list) into concrete installed targets. */
export function resolveAgentTargets(spec: string, opts: ResolveOptions = {}): AgentTarget[] {
  return core.resolveAgentTargets(spec, defaultVersionProvider, opts);
}

/** Resolve a spec that must name exactly one installed version. */
export function resolveSingleAgentTarget(
  spec: string,
  opts: ResolveOptions = {},
): { agent: AgentId; version: string; source: import('./types.js').VersionSource } {
  return core.resolveSingleAgentTarget(spec, defaultVersionProvider, opts);
}

/** Resolve a read/list command's version filter (undefined → all, @default → the default, else concrete). */
export function resolveVersionFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  opts: ResolveOptions = {},
): VersionFilter {
  return core.resolveVersionFilter(agent, qualifier, defaultVersionProvider, opts);
}

/** Concrete version filter for list/display commands (undefined → show all, @default → the default version). */
export function resolveListFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  opts: ResolveOptions = {},
): string | undefined {
  return core.resolveListFilter(agent, qualifier, defaultVersionProvider, opts);
}
