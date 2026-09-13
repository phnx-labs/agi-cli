import type { AgentId } from '../types.js';

/** How a resolved version was arrived at — for provenance, display, and error rendering. */
export type VersionSource =
  | 'explicit'                // @x.y.z or a concrete pass-through
  | 'project-pin'             // a project-root agents.yaml pin
  | 'global-default'          // the configured global default (bare spec)
  | 'isolated-default'        // the preferred ISOLATED copy, when there is no global default
  | 'global-default(@pinned)' // @pinned / @default asked for the global default explicitly
  | 'sole-installed'          // no pin/default, exactly one installed
  | 'newest-installed'        // bare + ambiguous, onAmbiguous:'newest' picked the newest
  | 'alias-latest'            // @latest
  | 'alias-oldest'            // @oldest
  | 'none';                   // no installed version (version === null)

export interface AgentTarget {
  agent: AgentId;
  /** Resolved exact version, or null when the agent has no installed versions yet. */
  version: string | null;
  source: VersionSource;
}

type AgentSpecErrorCode =
  | 'empty'
  | 'unknown-agent'
  | 'missing-version'
  | 'invalid-version'
  | 'not-installed'
  | 'no-default'
  | 'none-installed'
  | 'multi-not-allowed';

/**
 * Thrown on any bad spec — never `process.exit`, so the engine is safe on the
 * hot path and in library contexts. `code` + `installed` let callers render a
 * consistent message (e.g. the "No default … Specify one:" version list) without
 * string-matching.
 */
export class AgentSpecError extends Error {
  constructor(
    message: string,
    readonly code: AgentSpecErrorCode,
    readonly agent?: AgentId,
    readonly installed?: string[],
  ) {
    super(message);
    this.name = 'AgentSpecError';
  }
}

/**
 * The filesystem/meta seam. The pure resolver takes this instead of importing
 * versions.ts, so it is fully unit-testable with in-memory fixtures — no $HOME,
 * no subprocess. `provider.ts` supplies the production adapter.
 */
export interface VersionProvider {
  /** Installed versions, sorted ascending by `compareVersions`. */
  listInstalled(agent: AgentId): string[];
  /** Version pinned by a project-root agents.yaml, or null. */
  getProjectVersion(agent: AgentId, cwd: string): string | null;
  /** The configured global default version, or null. */
  getGlobalDefault(agent: AgentId): string | null;
  /**
   * The preferred isolated copy. Kept separate from getGlobalDefault on purpose: a
   * global default owns the launcher, the bare shim and the real ~/.<agent> config
   * symlink, and an isolated version must never acquire any of those. Folding the
   * two together here would hand an isolated version back to every caller that
   * reasonably assumes a global default means "the one that owns the launcher".
   */
  getIsolatedDefault(agent: AgentId): string | null;
  /** Whether an exact version is installed. */
  isInstalled(agent: AgentId, version: string): boolean;
}

export interface ResolveOptions {
  /** Project dir for a bare spec's project pin. Defaults to process.cwd(). */
  cwd?: string;
  /** Restrict which agents a spec may name (e.g. only mcp-capable). Defaults to all. */
  availableAgents?: readonly AgentId[];
  /**
   * Bare spec, >1 installed, no pin/default:
   *   'error'  (default) → throw AgentSpecError{code:'no-default'} — safe for
   *                        state-mutating commands (sync/use).
   *   'newest'          → pick the newest installed (source:'newest-installed');
   *                        callers should note it. For execution verbs (run/exec).
   */
  onAmbiguous?: 'error' | 'newest';
}

/** A read/list command's version filter. `null` = show all; `'default'` = show the configured default. */
export type FilterVersion = string | null | 'default';
export interface VersionFilter {
  version: FilterVersion;
  source: VersionSource | 'all-versions' | 'default';
}
