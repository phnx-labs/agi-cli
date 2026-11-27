
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from '../types.js';
import { getVersionsDir } from '../state.js';

import { commandsChecker } from './checkers/commands.js';
import { skillsChecker }   from './checkers/skills.js';
import { hooksChecker }    from './checkers/hooks.js';
import { mcpChecker }      from './checkers/mcp.js';
import { subagentsChecker } from './checkers/subagents.js';
import { workflowsChecker } from './checkers/workflows.js';
import { pluginsChecker }   from './checkers/plugins.js';
import { buildPermissions, isPermissionsStale } from './checkers/permissions.js';
import { buildRules, isRulesStale }             from './checkers/rules.js';

import type { ResourceChecker } from './checkers/types.js';
import {
  MANIFEST_VERSION,
  type SyncManifest,
  type FileEntry,
  type DirEntry,
  type PluginEntry,
  type RulesEntry,
} from './types.js';
import { nameSetDiffers } from './fingerprint.js';

export type { SyncManifest } from './types.js';
export { MANIFEST_VERSION } from './types.js';

const STANDARD_CHECKERS: ReadonlyArray<{
  checker: ResourceChecker;
  field: keyof Pick<SyncManifest, 'commands' | 'skills' | 'hooks' | 'mcp' | 'subagents' | 'workflows' | 'plugins'>;
}> = [
  { checker: commandsChecker,  field: 'commands'  },
  { checker: skillsChecker,    field: 'skills'    },
  { checker: hooksChecker,     field: 'hooks'     },
  { checker: mcpChecker,       field: 'mcp'       },
  { checker: subagentsChecker, field: 'subagents' },
  { checker: workflowsChecker, field: 'workflows' },
  { checker: pluginsChecker,   field: 'plugins'   },
];


function manifestPath(agent: AgentId, version: string): string {
  return path.join(getVersionsDir(), agent, version, 'home', '.sync-manifest.json');
}

export function loadManifest(agent: AgentId, version: string): SyncManifest | null {
  const p = manifestPath(agent, version);
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SyncManifest;
    if (raw.v !== MANIFEST_VERSION) return null;
    return raw;
  } catch {
    return null;
  }
}

export function syncInstalledSkillSources(manifest: SyncManifest | null): Map<string, string> {
  const sources = new Map<string, string>();
  if (!manifest) return sources;
  for (const [name, entry] of Object.entries({ ...manifest.retired?.skills, ...manifest.skills })) {
    sources.set(name, entry.dirPath);
  }
  const commands = { ...manifest.retired?.commands, ...manifest.commands };
  for (const name of manifest.writtenCommands ?? []) {
    if (!sources.has(name) && commands[name]) sources.set(name, commands[name].source.path);
  }
  for (const [plugin, entry] of Object.entries(manifest.plugins ?? {})) {
    for (const file of entry.files) {
      const rel = path.relative(entry.dirPath, file.path).split(path.sep);
      if (rel[0] === 'skills' && rel.length >= 3) {
        sources.set(rel[1], path.join(entry.dirPath, 'skills', rel[1]));
      } else if (rel[0] === 'commands' && rel.length === 2 && rel[1].endsWith('.md')) {
        sources.set(`${plugin}-${rel[1].slice(0, -3)}`, file.path);
      }
    }
  }
  return sources;
}

export function saveManifest(agent: AgentId, version: string, manifest: SyncManifest): void {
  const p = manifestPath(agent, version);
  const tmp = p + '.tmp';
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, p);
  } catch {
    try { fs.unlinkSync(tmp); } catch {  }
  }
}

export function buildManifest(
  agent: AgentId,
  version: string,
  cwd: string,
  previous?: SyncManifest | null,
): SyncManifest {
  const manifest: SyncManifest = {
    v: MANIFEST_VERSION,
    syncedAt: new Date().toISOString(),
    commands:  {},
    skills:    {},
    hooks:     {},
    rules:     { files: {} },
    mcp:       {},
    permissions: { groups: {}, permissionPreset: null },
    subagents: {},
    workflows: {},
    plugins:   {},
    writtenTargets: [],
  };

  for (const { checker, field } of STANDARD_CHECKERS) {
    const target = manifest[field] as Record<string, unknown>;
    const prevMap = (previous?.[field] ?? {}) as Record<string, unknown>;
    for (const name of checker.listNames(cwd)) {
      const prev = prevMap[name];

      if (prev !== undefined && checker.isFresh(name, prev, cwd)) {
        target[name] = prev;
        continue;
      }
      const entry = checker.build(name, cwd);
      if (entry !== null) target[name] = entry;
    }
  }

  manifest.retired = {
    commands: retireRemoved(manifest.commands, previous?.commands, previous?.retired?.commands),
    skills: retireRemoved(manifest.skills, previous?.skills, previous?.retired?.skills),
  };

  if (previous?.rules && !isRulesStale(previous.rules, agent, version, cwd)) {
    manifest.rules = previous.rules;
  } else {
    manifest.rules = buildRules(agent, version, cwd);
  }
  if (previous?.permissions && !isPermissionsStale(previous.permissions)) {
    manifest.permissions = previous.permissions;
  } else {
    manifest.permissions = buildPermissions();
  }
  return manifest;
}

function retireRemoved<E>(
  current: Record<string, E>,
  previous: Record<string, E> | undefined,
  previouslyRetired: Record<string, E> | undefined,
): Record<string, E> {
  const retired: Record<string, E> = {};
  for (const [name, entry] of Object.entries({ ...previouslyRetired, ...previous })) {
    if (!(name in current)) retired[name] = entry;
  }
  return retired;
}

export function isStale(
  manifest: SyncManifest,
  agent: AgentId,
  version: string,
  cwd: string
): boolean {
  for (const { checker, field } of STANDARD_CHECKERS) {
    const storedMap = (manifest[field] ?? {}) as Record<string, unknown>;
    const currentNames = checker.listNames(cwd);
    if (nameSetDiffers(Object.keys(storedMap), currentNames)) return true;
    for (const name of currentNames) {
      const entry = storedMap[name];
      if (entry === undefined) return true;
      if (!checker.isFresh(name, entry, cwd)) return true;
    }
  }
  if (isPermissionsStale(manifest.permissions)) return true;
  if (isRulesStale(manifest.rules, agent, version, cwd)) return true;
  if (manifest.writtenTargets === undefined) return true;
  for (const target of manifest.writtenTargets) {
    if (!fs.existsSync(target)) return true;
  }
  return false;
}

export type { FileEntry, DirEntry, PluginEntry, RulesEntry };
