/** Public types for the staleness library. The on-disk manifest stays at `v: 1` for backward
 * compatibility; see `src/lib/sync-manifest.ts` for the loader/saver. */

import type { Fingerprint } from './fingerprint.js';

export const MANIFEST_VERSION = 1 as const;

/** A single-file resource (commands, hooks, MCP server YAML, permission groups). */
export interface FileEntry {
  source: Fingerprint;
}

/** A directory resource (skills, subagents, workflows). */
export interface DirEntry {
  /** Winning source dir, absolute. */
  dirPath: string;
  /** All files inside the dir, sorted by absolute path. */
  files: Fingerprint[];
}

/** Rules section — fingerprints of every source file (rules.yaml + active subrules). */
export interface RulesEntry {
  files: Record<string, FileEntry>;
}

/** Permissions section, merged across layers (every group in every scope contributes; same name
 * first-wins user > system), plus the active preset env value, since preset selection changes
 * which groups apply. */
export interface PermEntry {
  groups: Record<string, FileEntry>;
  permissionPreset: string | null;
}

/** Plugin entry. Plugins have a complex layout (`.claude-plugin/plugin.json`, optional `skills/`,
 * `commands/`), so the entire plugin root is fingerprinted, as a DirEntry. */
export type PluginEntry = DirEntry;

/** Full manifest. `workflows` and `plugins` are optional so older v1 files stay loadable; missing
 * fields read as empty maps, so the name-set diff triggers one re-sync that fills them. */
export interface SyncManifest {
  v:          typeof MANIFEST_VERSION;
  syncedAt:   string;
  commands:   Record<string, FileEntry>;
  /** Command names the version writer emitted during the preceding full sync. */
  writtenCommands?: string[];
  skills:     Record<string, DirEntry>;
  hooks:      Record<string, FileEntry>;
  rules:      RulesEntry;
  mcp:        Record<string, FileEntry>;
  permissions: PermEntry;
  subagents:  Record<string, DirEntry>;
  workflows?: Record<string, DirEntry>;
  plugins?:   Record<string, PluginEntry>;
  /** Absolute paths of artifacts the last full sync materialized (writer-reported,
   * `WriteResult.paths`). `isStale` treats a missing path as stale so a plain `agents sync`
   * restores a deleted resource (#2398). Absent = old manifest (stale once); [] is valid. */
  writtenTargets?: string[];
}
