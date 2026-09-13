/**
 * Writer + detector registry for resource sync.
 *
 * Two parallel maps keyed by (ResourceKind, AgentId). At module import time
 * (which fires once when the CLI boots) we verify that EVERY supported
 * (agent, kind) pair has both a writer and a detector. Missing entries
 * throw immediately — silent-skip bugs become startup errors.
 *
 *   - Adding a new agent? Either declare every supported kind with a writer
 *     here OR mark the kind `false` in `AgentConfig.capabilities`.
 *   - Adding a new kind? Declare it on every agent's capabilities and add a
 *     writer module.
 *
 * The capability matrix in `lib/agents.ts:AGENTS` is the single source of
 * truth for "is this (agent, kind) supported?". The assertion below maps the
 * matrix to required registry entries.
 */
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

/** Per-kind selection payload. Most kinds are string[]; rules is special. */
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

/**
 * Kinds excluded from the assertion. Skills + native-skills-dir agents are
 * the only legitimate gap — Gemini reads `~/.agents/skills/` natively, so
 * it deliberately has no per-version writer/detector. The orchestrator
 * handles that case by clearing the version-home skills dir before launch.
 * Anywhere else, a missing entry is a real bug.
 */
function isExempt(agent: AgentId, kind: ResourceKind): boolean {
  if (kind === 'skills' && AGENTS[agent].nativeAgentsSkillsDir) return true;
  return false;
}

let assertionFired = false;

/**
 * Verify every supported (agent, kind) pair has both a writer and a
 * detector. Deferred from module-import time to the first `getWriter` /
 * `getDetector` call to dodge the agents.ts ↔ versions.ts ↔ registry.ts
 * import cycle (the same one the lazy writer/detector maps work around).
 * Idempotent — runs at most once per process.
 */
export function assertRegistryComplete(): void {
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

/** Return the writer for (kind, agent), or undefined if unsupported. */
export function getWriter<K extends ResourceKind>(
  kind: K,
  agent: AgentId
): ResourceWriter<SelectionFor<K>> | undefined {
  assertRegistryComplete();
  return WRITERS[kind][agent] as ResourceWriter<SelectionFor<K>> | undefined;
}

/** Return the detector for (kind, agent), or undefined if unsupported. */
export function getDetector(kind: ResourceKind, agent: AgentId): ResourceDetector | undefined {
  assertRegistryComplete();
  return DETECTORS[kind][agent];
}
