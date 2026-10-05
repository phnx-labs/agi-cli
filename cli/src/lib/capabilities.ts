
import { AGENTS, MANAGED_AGENT_IDS } from './agents.js';
import { compareVersions } from './agent-spec/primitives.js';
import { installedReleaseFor } from './installations/store.js';
import type {
  AgentId,
  Capability,
  CapabilityName,
  CapabilityResult,
  RulesCapability,
} from './types.js';

function getCapability(agent: AgentId, cap: CapabilityName): Capability | RulesCapability | undefined {
  const def = AGENTS[agent];
  if (!def) return false;
  return def.capabilities[cap];
}

export function isCapable(agent: AgentId, cap: CapabilityName): boolean {
  if (AGENTS[agent]?.deprecated?.hard) return false;
  const c = getCapability(agent, cap);
  return c !== false;
}

export function supports(
  agent: AgentId,
  cap: CapabilityName,
  version?: string
): CapabilityResult {
  if (AGENTS[agent]?.deprecated?.hard) return { ok: false, reason: 'unsupported' };
  const c = getCapability(agent, cap);
  if (c === false) return { ok: false, reason: 'unsupported' };
  if (c === true || c === undefined) return { ok: true };
  if ('file' in c) return { ok: true };

  if (!version) return { ok: true };
  version = installedReleaseFor(agent, version);

  if (c.since && compareVersions(version, c.since) < 0) {
    return { ok: false, reason: 'too_old', need: `>= ${c.since}` };
  }
  if (c.until && compareVersions(version, c.until) >= 0) {
    return { ok: false, reason: 'too_new', need: `< ${c.until}` };
  }
  return { ok: true };
}

export function explainSkip(
  agent: AgentId,
  cap: CapabilityName,
  result: CapabilityResult,
  version?: string
): string {
  if (result.ok) return '';
  const tag = version ? `${agent}@${version}` : agent;
  if (result.reason === 'unsupported') return `${tag}: ${cap} not supported`;
  return `${tag}: ${cap} requires ${result.need}`;
}

export function capableAgents(cap: CapabilityName): AgentId[] {
  return MANAGED_AGENT_IDS.filter((id) => isCapable(id, cap));
}
