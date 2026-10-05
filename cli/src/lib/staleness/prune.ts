/** Manifest-bounded prune (RUSH-2438): prune = (names last sync recorded) minus (names in source
 * across ALL layers) intersect (names materialized), so user-authored files and shadowed names are
 * safe. No manifest: prune nothing and fail loud, never guess. Deletes via each writer's remove(). */
import type { AgentId } from '../types.js';
import type { SyncManifest } from './types.js';
import { getWriter, getDetector } from './registry.js';

/** Kinds prune reconciles: name-keyed resources whose writer implements `remove()`. Excluded: hooks
 * (registration GC needed, RUSH-2456), rules/permissions (wholesale rewrites), plugins (own
 * reconcile), mcp (separate removal path), subagents/workflows (no per-name inverse yet). */
export const PRUNABLE_KINDS = ['commands', 'skills'] as const;
export type PrunableKind = typeof PRUNABLE_KINDS[number];

interface PruneInput {
  agent: AgentId;
  version: string;
  versionHome: string;
  cwd: string;
  /** The sync manifest loaded before this sync: the record of what the last sync installed.
   * `null` means no prior full sync set a baseline. */
  previousManifest: SyncManifest | null;
  /** Current source resource names across all layers (project/user/system/extras) per prunable
   * kind. A name here is still in source and never pruned. */
  sourceNames: Record<PrunableKind, ReadonlyArray<string>>;
}

interface PruneOutcome {
  /** Names actually removed from the version home, per kind. */
  pruned: Record<PrunableKind, string[]>;
  /** True when prune ran with no manifest and deleted nothing (the fail-loud baseline). Callers
   * surface it so a skipped reconcile is never mistaken for 'nothing to prune'. */
  skippedNoManifest: boolean;
}

/** Names the manifest recorded as installed for a kind (source-name keyed). */
function manifestNames(manifest: SyncManifest, kind: PrunableKind): string[] {
  switch (kind) {
    case 'commands': {
      // Object keys are the source command names; writtenCommands carries any
      // extra names the writer actually emitted (dual-write / command-skill).
      const names = new Set(Object.keys(manifest.commands ?? {}));
      for (const c of manifest.writtenCommands ?? []) names.add(c);
      return [...names];
    }
    case 'skills': return Object.keys(manifest.skills ?? {});
  }
}

function emptyPruned(): Record<PrunableKind, string[]> {
  return { commands: [], skills: [] };
}

/** Remove resources a prior sync installed that are now gone from source, in one agent@version
 * home. Deletes nothing without a manifest. */
export function pruneRemovedResources(input: PruneInput): PruneOutcome {
  const { agent, version, versionHome, cwd, previousManifest, sourceNames } = input;

  if (!previousManifest) {
    return { pruned: emptyPruned(), skippedNoManifest: true };
  }

  const pruned = emptyPruned();

  for (const kind of PRUNABLE_KINDS) {
    const writer = getWriter(kind, agent);
    const detector = getDetector(kind, agent);
    // No writer.remove (unsupported kind/agent) or no detector: nothing to do.
    if (!writer?.remove || !detector) continue;

    const installed = manifestNames(previousManifest, kind);
    if (installed.length === 0) continue;

    const stillInSource = new Set(sourceNames[kind]);
    const materialized = new Set(detector.list({ version, versionHome, cwd }));

    for (const name of installed) {
      if (stillInSource.has(name)) continue;   // still provided by some layer
      if (!materialized.has(name)) continue;    // already gone from the home
      const result = writer.remove({ version, versionHome, name, cwd });
      if (result.removed) pruned[kind].push(name);
    }
  }

  return { pruned, skippedNoManifest: false };
}
