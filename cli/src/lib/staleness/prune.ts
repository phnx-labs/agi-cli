/**
 * Manifest-bounded prune (RUSH-2438).
 *
 * `agents sync` was additive-only: it installed/updated resources present in
 * source but never removed a resource that had been DELETED from source, so a
 * removed command/skill/hook lingered in every installed version home forever
 * (and stayed live in the `/` menu). Bare `agents sync <agent>` full syncs did
 * sweep orphans, but the repo-scoped forms the reconcile path actually uses —
 * `agents sync <agent>@all system`, `agents sync <agent> system --force` — pass
 * a selection, which turned the orphan sweeps off. This closes that gap.
 *
 * The prune set is computed by name, bounded by the sync manifest:
 *
 *     prune = (names the last sync recorded as installed)
 *           − (names still present in source across ALL layers)
 *           ∩ (names currently materialized in the version home)
 *
 * Each clause is a safety guarantee:
 *   - The manifest bound means only agents-installed resources are ever
 *     candidates — a file the user hand-authored into the version home was
 *     never recorded, so it is never touched.
 *   - Diffing against ALL layers (not just the scoped one) means a resource
 *     still provided by any other layer — e.g. a same-named user command that
 *     shadows a removed system command — stays: it is still "in source".
 *   - Requiring the name to be materialized skips work for anything already
 *     gone and never errors on a missing path.
 *
 * When there is NO manifest we cannot know what a prior sync installed, so we
 * FAIL LOUD by pruning nothing and reporting it — never a "delete everything
 * not in source" guess. The manifest is written by the next full sync, so the
 * baseline heals itself.
 *
 * Deletion itself is delegated to each writer's `remove()` (the inverse of
 * `write()`), so per-harness layout knowledge — native file vs command-skill
 * dir vs goose recipe — lives in one place and can't drift.
 */
import type { AgentId } from '../types.js';
import type { SyncManifest } from './types.js';
import { getWriter, getDetector } from './registry.js';

/**
 * Kinds prune reconciles. Restricted to the name-keyed file/dir resources whose
 * writer implements `remove()`. Deliberately excluded, each with a reason:
 *   - hooks — a version-home hook script is coupled to a settings.json /
 *     hooks.json REGISTRATION. Pruning the last hook to zero would delete the
 *     script but must also GC its registration in the same pass, and that lands
 *     in `src/lib/hooks/install.ts` — a Windows-portable-path surface the CI windows leg
 *     gates on. Split to RUSH-2456 so this PR stays Linux-only-green; hook FILES
 *     are still reconciled by the in-write orphan sweep (versions.ts, gated on
 *     `hooksToSync > 0`).
 *   - rules / permissions — synced as a wholesale rewrite (one composed file /
 *     the full allowlist), so a removed rule or group already drops out.
 *   - plugins — carry their own reconciliation via `cleanOrphanedPluginSkills`.
 *   - mcp — registered through each agent's CLI/config, a separate removal path.
 *   - subagents / workflows — no clean per-name inverse yet (multi-agent index
 *     finalize; native workflow trees); tracked for a follow-up.
 */
export const PRUNABLE_KINDS = ['commands', 'skills'] as const;
export type PrunableKind = typeof PRUNABLE_KINDS[number];

interface PruneInput {
  agent: AgentId;
  version: string;
  versionHome: string;
  cwd: string;
  /**
   * The sync manifest loaded BEFORE this sync ran — the record of what the last
   * sync installed. `null` means no prior full sync established a baseline.
   */
  previousManifest: SyncManifest | null;
  /**
   * Current source resource names across ALL layers (project/user/system/extras),
   * per prunable kind. A name present here is still "in source" and never pruned.
   */
  sourceNames: Record<PrunableKind, ReadonlyArray<string>>;
}

interface PruneOutcome {
  /** Names actually removed from the version home, per kind. */
  pruned: Record<PrunableKind, string[]>;
  /**
   * True when prune ran with no manifest and therefore deleted nothing — the
   * fail-loud baseline case. Callers surface this so a skipped reconcile is
   * never mistaken for "nothing to prune".
   */
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

/**
 * Remove resources that a prior sync installed and that are now gone from
 * source, from one agent@version home. Deletes nothing when no manifest exists.
 */
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
