import type { AgentId } from '../../types.js';
import type { ResourceKind } from '../writers/kinds.js';

export interface DetectArgs {
  version: string;
  versionHome: string;
  cwd: string;
}

export interface ResourceDetector {
  readonly kind: ResourceKind;
  readonly agent: AgentId;
  list(args: DetectArgs): string[];
}
