/**
 * Shared layer-source resolution for writers.
 *
 * Layer precedence matches getResourceBases() in versions.ts. Project layer
 * is intentionally EXCLUDED for commands/skills/hooks/subagents/permissions
 * — those bodies become agent context, and a cloned public repo could ship
 * one that coerces the agent on the next launch. Trusted layers only:
 * user → system → extras.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId, PluginManifest } from '../../types.js';
import { getUserAgentsDir, getAgentsDir, getEnabledExtraRepos, getCommandsDir, getSkillsDir, getHooksDir } from '../../state.js';
import { isSafeSegmentName, safeJoin } from '../../paths.js';

/** Trusted source bases for content-like kinds. Project layer excluded. */
function trustedSourceBases(): { dir: string }[] {
  return [
    { dir: getUserAgentsDir() },
    { dir: getAgentsDir() },
    ...getEnabledExtraRepos().map((e) => ({ dir: e.dir })),
  ];
}

function isLiveFile(p: string): boolean {
  try {
    return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isLiveDir(p: string): boolean {
  try {
    return fs.existsSync(p) && !fs.lstatSync(p).isSymbolicLink() && fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readPluginManifest(pluginRoot: string): PluginManifest | null {
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!isLiveFile(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest;
    if (!manifest.name || !manifest.version) return null;
    return manifest;
  } catch {
    return null;
  }
}

function pluginSupportsAgent(manifest: PluginManifest, agent?: AgentId): boolean {
  if (!agent) return true;
  return !manifest.agents || manifest.agents.length === 0 || manifest.agents.includes(agent);
}

/** Every `plugins/<plugin>/skills` dir across trusted source bases, filtered to an optional plugin/agent scope. */
export function pluginSkillDirs(options: { agent?: AgentId; plugins?: Set<string> } = {}): string[] {
  const dirs: string[] = [];
  for (const base of trustedSourceBases()) {
    const pluginsDir = path.join(base.dir, 'plugins');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (options.plugins && !options.plugins.has(entry.name)) continue;
      const pluginRoot = path.join(pluginsDir, entry.name);
      const manifest = readPluginManifest(pluginRoot);
      if (!manifest || !pluginSupportsAgent(manifest, options.agent)) continue;
      dirs.push(path.join(pluginRoot, 'skills'));
    }
  }
  return dirs;
}

/** Find the trusted source for a command markdown by name. */
export function resolveCommandSource(name: string): string | null {
  const candidates = [
    safeJoin(path.join(getUserAgentsDir(), 'commands'), `${name}.md`),
    safeJoin(getCommandsDir(), `${name}.md`),
    ...getEnabledExtraRepos().map((e) => safeJoin(path.join(e.dir, 'commands'), `${name}.md`)),
  ];
  return candidates.find(isLiveFile) ?? null;
}

/** Find the trusted source directory for a skill by name. */
export function resolveSkillSource(name: string, options: { agent?: AgentId; plugins?: Set<string> } = {}): string | null {
  const candidates = [
    safeJoin(path.join(getUserAgentsDir(), 'skills'), name),
    safeJoin(getSkillsDir(), name),
    ...getEnabledExtraRepos().map((e) => safeJoin(path.join(e.dir, 'skills'), name)),
    ...pluginSkillDirs(options).map((skillsDir) => safeJoin(skillsDir, name)),
  ];
  return candidates.find(isLiveDir) ?? null;
}

/** List trusted plugin-bundled skill names, filtered to an optional plugin/agent scope. */
export function listPluginSkillNames(options: { agent?: AgentId; plugins?: Set<string> } = {}): string[] {
  const names = new Set<string>();
  for (const skillsDir of pluginSkillDirs(options)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (isLiveFile(path.join(skillsDir, entry.name, 'SKILL.md'))) {
        names.add(entry.name);
      }
    }
  }
  return Array.from(names);
}

/**
 * Subdirectories under hooks/ that are never group dirs.
 * Must stay in lockstep with HOOK_GROUP_SKIP_DIRS in hooks.ts.
 */
const HOOK_GROUP_SKIP_DIRS = new Set(['node_modules', '.git', '.cache']);

const HOOK_SCRIPT_EXTS = new Set([
  '.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.mjs', '.cjs', '.rb', '.pl', '.ps1', '.cmd', '.bat',
]);

function dirHasTopLevelScripts(groupDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(groupDir);
  } catch {
    return false;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!HOOK_SCRIPT_EXTS.has(ext)) continue;
    if (isLiveFile(path.join(groupDir, name))) return true;
  }
  return false;
}

function findNestedHookFile(hooksRoot: string, basename: string): string | null {
  if (!isLiveDir(hooksRoot)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(hooksRoot).sort();
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name.startsWith('.') || HOOK_GROUP_SKIP_DIRS.has(name)) continue;
    const groupDir = path.join(hooksRoot, name);
    if (!isLiveDir(groupDir)) continue;
    // Only group dirs (those with scripts) contribute nested scripts.
    if (!dirHasTopLevelScripts(groupDir)) continue;
    const candidate = path.join(groupDir, basename);
    if (isLiveFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Find the trusted source for a hook by name.
 * - File basename (`04-session-identity.sh`) or relative path
 *   (`session-starts/04-session-identity.sh`) → script file
 * - Directory basename (`tests`) → directory bundle (fixtures-only etc.)
 */
export function resolveHookSource(name: string): string | null {
  const roots = [
    path.join(getUserAgentsDir(), 'hooks'),
    getHooksDir(),
    ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'hooks')),
  ];
  const base = path.basename(name);

  for (const hooksRoot of roots) {
    // Exact relative path (top-level or group/name) — multi-segment needs
    // path.join + containment, not safeJoin (single-segment only).
    if (name.includes('/') || name.includes('\\')) {
      const candidate = path.resolve(hooksRoot, name);
      const rootResolved = path.resolve(hooksRoot);
      if (
        (candidate === rootResolved || candidate.startsWith(rootResolved + path.sep)) &&
        isLiveFile(candidate)
      ) {
        return candidate;
      }
    } else if (isSafeSegmentName(name)) {
      try {
        const top = safeJoin(hooksRoot, name);
        // File script first; then directory bundle (e.g. tests/ fixtures).
        if (isLiveFile(top)) return top;
        if (isLiveDir(top) && !dirHasTopLevelScripts(top)) return top;
      } catch {
        /* invalid segment */
      }
    }
    const nested = findNestedHookFile(hooksRoot, base);
    if (nested) return nested;
  }
  return null;
}

/** All trusted command-skill source roots, used to dedup name collisions for commands-as-skills writes. */
export function trustedSkillRoots(): string[] {
  return [
    path.join(getUserAgentsDir(), 'skills'),
    getSkillsDir(),
    ...getEnabledExtraRepos().map((e) => path.join(e.dir, 'skills')),
    ...pluginSkillDirs(),
  ];
}
