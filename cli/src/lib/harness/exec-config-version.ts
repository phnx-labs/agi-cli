/** Shared version resolution for the exec-time config-dir env pin: an explicit `--version` is
 * used unconditionally; an auto-resolved one is pinned only if installed. Adapters must not
 * import installations/versions: that closes an import cycle that broke sqlite.ts top-level await. */
import { getVersionHomePath, isVersionInstalled, resolveVersion } from '../installations/versions.js';
import type { AgentId } from '../types.js';

interface ResolvedConfigVersion {
  /** The version to pin, or null when unresolved / not installed. */
  version: string | null;
  /** The version home for that version, or null. */
  versionHome: string | null;
}

export function resolveConfigVersion(agent: AgentId, cwd: string, optionsVersion?: string): ResolvedConfigVersion {
  const resolvedVersion = optionsVersion ?? resolveVersion(agent, cwd);
  const version = optionsVersion
    ? resolvedVersion
    : (resolvedVersion && isVersionInstalled(agent, resolvedVersion) ? resolvedVersion : null);
  const versionHome = version ? getVersionHomePath(agent, version) : null;
  return { version: version ?? null, versionHome };
}
