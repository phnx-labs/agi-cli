/**
 * Shared version resolution for the exec-time config-dir env pin. Every
 * config-dir harness branch in the old buildExecEnv computed this identically:
 * an explicit `--version` is used unconditionally; an auto-resolved version is
 * only pinned when it is actually installed on disk.
 *
 * The caller (buildExecEnv) invokes this and passes the result into the adapter
 * via ExecConfigEnvCtx — the adapters MUST NOT import installations/versions
 * themselves, because that module imports shims.ts and shims.ts imports the
 * harness barrel, which would close an import cycle (versions → shims → harness →
 * adapter → versions). That cycle forced esbuild/tsx to emit CJS for part of the
 * graph and broke sqlite.ts's top-level await in subprocess-spawning tests.
 */
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
