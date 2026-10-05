import { AGENTS } from '../agents.js';
import { supports } from '../capabilities.js';
import type { AgentId } from '../types.js';
import {
  ALL_RESOURCE_KINDS,
  kindToCapability,
  type ResourceKind,
} from './writers/kinds.js';

import { commandsWriters }    from './writers/commands.js';
import { skillsWriters }      from './writers/skills.js';
import { hooksWriters }       from './writers/hooks.js';
import { rulesWriters }       from './writers/rules.js';
import { mcpWriters }         from './writers/mcp.js';
import { permissionsWriters } from './writers/permissions.js';
import { subagentsWriters }   from './writers/subagents.js';
import { pluginsWriters }     from './writers/plugins.js';
import { workflowsWriters }   from './writers/workflows.js';

import { commandsDetectors }    from './detectors/commands.js';
import { skillsDetectors }      from './detectors/skills.js';
import { hooksDetectors }       from './detectors/hooks.js';
import { rulesDetectors }       from './detectors/rules.js';
import { mcpDetectors }         from './detectors/mcp.js';
import { permissionsDetectors } from './detectors/permissions.js';
import { subagentsDetectors }   from './detectors/subagents.js';
import { pluginsDetectors }     from './detectors/plugins.js';
import { workflowsDetectors }   from './detectors/workflows.js';

import type { ResourceWriter } from './writers/types.js';
import type { ResourceDetector } from './detectors/types.js';
import type { RulesSelection } from './writers/rules.js';

export type { ResourceKind } from './writers/kinds.js';
export { kindToCapability, ALL_RESOURCE_KINDS } from './writers/kinds.js';
export type { ResourceWriter, WriteArgs, WriteResult, RemoveArgs, RemoveResult } from './writers/types.js';
export type { ResourceDetector, DetectArgs } from './detectors/types.js';
export type { RulesSelection } from './writers/rules.js';

type SelectionFor<K extends ResourceKind> =
  K extends 'rules' ? RulesSelection : string[];

/* eslint-disable @typescript-eslint/no-explicit-any */
export const WRITERS: Record<ResourceKind, Partial<Record<AgentId, ResourceWriter<any>>>> = {
  commands:    commandsWriters,
  skills:      skillsWriters,
  hooks:       hooksWriters,
  rules:       rulesWriters,
  mcp:         mcpWriters,
  permissions: permissionsWriters,
  subagents:   subagentsWriters,
  plugins:     pluginsWriters,
  workflows:   workflowsWriters,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const DETECTORS: Record<ResourceKind, Partial<Record<AgentId, ResourceDetector>>> = {
  commands:    commandsDetectors,
  skills:      skillsDetectors,
  hooks:       hooksDetectors,
  rules:       rulesDetectors,
  mcp:         mcpDetectors,
  permissions: permissionsDetectors,
  subagents:   subagentsDetectors,
  plugins:     pluginsDetectors,
  workflows:   workflowsDetectors,
};

function isExempt(agent: AgentId, kind: ResourceKind): boolean {
  // Native agent skills are managed outside this registry; no other capability is exempt.
  if (kind === 'skills' && AGENTS[agent].nativeAgentsSkillsDir) return true;
  return false;
}

let assertionFired = false;

export function assertRegistryComplete(): void {
  // Validate lazily and once to avoid the agents.ts ↔ versions.ts ↔ registry.ts import cycle.
  // Every advertised capability must bind both writer and detector or fail startup loudly.
  if (assertionFired) return;
  assertionFired = true;
  const missing: { kind: ResourceKind; agent: AgentId; missing: ('writer' | 'detector')[] }[] = [];
  for (const kind of ALL_RESOURCE_KINDS) {
    const cap = kindToCapability(kind);
    for (const agent of Object.keys(AGENTS) as AgentId[]) {
      if (!supports(agent, cap).ok) continue;
      if (isExempt(agent, kind)) continue;
      const lacks: ('writer' | 'detector')[] = [];
      if (!WRITERS[kind][agent]) lacks.push('writer');
      if (!DETECTORS[kind][agent]) lacks.push('detector');
      if (lacks.length > 0) missing.push({ kind, agent, missing: lacks });
    }
  }
  if (missing.length > 0) {
    const detail = missing
      .map((m) => `  - ${m.kind}/${m.agent}: missing ${m.missing.join(' and ')}`)
      .join('\n');
    throw new Error(
      `staleness/registry: missing required (kind, agent) entries:\n${detail}\n` +
      `Fix: register the entry in src/lib/staleness/{writers,detectors}/<kind>.ts, OR ` +
      `mark the capability false in AGENTS.${missing[0].agent}.capabilities.`
    );
  }
}

export function getWriter<K extends ResourceKind>(
  kind: K,
  agent: AgentId
): ResourceWriter<SelectionFor<K>> | undefined {
  assertRegistryComplete();
  return WRITERS[kind][agent] as ResourceWriter<SelectionFor<K>> | undefined;
}

export function getDetector(kind: ResourceKind, agent: AgentId): ResourceDetector | undefined {
  assertRegistryComplete();
  return DETECTORS[kind][agent];
}
