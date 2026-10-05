/** Per-(kind, agent) detector contract: inspect a version home and report which resource names of a
 * kind are materialized. `getActuallySyncedResources` calls one per pair to build the on-disk
 * view, diffed against what is available for `agents view`. */
import type { AgentId } from '../../types.js';
import type { ResourceKind } from '../writers/kinds.js';

export interface DetectArgs {
  version: string;
  versionHome: string;
  /** Working directory — needed by detectors that resolve project state. */
  cwd: string;
}

export interface ResourceDetector {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  list(args: DetectArgs): string[];
}
