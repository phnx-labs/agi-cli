
import type { AgentId } from '../types.js';
import { defaultVersionProvider } from './provider.js';
import * as core from './resolve.js';
import type { AgentTarget, ResolveOptions, VersionFilter } from './types.js';

export * from './types.js';
export * from './primitives.js';

export * from './package-types.js';
export { parseAgentPackageManifest, loadAgentPackageManifest } from './package-schema.js';
export { resolveAgentPackage, effectiveResources } from './package-resolve.js';
export { materializeAgentPackage, sha256OfReceiptFile } from './materialize.js';

export const AGENT_SPEC_HELP =
  'Agent spec: <agent>[@<qualifier>]. Qualifiers: ' +
  '@latest (highest installed), @oldest (lowest installed), ' +
  '@pinned / @default (your configured default — synonyms), ' +
  '@all (every installed version), or an exact @x.y.z. ' +
  'Bare <agent> uses the resolved default (project pin → global default). ' +
  'Comma-separate to combine: claude@all,codex@latest.';

export function resolveAgentTargets(spec: string, opts: ResolveOptions = {}): AgentTarget[] {
  return core.resolveAgentTargets(spec, defaultVersionProvider, opts);
}

export function resolveSingleAgentTarget(
  spec: string,
  opts: ResolveOptions = {},
): { agent: AgentId; version: string; source: import('./types.js').VersionSource } {
  return core.resolveSingleAgentTarget(spec, defaultVersionProvider, opts);
}

export function resolveVersionFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  opts: ResolveOptions = {},
): VersionFilter {
  return core.resolveVersionFilter(agent, qualifier, defaultVersionProvider, opts);
}

export function resolveListFilter(
  agent: AgentId,
  qualifier: string | undefined | null,
  opts: ResolveOptions = {},
): string | undefined {
  return core.resolveListFilter(agent, qualifier, defaultVersionProvider, opts);
}
