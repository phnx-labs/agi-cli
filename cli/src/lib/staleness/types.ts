
import type { Fingerprint } from './fingerprint.js';

export const MANIFEST_VERSION = 1 as const;

export interface FileEntry {
  source: Fingerprint;
}

export interface DirEntry {
  dirPath: string;
  files: Fingerprint[];
}

export interface RulesEntry {
  files: Record<string, FileEntry>;
}

export interface PermEntry {
  groups: Record<string, FileEntry>;
  permissionPreset: string | null;
}

export type PluginEntry = DirEntry;

export interface SyncManifest {

  v:          typeof MANIFEST_VERSION;
  syncedAt:   string;
  commands:   Record<string, FileEntry>;
  writtenCommands?: string[];
  skills:     Record<string, DirEntry>;
  hooks:      Record<string, FileEntry>;
  rules:      RulesEntry;
  mcp:        Record<string, FileEntry>;
  permissions: PermEntry;
  subagents:  Record<string, DirEntry>;
  workflows?: Record<string, DirEntry>;
  plugins?:   Record<string, PluginEntry>;
  writtenTargets?: string[];
}
