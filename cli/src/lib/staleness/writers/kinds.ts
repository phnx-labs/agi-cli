/** Canonical list of resource kinds dispatched through the writer/detector registry; names match
 * AgentConfig capabilities except "permissions" (legacy "allowlist"). */
import type { CapabilityName } from '../../types.js';

export type ResourceKind =
  | 'commands'
  | 'skills'
  | 'hooks'
  | 'rules'
  | 'mcp'
  | 'permissions'
  | 'subagents'
  | 'plugins'
  | 'workflows';

export const ALL_RESOURCE_KINDS: readonly ResourceKind[] = [
  'commands',
  'skills',
  'hooks',
  'rules',
  'mcp',
  'permissions',
  'subagents',
  'plugins',
  'workflows',
] as const;

export function kindToCapability(kind: ResourceKind): CapabilityName {
  return kind === 'permissions' ? 'allowlist' : kind;
}
