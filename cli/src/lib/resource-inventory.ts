/** Resource inventory, the single chokepoint for "what does this agent@version have" (RUSH-2238;
 * contract in cli/docs/specifications.md). Per kind: capable, declared (DotAgents layers), onDisk
 * (installed), wired (in harness config), unmanaged (onDisk - declared). Callers must use it. */

import type { AgentId } from './types.js';
import { AGENTS } from './agents.js';
import { supports } from './capabilities.js';
import { listResources } from './resources.js';
import {
  checkVersionHookWiring,
  listHooksInVersionHome,
  listInstalledHooksWithScope,
  type HookWiringReport,
} from './hooks/install.js';

export type InventoryKind = 'hooks' | 'skills' | 'commands' | 'plugins' | 'mcp';

export interface ResourceRef {
  name: string;
  path: string;
  source: string;
  detail?: string;
}

export interface ResourceInventory {
  // Capability, declaration, disk presence, wiring, and unmanaged state are orthogonal facts.
  agent: AgentId;
  version: string;
  kind: InventoryKind;
  capable: boolean;
  declared: ResourceRef[];
  onDisk: ResourceRef[];
  wired: ResourceRef[];
  unmanaged: ResourceRef[];
  wiringSupported: boolean;
  wiring?: HookWiringReport;
}

const IMPLEMENTED_KINDS: readonly InventoryKind[] = ['hooks'];

/** The single inventory API, harness-scoped (claude/codex/grok/kimi/droid), never a model or
 * profile. Throws for kinds without an implementation rather than return a half-empty report that
 * looks like truth. */
export function getResourceInventory(
  agent: AgentId,
  version: string,
  kind: InventoryKind,
  opts: { cwd?: string } = {}
): ResourceInventory {
  // Unimplemented kinds fail loud rather than fabricating an empty inventory.
  if (!IMPLEMENTED_KINDS.includes(kind)) {
    throw new Error(
      `getResourceInventory: kind '${kind}' is not implemented yet (implemented: ${IMPLEMENTED_KINDS.join(', ')}; tracked under RUSH-2236)`
    );
  }
  return hooksInventory(agent, version, opts.cwd);
}

/** On-disk hook listing for an explicit home plus the project overlay, the one listing
 * `getAgentResources` routes through so inspect/doctor/view share a hooks source; paths use the
 * absolute-hooksDir-safe join (RUSH-2237) so grok/kimi homes list real hooks. */
export function listOnDiskHooks(
  agent: AgentId,
  opts: { home?: string; cwd?: string } = {}
): ResourceRef[] {
  return listInstalledHooksWithScope(agent, opts.cwd ?? process.cwd(), { home: opts.home }).map(
    (h) => ({
      name: h.name,
      path: h.path,
      source: h.scope,
      detail: h.dataFile,
    })
  );
}

function hooksInventory(agent: AgentId, version: string, cwd?: string): ResourceInventory {
  const capable = supports(agent, 'hooks', version).ok;

  const declared: ResourceRef[] = listResources('hooks', cwd).map((r) => ({
    name: r.name.replace(/\.[^./]+$/, ''),
    path: r.path,
    source: r.source,
  }));

  let onDisk: ResourceRef[] = [];
  let wired: ResourceRef[] = [];
  let wiringSupported = false;
  let wiring: HookWiringReport | undefined;
  if (capable && AGENTS[agent]?.supportsHooks) {
    onDisk = listHooksInVersionHome(agent, version).map((e) => ({
      name: e.name,
      path: e.scriptPath,
      source: 'version-home',
      detail: e.dataFile,
    }));

    const report = checkVersionHookWiring(agent, version);
    wiring = report;
    // wired: [] is authoritative only after a supported native format parsed successfully.
    wiringSupported = report.supported && !report.settingsUnparseable;
    if (wiringSupported) {
      const eventsByName = new Map<string, Set<string>>();
      const commandByName = new Map<string, string>();
      for (const issue of report.wired) {
        let events = eventsByName.get(issue.name);
        if (!events) {
          events = new Set<string>();
          eventsByName.set(issue.name, events);
          commandByName.set(issue.name, issue.command);
        }
        events.add(issue.event);
      }
      wired = [...eventsByName.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, events]) => ({
          name,
          path: commandByName.get(name)!,
          source: 'native-config',
          detail: [...events].sort().join('/'),
        }));
    }
  }

  const declaredNames = new Set(declared.map((r) => r.name));
  const unmanaged = onDisk.filter((r) => !declaredNames.has(r.name));

  return {
    agent,
    version,
    kind: 'hooks',
    capable,
    declared,
    onDisk,
    wired,
    unmanaged,
    wiringSupported,
    wiring,
  };
}
