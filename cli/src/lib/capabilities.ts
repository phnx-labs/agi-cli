/** Capability check: every install path touching an agent-version (hooks, plugins, MCP, skills,
 * commands) calls `supports(agent, cap, version?)` first, and skips with a clear reason when
 * unsupported or below `since`, rather than corrupting an older binary's settings. */

import { AGENTS, MANAGED_AGENT_IDS } from './agents.js';
// agent-spec/primitives is a leaf module — importing it creates no cycle, and it
// is the only compareVersions that honors OpenClaw's `-N` rebuild suffix.
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
  // Guard against unknown agent ids (e.g. a caller passing "claude@2.1.168"
  // instead of "claude"). Without this, AGENTS[agent] is undefined and the
  // property access throws an opaque TypeError instead of reporting false.
  const def = AGENTS[agent];
  if (!def) return false;
  return def.capabilities[cap];
}

/** True when the agent supports the capability on at least some version. For filtering UI lists;
 * doesn't check the installed version. */
export function isCapable(agent: AgentId, cap: CapabilityName): boolean {
  if (AGENTS[agent]?.deprecated?.hard) return false;
  const c = getCapability(agent, cap);
  return c !== false;
}

/** Whether the agent (optionally at a specific installed version) supports `cap`. Pass `version`
 * when known: omitting it checks only the agent-level flag, fine for "ever capable" filters but
 * not for install-time checks. */
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

/** Human-readable reason for skipping an install, in a stable shape callers can log or push onto
 * `errors[]`. */
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

/** All agents whose `capabilities[cap]` is anything other than `false`. */
export function capableAgents(cap: CapabilityName): AgentId[] {
  return MANAGED_AGENT_IDS.filter((id) => isCapable(id, cap));
}
