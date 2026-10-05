/** Per-(kind, agent) writer contract. `syncResourcesToVersion` selects names per kind and
 * dispatches to a writer from `../registry.ts`; the writer owns storage format, source search and
 * copy. Reach writers only after `supports(agent, kind, version).ok`; otherwise they throw. */
import type { AgentId } from '../../types.js';
import type { ResourceKind } from './kinds.js';

export interface WriteArgs<Sel> {
  version: string;
  versionHome: string;
  selection: Sel;
  cwd: string;
}

export interface WriteResult {
  synced: string[];
  /** Absolute paths of artifacts this write materialized, recorded as the manifest's
   * `writtenTargets` so `isStale` can flag a deleted artifact with one existsSync per path (#2398,
   * RUSH-2320). Optional: absence means 'not verified', never a false stale. */
  paths?: string[];
  /** Per-item failures the writer could not complete, as user-facing sentences. `synced: []` cannot
   * tell 'nothing to do' from 'refused and said why', which let an unwritable harness report
   * success (RUSH-2677). A writer that declines must say so here. */
  errors?: string[];
}

/** Inverse of a write: locate and delete the artifact for one resource `name` in a version home.
 * Used only by the manifest-bounded prune (RUSH-2438), which proves names were installed and gone. */
export interface RemoveArgs {
  version: string;
  versionHome: string;
  name: string;
  cwd: string;
}

export interface RemoveResult {
  removed: boolean;
}

export interface ResourceWriter<Sel = string[]> {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  write(args: WriteArgs<Sel>): WriteResult;
  /** Optional inverse of `write` for prune. Only name-keyed file/dir kinds (commands, skills,
   * hooks) implement it; wholesale rewrites (rules, permissions) and plugins
   * (`cleanOrphanedPluginSkills`) do not. */
  remove?(args: RemoveArgs): RemoveResult;
}
