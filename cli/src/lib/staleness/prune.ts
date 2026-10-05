import type { AgentId } from '../types.js';
import type { SyncManifest } from './types.js';
import { getWriter, getDetector } from './registry.js';

export const PRUNABLE_KINDS = ['commands', 'skills'] as const;
export type PrunableKind = typeof PRUNABLE_KINDS[number];

interface PruneInput {
  agent: AgentId;
  version: string;
  versionHome: string;
  cwd: string;
  previousManifest: SyncManifest | null;
  sourceNames: Record<PrunableKind, ReadonlyArray<string>>;
}

interface PruneOutcome {
  pruned: Record<PrunableKind, string[]>;
  skippedNoManifest: boolean;
}

function manifestNames(manifest: SyncManifest, kind: PrunableKind): string[] {
  switch (kind) {
    case 'commands': {
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

export function pruneRemovedResources(input: PruneInput): PruneOutcome {


  const { agent, version, versionHome, cwd, previousManifest, sourceNames } = input;

  if (!previousManifest) {
    return { pruned: emptyPruned(), skippedNoManifest: true };
  }

  const pruned = emptyPruned();

  for (const kind of PRUNABLE_KINDS) {
    const writer = getWriter(kind, agent);
    const detector = getDetector(kind, agent);
    if (!writer?.remove || !detector) continue;

    const installed = manifestNames(previousManifest, kind);
    if (installed.length === 0) continue;

    const stillInSource = new Set(sourceNames[kind]);
    const materialized = new Set(detector.list({ version, versionHome, cwd }));

    for (const name of installed) {
      if (stillInSource.has(name)) continue;
      if (!materialized.has(name)) continue;
      const result = writer.remove({ version, versionHome, name, cwd });
      if (result.removed) pruned[kind].push(name);
    }
  }

  return { pruned, skippedNoManifest: false };
}
