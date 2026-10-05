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

/** Resource kinds the inventory can report. Only 'hooks' is implemented so far
 *  (RUSH-2238); the remaining kinds land with their follow-up tickets. */
export type InventoryKind = 'hooks' | 'skills' | 'commands' | 'plugins' | 'mcp';

/** A reference to one resource in one state (declared / onDisk / wired). */
export interface ResourceRef {
  /** Stable install name (script basename without extension for hooks). */
  name: string;
  /** Declared/onDisk: absolute file path. Wired: the command string the native
   *  config references. */
  path: string;
  /** Origin: a layer name for declared ('project' | 'user' | 'system' | extra
   *  repo alias), 'user'/'project' scope or 'version-home' for onDisk,
   *  'native-config' for wired. */
  source: string;
  /** Optional context — e.g. the lifecycle events a wired hook fires on. */
  detail?: string;
}

export interface ResourceInventory {
  agent: AgentId;
  version: string;
  kind: InventoryKind;
  /** Agent+version feature flags allow this kind (version-aware gate). */
  capable: boolean;
  /** Declared in the DotAgents layers. */
  declared: ResourceRef[];
  /** Installed on disk in the version home. */
  onDisk: ResourceRef[];
  /** Referenced by the harness native config (empty when wiringSupported is
   *  false — the format parser for that harness is not implemented yet). */
  wired: ResourceRef[];
  /** onDisk − declared: installed orphans no layer declares. */
  unmanaged: ResourceRef[];
  /** Whether this harness's native wiring was read successfully. When false,
   *  `wired: []` means "unknown" (unsupported family OR unparseable config),
   *  NOT "nothing wired". Format-supported but corrupt configs set this false. */
  wiringSupported: boolean;
  /** Native-format diagnostic retained for doctor; derived in this same pass. */
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
  if (!IMPLEMENTED_KINDS.includes(kind)) {
    // Fail loud at the boundary: the kind is part of the API shape but its
    // inventory lands with a RUSH-2236 follow-up — a silent empty report would
    // read as "nothing installed".
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

  // Declared: the layered DotAgents repos are the declaration surface. Hook
  // script names carry their extension here ('git-guard.sh'); normalize to the
  // extension-less install name so declared/onDisk sets compare.
  const declared: ResourceRef[] = listResources('hooks', cwd).map((r) => ({
    name: r.name.replace(/\.[^./]+$/, ''),
    path: r.path,
    source: r.source,
  }));

  // onDisk / wired need the version home; both are empty for an agent whose
  // hooks capability is gated off (unknown agents included — AGENTS lookup
  // would otherwise throw).
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
    // supported=true means the harness format is known; settingsUnparseable means
    // we could not trust the file. Only report wired counts when the parse succeeded —
    // otherwise inspect/doctor would render "wired 0" for corrupt configs (PR #2140 review).
    wiringSupported = report.supported && !report.settingsUnparseable;
    if (wiringSupported) {
      // One ref per hook, events folded into detail — a hook wired under
      // PreToolUse AND Stop is one inventory entry, not two.
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
