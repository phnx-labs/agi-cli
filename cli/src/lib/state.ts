/** Filesystem layout for agents-cli under ~/.agents/: user repo (resources + agents.yaml, pushed by
 * `agents repo push`), `.system/` (npm-shipped, do not hand-edit), `.history/` (durable, backed
 * up), `.cache/` (regenerable, gitignored). Precedence: project > user > system. */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { stringifyDoc } from './yaml-io.js';
import { execFileSync } from 'child_process';
import { ensureLockTarget, atomicWriteFileSync, withFileLock } from './fs-atomic.js';
import type { Meta, RegistryType } from './types.js';
import { DEFAULT_SYSTEM_REPO, systemRepoSlug } from './types.js';
import { machineId } from './machine-id.js';

const HOME = process.env.HOME ?? os.homedir();

/** Compare two paths for identity, resolving symlinks and Windows 8.3 short vs long names via the
 * OS realpath; falls back to a case-folded normalize when a path does not exist. */
function isSamePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    const norm = (p: string) =>
      process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    return norm(a) === norm(b);
  }
}

// ─── Root directories ─────────────────────────────────────────────────────────

/** User repo — user-authored resources and agents.yaml. Always-on. */
const USER_AGENTS_DIR = path.join(HOME, '.agents');

/** System repo — npm-shipped, read-only from user commands. Lives inside the user repo. */
const SYSTEM_AGENTS_DIR = path.join(USER_AGENTS_DIR, '.system');

/** Legacy system-repo location (pre-fold), exported only so the migrator can fold it into
 * SYSTEM_AGENTS_DIR. Runtime code must use SYSTEM_AGENTS_DIR. */
const LEGACY_SYSTEM_AGENTS_DIR = path.join(HOME, '.agents-system');

// ─── Meta file (agents.yaml lives in the user repo) ──────────────────────────

const META_FILE = path.join(USER_AGENTS_DIR, 'agents.yaml');
/** Legacy location — used only for one-shot migration in readMeta(). */
const SYSTEM_META_FILE = path.join(SYSTEM_AGENTS_DIR, 'agents.yaml');

/** Canonical path for the humans.yaml owner-identity/channel config. */
const HUMANS_FILE = path.join(USER_AGENTS_DIR, 'humans.yaml');

/** Return the absolute path to the humans.yaml file. */
export function getHumansFilePath(): string { return process.env.AGENTS_HUMANS_FILE ?? HUMANS_FILE; }

// ─── System resource dirs ─────────────────────────────────────────────────────

const SYSTEM_COMMANDS_DIR = path.join(SYSTEM_AGENTS_DIR, 'commands');
const SYSTEM_HOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'hooks');
const SYSTEM_SKILLS_DIR = path.join(SYSTEM_AGENTS_DIR, 'skills');
const SYSTEM_RULES_DIR = path.join(SYSTEM_AGENTS_DIR, 'rules');
const SYSTEM_MCP_DIR = path.join(SYSTEM_AGENTS_DIR, 'mcp');
const SYSTEM_PERMISSIONS_DIR = path.join(SYSTEM_AGENTS_DIR, 'permissions');
const SYSTEM_SUBAGENTS_DIR = path.join(SYSTEM_AGENTS_DIR, 'subagents');
const SYSTEM_WORKFLOWS_DIR = path.join(SYSTEM_AGENTS_DIR, 'workflows');
const SYSTEM_PLUGINS_DIR = path.join(SYSTEM_AGENTS_DIR, 'plugins');
// Built-in routines shipped in the system repo (gh:phnx-labs/.agents-system).
// Unioned under user routines by listJobs()/readJob() so a routine shipped here
// fires for every install, while a user routine of the same name overrides it.
const SYSTEM_ROUTINES_DIR = path.join(SYSTEM_AGENTS_DIR, 'routines');
// Built-in monitors shipped in the system repo (gh:phnx-labs/.agents-system), unioned under user
// monitors by listMonitors()/readMonitor(). A same-named user monitor overrides it; a built-in
// with no `enabled:` field stays opt-in.
const SYSTEM_MONITORS_DIR = path.join(SYSTEM_AGENTS_DIR, 'monitors');
const SYSTEM_WEBHOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'webhooks');
const SYSTEM_PROMPTCUTS_FILE = path.join(SYSTEM_AGENTS_DIR, 'hooks', 'promptcuts.yaml');
const SYSTEM_MCP_CONFIG_FILE = path.join(SYSTEM_AGENTS_DIR, 'mcp.json');
const SYSTEM_INSTRUCTIONS_FILE = path.join(SYSTEM_AGENTS_DIR, 'instructions.md');

// ─── User repo operational buckets ────────────────────────────────────────────

/** Durable runtime data (sessions, versions, runs, teams history, trash, backups). */
const HISTORY_DIR = path.join(USER_AGENTS_DIR, '.history');

/** Regenerable runtime data (shims, packages, helpers, terminals, cloud, drive, logs, browser). */
const CACHE_DIR = path.join(USER_AGENTS_DIR, '.cache');

// Top-level user dirs (config/definitions only — runtime moves into .history/.cache).
const ROUTINES_DIR = path.join(USER_AGENTS_DIR, 'routines');
const WEBHOOKS_DIR = path.join(USER_AGENTS_DIR, 'webhooks');
// Monitor definitions (event-triggered watchers). Sibling of ROUTINES_DIR: a
// monitor is a routine whose trigger is a watched source instead of a clock.
const MONITORS_DIR = path.join(USER_AGENTS_DIR, 'monitors');
const TEAMS_DIR = path.join(USER_AGENTS_DIR, 'teams');
// Named project definitions (the layer above the --project convention). Sibling
// of ROUTINES_DIR/TEAMS_DIR: hand-editable YAML, synced across machines by push/pull.
const PROJECTS_DIR = path.join(USER_AGENTS_DIR, 'projects');
// Daemon service toggles and persistent daemon config. Top-level config/definitions
// dir like routines/webhooks; runtime state (pid/heartbeat/logs) stays in .cache.
const DAEMON_CONFIG_DIR = path.join(USER_AGENTS_DIR, 'daemon');

// History bucket (durable).
const SESSIONS_DIR = path.join(HISTORY_DIR, 'sessions');
const SESSIONS_DB_PATH = path.join(SESSIONS_DIR, 'sessions.db');
const ANALYTICS_DIR = path.join(HISTORY_DIR, 'analytics');
const VERSIONS_DIR = path.join(HISTORY_DIR, 'versions');
const RUNS_DIR = path.join(HISTORY_DIR, 'runs');
// Durable per-monitor state-diff store + fire history (last-seen value/hash,
// fires/<id>/). Sibling of RUNS_DIR — the native diff store that replaces the
// hand-rolled markdown memory files monitors used to need.
const MONITORS_HISTORY_DIR = path.join(HISTORY_DIR, 'monitors');
const TEAMS_AGENTS_DIR = path.join(HISTORY_DIR, 'teams', 'agents');
const BACKUPS_DIR = path.join(HISTORY_DIR, 'backups');
const TRASH_DIR = path.join(HISTORY_DIR, 'trash');
const MAILBOX_DIR = path.join(HISTORY_DIR, 'mailbox');
const FEED_DIR = path.join(HISTORY_DIR, 'feed');
const ACTIVITY_DIR = path.join(HISTORY_DIR, 'activity');

// Cache bucket (regenerable).
const SHIMS_DIR = path.join(CACHE_DIR, 'shims');
const HOOK_SHIMS_DIR = path.join(SHIMS_DIR, 'hooks');
const HOOK_CACHE_DIR = path.join(CACHE_DIR, 'state', 'hooks');
const BIN_DIR = path.join(CACHE_DIR, 'bin');
const PACKAGES_DIR = path.join(CACHE_DIR, 'packages');
// Plugins are user-authored resources, alongside skills/, commands/, hooks/.
// They live at the user-root so they're git-tracked as source of truth.
const PLUGINS_DIR = path.join(USER_AGENTS_DIR, 'plugins');
const CLOUD_DIR = path.join(CACHE_DIR, 'cloud');
const TERMINALS_DIR = path.join(CACHE_DIR, 'terminals');
const LOGS_DIR = path.join(CACHE_DIR, 'logs');
/** Disposable performance samples (~/.agents/.cache/perf/) — safe to wipe. */
const PERF_DIR = path.join(CACHE_DIR, 'perf');
const RUNTIME_STATE_DIR = path.join(CACHE_DIR, 'state');
const COMPANION_CACHE_DIR = path.join(CACHE_DIR, 'companion');
const BROWSER_RUNTIME_DIR = path.join(CACHE_DIR, 'browser');
const HELPERS_DIR = path.join(CACHE_DIR, 'helpers');
const DAEMON_DIR = path.join(HELPERS_DIR, 'daemon');
const TMUX_DIR = path.join(HELPERS_DIR, 'tmux');
const FETCH_CACHE_DIR = path.join(CACHE_DIR, '.fetch');
const CLI_VERSION_CACHE_FILE = path.join(CACHE_DIR, '.cli-version-cache.json');
const MODELS_CACHE_FILE = path.join(CACHE_DIR, '.models-cache.json');
const UPDATE_CHECK_FILE = path.join(CACHE_DIR, '.update-check');
const MIGRATED_SENTINEL_FILE = path.join(CACHE_DIR, '.migrated');

// ─── User resource dirs ───────────────────────────────────────────────────────

const USER_COMMANDS_DIR = path.join(USER_AGENTS_DIR, 'commands');
const USER_HOOKS_DIR = path.join(USER_AGENTS_DIR, 'hooks');
const USER_SKILLS_DIR = path.join(USER_AGENTS_DIR, 'skills');
const USER_RULES_DIR = path.join(USER_AGENTS_DIR, 'rules');
const USER_MCP_DIR = path.join(USER_AGENTS_DIR, 'mcp');
const USER_PERMISSIONS_DIR = path.join(USER_AGENTS_DIR, 'permissions');
const USER_SUBAGENTS_DIR = path.join(USER_AGENTS_DIR, 'subagents');
const USER_WORKFLOWS_DIR = path.join(USER_AGENTS_DIR, 'workflows');
const USER_SECRETS_DIR = path.join(USER_AGENTS_DIR, 'secrets');
const USER_PROMPTCUTS_FILE = path.join(USER_AGENTS_DIR, 'hooks', 'promptcuts.yaml');

/** Header prepended to every agents.yaml the CLI writes (central and per-device), with the
 * yaml-language-server schema hint for `schema/agents-yaml.schema.json`. Exported so
 * `lib/devices/config-migration.ts` rewrites device docs with the same header. */
export const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agi-cli
# yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json

`;

// ─── Root getters ─────────────────────────────────────────────────────────────

/** Root of the system data directory (~/.agents/.system/). */
export function getAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

/** Root of the system data directory (~/.agents/.system/). */
export function getSystemAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

/** Legacy system-repo location (~/.agents-system/). Exported for migration only. */
export function getLegacySystemAgentsDir(): string {
  return LEGACY_SYSTEM_AGENTS_DIR;
}

/** Root of the user repo (~/.agents/). Always present after ensureAgentsDir(). */
export function getUserAgentsDir(): string {
  return USER_AGENTS_DIR;
}

/** Backward-compat shim: null when ~/.agents/ is a symlink to the system dir, else USER_AGENTS_DIR.
 * @deprecated Use getUserAgentsDir() directly. */
export function getOptionalUserAgentsDir(): string | null {
  if (fs.existsSync(USER_AGENTS_DIR)) {
    try {
      const stat = fs.lstatSync(USER_AGENTS_DIR);
      if (stat.isSymbolicLink()) {
        try {
          if (fs.realpathSync(USER_AGENTS_DIR) === fs.realpathSync(SYSTEM_AGENTS_DIR)) return null;
        } catch { return null; }
      }
    } catch { /* dir may not exist yet */ }
  }
  return USER_AGENTS_DIR;
}

/** Origin `owner/repo` slug (lowercased, `.git` stripped) of a git checkout, or null when `dir` is
 * not a git repo or has no origin. Handles scp, https and ssh remote forms. Sync (`execFileSync`)
 * so the synchronous getProjectAgentsDir walk can use it. */
function gitOriginSlug(dir: string): string | null {
  let url: string;
  try {
    url = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
  if (!url) return null;
  const m = url.replace(/\.git$/i, '').match(/[:/]([^/:]+\/[^/]+)$/);
  return m ? m[1].toLowerCase() : null;
}

/** Slugs of the user + system DotAgents repos — a checkout of any of these is not a project layer. */
function canonicalDotAgentsRepoSlugs(): Set<string> {
  const slugs = new Set<string>([systemRepoSlug(DEFAULT_SYSTEM_REPO).toLowerCase()]);
  for (const dir of [USER_AGENTS_DIR, SYSTEM_AGENTS_DIR]) {
    const slug = gitOriginSlug(dir);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/** True when `agentsPath` is a git checkout of the user's or system's DotAgents repo. Such a clone
 * must not also be a project layer: project outranks user, so a stale clone would shadow live user
 * rules and plant a compiled AGENTS.md in an ancestor (RUSH-2037). */
function isUserOrSystemRepoCheckout(agentsPath: string): boolean {
  if (!fs.existsSync(path.join(agentsPath, '.git'))) return false;
  const origin = gitOriginSlug(agentsPath);
  if (!origin) return false;
  return canonicalDotAgentsRepoSlugs().has(origin);
}

/** True when `agentsPath` is a reserved `.agents` root never treated as a project layer: the user
 * repo, the system repo, or a checkout of either. getProjectAgentsDir skips these walking up;
 * `compileRulesForProject` uses the same predicate so `$HOME` never compiles (RUSH-2725). */
export function isReservedAgentsDir(agentsPath: string): boolean {
  return isSamePath(agentsPath, SYSTEM_AGENTS_DIR)
    || isSamePath(agentsPath, USER_AGENTS_DIR)
    || isUserOrSystemRepoCheckout(agentsPath);
}

/** Walk up from startPath to find a project-scoped .agents/ directory (skipping both roots). */
export function getProjectAgentsDir(startPath: string = process.cwd()): string | null {
  let dir = path.resolve(startPath);

  while (true) {
    const agentsPath = path.join(dir, '.agents');
    if (fs.existsSync(agentsPath) && fs.statSync(agentsPath).isDirectory()) {
      if (!isReservedAgentsDir(agentsPath)) {
        return agentsPath;
      }
    }

    const isProjectBoundary = fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'agents.yaml'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (isProjectBoundary) break;
    dir = parent;
  }

  return null;
}

/** Return all .agents/ directories in scope: project, user, then system. */
export function getScopedAgentsDirs(startPath: string = process.cwd()): Array<{ scope: 'project' | 'user' | 'system'; path: string }> {
  const dirs: Array<{ scope: 'project' | 'user' | 'system'; path: string }> = [];
  const projectDir = getProjectAgentsDir(startPath);
  if (projectDir) {
    dirs.push({ scope: 'project', path: projectDir });
  }
  dirs.push({ scope: 'user', path: USER_AGENTS_DIR });
  dirs.push({ scope: 'system', path: SYSTEM_AGENTS_DIR });
  return dirs;
}

// ─── System resource getters (legacy aliases for read/sync paths) ─────────────

/** Path to slash command markdown files — system repo. */
export function getCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }

/** Path to hook script directories — system repo. */
export function getHooksDir(): string { return SYSTEM_HOOKS_DIR; }

/** Path to skill bundles — system repo. */
export function getSkillsDir(): string { return SYSTEM_SKILLS_DIR; }

/** Path to the canonical rules directory — system repo. */
export function getRulesDir(): string { return SYSTEM_RULES_DIR; }

/** Read-side resolution for the canonical rules dir — system repo. */
export function getResolvedRulesDir(): string { return SYSTEM_RULES_DIR; }

/** Path to MCP server YAML configs — system repo. */
export function getMcpDir(): string { return SYSTEM_MCP_DIR; }

/** Path to permission group YAML files — system repo. */
export function getPermissionsDir(): string { return process.env.AGENTS_SYSTEM_PERMISSIONS_DIR ?? SYSTEM_PERMISSIONS_DIR; }

/** Path to subagent definition directories — system repo. */
export function getSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }

/** Path to ~/.agents/.system/hooks/promptcuts.yaml (system defaults). */
export function getPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

/** Resolve the effective promptcuts file: the user file if it exists, else the system file. For
 * callers needing one path (doctor diff, display); use readMergedPromptcuts() for the merged set. */
export function getEffectivePromptcutsPath(): string {
  if (fs.existsSync(USER_PROMPTCUTS_FILE)) return USER_PROMPTCUTS_FILE;
  return SYSTEM_PROMPTCUTS_FILE;
}

/** Read promptcuts from system + user with user precedence, returning the merged `shortcuts` map
 * (same layering as parseHookManifest()). Empty when neither file exists or both fail to parse. */
export function readMergedPromptcuts(): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const filePath of [SYSTEM_PROMPTCUTS_FILE, USER_PROMPTCUTS_FILE]) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as
        | { shortcuts?: Record<string, unknown> }
        | null;
      if (!parsed?.shortcuts) continue;
      for (const [key, value] of Object.entries(parsed.shortcuts)) {
        merged[key] = value;
      }
    } catch {
      // Skip unreadable file, keep going
    }
  }
  return merged;
}

/** Path to the legacy MCP config JSON. */
export function getMcpConfigPath(): string { return SYSTEM_MCP_CONFIG_FILE; }

/** Path to the global instructions file. */
export function getInstructionsPath(): string { return SYSTEM_INSTRUCTIONS_FILE; }

// ─── System-specific getters ───────────────────────────────────────────────────

export function getSystemCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }
export function getSystemHooksDir(): string { return SYSTEM_HOOKS_DIR; }
export function getSystemSkillsDir(): string { return SYSTEM_SKILLS_DIR; }
export function getSystemRulesDir(): string { return SYSTEM_RULES_DIR; }
export function getSystemMcpDir(): string { return SYSTEM_MCP_DIR; }
export function getSystemPermissionsDir(): string { return SYSTEM_PERMISSIONS_DIR; }
export function getSystemSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }
export function getSystemPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

// ─── User resource getters ────────────────────────────────────────────────────

export function getUserCommandsDir(): string { return USER_COMMANDS_DIR; }
export function getUserHooksDir(): string { return USER_HOOKS_DIR; }
export function getUserSkillsDir(): string { return USER_SKILLS_DIR; }
export function getUserRulesDir(): string { return USER_RULES_DIR; }
export function getUserMcpDir(): string { return USER_MCP_DIR; }
export function getUserPermissionsDir(): string { return process.env.AGENTS_USER_PERMISSIONS_DIR ?? USER_PERMISSIONS_DIR; }
export function getUserSubagentsDir(): string { return USER_SUBAGENTS_DIR; }

export function getSystemWorkflowsDir(): string { return SYSTEM_WORKFLOWS_DIR; }
export function getUserWorkflowsDir(): string { return USER_WORKFLOWS_DIR; }
export function getUserSecretsDir(): string { return USER_SECRETS_DIR; }
/** Path to the secrets usage read-model database (~/.agents/secrets/secrets.db), read at call time
 * so tests can redirect it via AGENTS_SECRETS_DB. Value-free usage telemetry only, never a secret.
 * Its writer left with the standalone `secrets` engine (PHNX-3989); nothing writes it today. */
export function getSecretsDbPath(): string {
  return process.env.AGENTS_SECRETS_DB ?? path.join(USER_SECRETS_DIR, 'secrets.db');
}
/** Path to the durable resource-usage warehouse (~/.agents/.history/analytics/usage.db): value-free
 * frequency/lifecycle events. Read at call time so AGENTS_USAGE_DB can redirect tests; sync shards
 * may appear as usage.<machine-id>.db beside it. */
export function getAnalyticsDir(): string {
  return process.env.AGENTS_ANALYTICS_DIR ?? ANALYTICS_DIR;
}
export function getUsageDbPath(): string {
  return process.env.AGENTS_USAGE_DB ?? path.join(getAnalyticsDir(), 'usage.db');
}
export function getUserPromptcutsPath(): string { return USER_PROMPTCUTS_FILE; }

// User operational path getters. Top-level dirs hold definitions and configs only; runtime data
// lives under .history/ (durable) or .cache/ (regenerable). See the file header.

/** Canonical home anchor (HOME env override or os.homedir()). */
export function getHomeDir(): string { return HOME; }

/** Bucket root for durable runtime data (~/.agents/.history/). */
export function getHistoryDir(): string { return HISTORY_DIR; }

/** Bucket root for regenerable runtime data (~/.agents/.cache/). */
export function getCacheDir(): string { return CACHE_DIR; }

/** Path to cloned packages (~/.agents/.cache/packages/). */
export function getPackagesDir(): string { return PACKAGES_DIR; }

/** Path to routine YAML definitions (~/.agents/routines/). */
export function getRoutinesDir(): string { return process.env.AGENTS_ROUTINES_DIR ?? ROUTINES_DIR; }

/** Path to named project definitions (~/.agents/projects/). */
export function getProjectsDir(): string { return process.env.AGENTS_PROJECTS_DIR ?? PROJECTS_DIR; }

/** Path to daemon config directory (~/.agents/daemon/). Holds service toggles. */
export function getDaemonConfigDir(): string { return process.env.AGENTS_DAEMON_CONFIG_DIR ?? DAEMON_CONFIG_DIR; }

/** Path to webhook handler YAML definitions (~/.agents/webhooks/): one-off triggers for agents,
 * workflows, commands and routines, layered like routines (project > user > system). */
export function getWebhooksDir(): string { return process.env.AGENTS_WEBHOOKS_DIR ?? WEBHOOKS_DIR; }

/** Path to built-in routine definitions in the system repo (`~/.agents/.system/routines/`), unioned
 * under the user routines dir by listJobs()/readJob(). A same-named user routine overrides it
 * (`enabled: false` disables the built-in). The daemon fires these. */
export function getSystemRoutinesDir(): string { return process.env.AGENTS_SYSTEM_ROUTINES_DIR ?? SYSTEM_ROUTINES_DIR; }

/** Path to built-in webhook handler definitions in the system repo (`~/.agents/.system/webhooks/`),
 * layered under user handlers by `listHandlers()`. */
export function getSystemWebhooksDir(): string { return process.env.AGENTS_SYSTEM_WEBHOOKS_DIR ?? SYSTEM_WEBHOOKS_DIR; }

/** Path to a project-scoped routines directory (`<project>/.agents/routines/`), or null if none is
 * found walking up from cwd. Firing needs `agents routines enable <name>`; a project YAML's own
 * `enabled:` never turns firing on, so a cloned repo cannot auto-run. */
export function getProjectRoutinesDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'routines');
}

/** Path to a project-scoped webhook handlers directory (`<project>/.agents/webhooks/`), or null if
 * no project `.agents/` is found walking up from cwd. */
export function getProjectWebhooksDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'webhooks');
}

/** Path to routine execution logs (~/.agents/.history/runs/). */
export function getRunsDir(): string { return RUNS_DIR; }

/** Path to monitor YAML definitions (~/.agents/monitors/). */
export function getMonitorsDir(): string { return process.env.AGENTS_MONITORS_DIR ?? MONITORS_DIR; }

/** Built-in monitor definitions shipped in the system repo (`~/.agents/.system/monitors/`).
 * A user monitor of the same name overrides it; `enabled: false` shadows it. Owner-pinned
 * via `device:` for shared inputs (SING-9). The directory need not exist. */
export function getSystemMonitorsDir(): string { return process.env.AGENTS_SYSTEM_MONITORS_DIR ?? SYSTEM_MONITORS_DIR; }

/** Path to the durable per-monitor state-diff store + fire history
 * (~/.agents/.history/monitors/). */
export function getMonitorsHistoryDir(): string { return MONITORS_HISTORY_DIR; }

/** Root for per-agent mailboxes (~/.agents/.history/mailbox/). */
export function getMailboxRootDir(): string { return MAILBOX_DIR; }

/** Root for open-block feed records (~/.agents/.history/feed/). */
export function getFeedDir(): string { return FEED_DIR; }

/** Append-only per-session agent-activity event logs (~/.agents/.history/activity/). */
export function getActivityDir(): string { return ACTIVITY_DIR; }

/** Path to installed agent CLI binaries (~/.agents/.history/versions/). */
export function getVersionsDir(): string { return VERSIONS_DIR; }

/** Path to version-switching shim scripts (~/.agents/.cache/shims/). */
export function getShimsDir(): string { return SHIMS_DIR; }

/** Generated hook shim dir (~/.agents/.cache/shims/hooks/), read at CALL time.
 * AGENTS_HOOK_SHIMS_DIR keeps in-process tests from writing shims into the real cache;
 * never set in production code. */
export function getHookShimsDir(): string {
  return process.env.AGENTS_HOOK_SHIMS_DIR ?? HOOK_SHIMS_DIR;
}

/** Per-hook stdout cache dir (~/.agents/.cache/state/hooks/), read at CALL time like
 * {@link getHookShimsDir}. */
export function getHookCacheDir(): string {
  return process.env.AGENTS_HOOK_CACHE_DIR ?? HOOK_CACHE_DIR;
}

/** Path to per-agent installed CLI binaries (~/.agents/.cache/bin/). */
export function getBinDir(): string { return BIN_DIR; }

/** Path to config backups (~/.agents/.history/backups/). */
export function getBackupsDir(): string { return BACKUPS_DIR; }

/** Path to plugin bundles (~/.agents/plugins/) — user-authored resource. */
export function getPluginsDir(): string { return PLUGINS_DIR; }

/** Path to system plugin bundles (~/.agents/.system/plugins/) — npm-shipped, read-only defaults. */
export function getSystemPluginsDir(): string { return SYSTEM_PLUGINS_DIR; }

/** Path to an extra repo's plugin bundles (~/.agents-<alias>/plugins/). */
export function getExtraPluginsDir(alias: string): string {
  return path.join(getExtraRepoDir(alias), 'plugins');
}

/** Path to a project-scoped plugins directory (<project>/.agents/plugins/), or null when none. */
export function getProjectPluginsDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'plugins');
}

/** Path to soft-deleted resources (~/.agents/.history/trash/). */
export function getTrashDir(): string { return TRASH_DIR; }

/** Path to local session indexer storage (~/.agents/.history/sessions/). */
export function getSessionsDir(): string { return SESSIONS_DIR; }

/** Path to the session index database (~/.agents/.history/sessions/sessions.db). */
export function getSessionsDbPath(): string {
  return process.env.AGENTS_SESSIONS_DB ?? SESSIONS_DB_PATH;
}

/** Path to teams config + registry (~/.agents/teams/). */
export function getTeamsDir(): string { return TEAMS_DIR; }

/** Path to teams execution history (~/.agents/.history/teams/agents/). */
export function getTeamsAgentsDir(): string { return TEAMS_AGENTS_DIR; }

/** Path to the team registry — list of named teams with timestamps. Durable runtime, per-machine. */
export function getTeamsRegistryPath(): string { return path.join(HISTORY_DIR, 'teams', 'registry.json'); }

/** Devices dir holding the registry (the ignore-list is `fleet.ignored`, RUSH-3062).
 * Read at CALL time so AGENTS_DEVICES_DIR can redirect tests; keeps vitest writes
 * away from the real ~/.agents/.history/devices (RUSH-2042). Never set in production. */
function getDevicesDir(): string {
  return process.env.AGENTS_DEVICES_DIR ?? path.join(HISTORY_DIR, 'devices');
}

/** Path to the device registry — SSH device profiles with platform/auth metadata. Durable runtime, per-machine (host list + addresses are NOT pulled by `agents repo push`). */
export function getDevicesRegistryPath(): string { return path.join(getDevicesDir(), 'registry.json'); }

/** Path to the LEGACY per-machine device ignore-list — superseded by the tracked `fleet.ignored` list in central agents.yaml (RUSH-3062); only lib/devices/config-migration.ts still reads it (to fold + remove it). */
export function getDevicesIgnoredPath(): string { return path.join(getDevicesDir(), 'ignored.json'); }

/** Path to the LEGACY device auto-launch preference file — which registered devices are eligible/preferred for the ext's auto-host selection. Superseded by the per-device doc `config:` block; only lib/devices/config-migration.ts still reads it (to fold + remove it). */
export function getDevicesAutoLaunchPath(): string { return path.join(getDevicesDir(), 'auto-launch.json'); }

/** Path to THIS machine's agent pins (`agents:` and `isolatedAgents:`). Machine-local and
 * untracked under `.history/devices/`, since tracked auto-written pins churned commits
 * on every `agents use` / install. Read at call time. */
export function getDevicePinsPath(): string { return path.join(getDevicesDir(), `pins-${machineId()}.json`); }

/** Dir of "pending device" sentinels (~/.agents/.cache/state/devices-pending/) — one empty-ish file per newly-discovered, not-yet-approved tailnet node. Written by the daemon probe, read by the menu-bar helper (mirrors the attention sentinel dir). */
export function getDevicesPendingDir(): string { return path.join(getRuntimeStateDir(), 'devices-pending'); }

/** Path to cloud dispatch cache (~/.agents/.cache/cloud/). */
export function getCloudDir(): string { return CLOUD_DIR; }

/** Path to terminal session metadata (~/.agents/.cache/terminals/). */
export function getTerminalsDir(): string { return TERMINALS_DIR; }

/** Path to runtime logs (~/.agents/.cache/logs/), read at CALL time. AGENTS_LOGS_DIR
 * redirects it in tests; never set in production code. */
export function getLogsDir(): string {
  return process.env.AGENTS_LOGS_DIR ?? LOGS_DIR;
}

/** Disposable performance samples (~/.agents/.cache/perf/): `perf.db` plus a hook-shim spool.
 * Read at CALL time; AGENTS_PERF_DIR redirects it so direct callers do not leak samples
 * into the real perf warehouse. */
export function getPerfDir(): string {
  return process.env.AGENTS_PERF_DIR ?? PERF_DIR;
}

/** Path to the perf SQLite warehouse (~/.agents/.cache/perf/perf.db). */
export function getPerfDbPath(): string { return path.join(getPerfDir(), 'perf.db'); }

/** Path to the hook-shim NDJSON spool drained into perf.db on open. */
export function getPerfSpoolPath(): string { return path.join(getPerfDir(), 'spool.jsonl'); }

/** Per-process runtime state dir (~/.agents/.cache/state/), resolved at call time.
 * AGENTS_STATE_DIR redirects it in tests; without it the suite wrote NEW DEVICES sentinels
 * into the real `devices-pending/` via `reconcilePendingSentinels`. */
export function getRuntimeStateDir(): string { return process.env.AGENTS_STATE_DIR ?? RUNTIME_STATE_DIR; }

/** Path to companion-extension scratch (~/.agents/.cache/companion/). */
export function getCompanionDir(): string { return COMPANION_CACHE_DIR; }

/** Path to browser runtime data — chrome-data, pids (~/.agents/.cache/browser/). */
export function getBrowserRuntimeDir(): string { return BROWSER_RUNTIME_DIR; }

/** DURABLE browser-profile data (~/.agents/.history/browser-profiles/), the `--user-data-dir`
 * for attach-only profiles (PHNX-3967). Under `.history`, not `.cache`, so `profiles remove`
 * and cache wipes keep sign-ins; the local driver's ownership guard compares against it. */
export function getBrowserDurableDir(): string { return path.join(HISTORY_DIR, 'browser-profiles'); }

/** Path to helper subprocess scratch (~/.agents/.cache/helpers/). */
export function getHelpersDir(): string { return HELPERS_DIR; }

/** Scheduler daemon scratch (~/.agents/.cache/helpers/daemon/): pid, heartbeat, start lock, log.
 * AGENTS_DAEMON_DIR redirects it so daemon tests never clobber a live daemon; read at CALL
 * time. Never set in production code. */
export function getDaemonDir(): string { return process.env.AGENTS_DAEMON_DIR ?? DAEMON_DIR; }

/** Path to tmux scratch (~/.agents/.cache/helpers/tmux/) — shared server socket + per-session meta JSONs. */
export function getTmuxDir(): string { return TMUX_DIR; }

/** Path to remote-resource auto-pull cache (~/.agents/.cache/.fetch/). */
export function getFetchCacheDir(): string { return FETCH_CACHE_DIR; }

/** Path to the CLI version cache file (~/.agents/.cache/.cli-version-cache.json). */
export function getCliVersionCachePath(): string { return CLI_VERSION_CACHE_FILE; }

/** Path to the models cache file (~/.agents/.cache/.models-cache.json). */
export function getModelsCachePath(): string { return MODELS_CACHE_FILE; }

/** Path to the daily update-check sentinel (~/.agents/.cache/.update-check). */
export function getUpdateCheckPath(): string { return UPDATE_CHECK_FILE; }

/** Path to the migration sentinel (~/.agents/.cache/.migrated). */
export function getMigratedSentinelPath(): string { return MIGRATED_SENTINEL_FILE; }

/** Path to soft-deleted version dirs (~/.agents/trash/versions/). */
export function getTrashVersionsDir(): string { return path.join(TRASH_DIR, 'versions'); }

/** Path to soft-deleted skills (~/.agents/trash/skills/). */
export function getTrashSkillsDir(): string { return path.join(TRASH_DIR, 'skills'); }

/** Path to soft-deleted commands (~/.agents/trash/commands/). */
export function getTrashCommandsDir(): string { return path.join(TRASH_DIR, 'commands'); }

/** Path to soft-deleted hooks (~/.agents/trash/hooks/). */
export function getTrashHooksDir(): string { return path.join(TRASH_DIR, 'hooks'); }

/** Path to soft-deleted plugins (~/.agents/trash/plugins/). */
export function getTrashPluginsDir(): string { return path.join(TRASH_DIR, 'plugins'); }

/** Path to soft-deleted subagents (~/.agents/trash/subagents/). */
export function getTrashSubagentsDir(): string { return path.join(TRASH_DIR, 'subagents'); }
export function getTrashWorkflowsDir(): string { return path.join(TRASH_DIR, 'workflows'); }

/** Path to a user-level extra DotAgent repo clone (~/.agents-<alias>/), a peer dir of
 * ~/.agents/. `agents repo add` clones here by default. */
export function getExtraRepoDir(alias: string): string {
  return path.join(HOME, `.agents-${alias}`);
}

/** Resolve the on-disk path for an extra repo, whether managed or user-owned. */
export function resolveExtraRepoDir(alias: string, config?: { path?: string }): string {
  if (config?.path) {
    return path.resolve(config.path);
  }
  return getExtraRepoDir(alias);
}

/**
 * Return enabled extra repos that exist on disk, in insertion order.
 */
export function getEnabledExtraRepos(): Array<{ alias: string; dir: string; url: string }> {
  const meta = readMeta();
  const extras = meta.extraRepos || {};
  const out: Array<{ alias: string; dir: string; url: string }> = [];
  for (const [alias, config] of Object.entries(extras)) {
    if (!config.enabled) continue;
    const dir = resolveExtraRepoDir(alias, config);
    if (!fs.existsSync(dir)) continue;
    out.push({ alias, dir, url: config.url });
  }
  return out;
}

// ─── Directory setup ───────────────────────────────────────────────────────────

/** Create both the system and user directory trees if any subdirectories are missing. */
export function ensureAgentsDir(): void {
  const opts = { recursive: true, mode: 0o700 } as const;

  // User repo — minimal scaffold (sub-dirs created on first write)
  if (!fs.existsSync(USER_AGENTS_DIR)) {
    fs.mkdirSync(USER_AGENTS_DIR, opts);
  }
  try { fs.chmodSync(USER_AGENTS_DIR, 0o700); } catch {}

  // System repo plus user-level operational state
  if (!fs.existsSync(SYSTEM_AGENTS_DIR)) {
    fs.mkdirSync(SYSTEM_AGENTS_DIR, opts);
  }
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, opts);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, opts);
  if (!fs.existsSync(PACKAGES_DIR)) fs.mkdirSync(PACKAGES_DIR, opts);
  if (!fs.existsSync(ROUTINES_DIR)) fs.mkdirSync(ROUTINES_DIR, opts);
  if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, opts);
  if (!fs.existsSync(VERSIONS_DIR)) fs.mkdirSync(VERSIONS_DIR, opts);
  if (!fs.existsSync(SHIMS_DIR)) fs.mkdirSync(SHIMS_DIR, opts);
  if (!fs.existsSync(SYSTEM_COMMANDS_DIR)) fs.mkdirSync(SYSTEM_COMMANDS_DIR, opts);
  if (!fs.existsSync(SYSTEM_HOOKS_DIR)) fs.mkdirSync(SYSTEM_HOOKS_DIR, opts);
  if (!fs.existsSync(SYSTEM_SKILLS_DIR)) fs.mkdirSync(SYSTEM_SKILLS_DIR, opts);
  if (!fs.existsSync(SYSTEM_RULES_DIR)) fs.mkdirSync(SYSTEM_RULES_DIR, opts);
  if (!fs.existsSync(SYSTEM_PERMISSIONS_DIR)) fs.mkdirSync(SYSTEM_PERMISSIONS_DIR, opts);
  if (!fs.existsSync(SYSTEM_SUBAGENTS_DIR)) fs.mkdirSync(SYSTEM_SUBAGENTS_DIR, opts);
  try { fs.chmodSync(SYSTEM_AGENTS_DIR, 0o700); } catch {}
}

// ─── Meta (agents.yaml) ────────────────────────────────────────────────────────

/** Return an empty Meta object used when no agents.yaml exists yet. */
export function createDefaultMeta(): Meta {
  return {};
}

let metaCache: { stamp: string; meta: Meta } | null = null;
let metaLockDepth = 0;

/** Return mtimeMs for a file path, or 0 if the file is absent or unreadable. */
function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Per-device version pins, `~/.agents/devices/<machine>/agents.yaml`. Committed and synced,
 * but each machine writes only its OWN folder, so pulls never conflict. */
export function getDeviceMetaPath(): string {
  return path.join(USER_AGENTS_DIR, 'devices', machineId(), 'agents.yaml');
}

/** Machine-local per-version resource tracking, `~/.agents/.history/version-resources.json`.
 * Gitignored, regenerable, never synced. */
export function getVersionResourcesPath(): string {
  return path.join(HISTORY_DIR, 'version-resources.json');
}

/** Combined cache stamp across central + system agents.yaml, this machine's device pins and
 * version-resources. A delimited string, not a numeric sum: summing epoch-ms values loses
 * float64 precision, so a change in any one file must contribute at full resolution. */
function currentMetaStamp(): string {
  return safeMtimeMs(META_FILE)
    + '|' + safeMtimeMs(SYSTEM_META_FILE)
    + '|' + safeMtimeMs(getDeviceMetaPath())
    + '|' + safeMtimeMs(getDevicePinsPath())
    + '|' + safeMtimeMs(getVersionResourcesPath());
}

/** Memoize a parsed Meta against the current file mtimes. */
function rememberMeta(meta: Meta): Meta {
  metaCache = { stamp: currentMetaStamp(), meta };
  return meta;
}

export function withMetaLock<T>(fn: () => T): T {
  ensureAgentsDir();
  if (metaLockDepth > 0) {
    metaLockDepth++;
    try {
      return fn();
    } finally {
      metaLockDepth--;
    }
  }
  ensureLockTarget(META_FILE, META_HEADER + yaml.stringify(createDefaultMeta()), 0o700);
  return withFileLock(META_FILE, () => {
    metaLockDepth = 1;
    try {
      return fn();
    } finally {
      metaLockDepth = 0;
    }
  });
}

/** Atomic write only when the content differs, avoiding mtime bumps that thrash the meta
 * cache. Returns whether it wrote, so callers can react only to a real change. */
function writeIfChanged(filePath: string, content: string): boolean {
  let current: string | null = null;
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch { /* absent */ }
  if (current === content) return false;
  atomicWriteFileSync(filePath, content);
  return true;
}

/** Commit the central `agents.yaml` synchronously, after the meta lock releases, so a dirty file
 * never makes a peer publish trip `dirtyTreeRefusal` and wedge `agents repo pull` (PHNX-3968). The
 * daemon commits too (PHNX-4116). Failure fails open: a config command never fails on git. */
export function commitCentralConfig(userDir: string): boolean {
  const rel = 'agents.yaml';
  try {
    execFileSync('git', ['-C', userDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return false; // plain ~/.agents with no git repo — leave it a loose write.
  }
  try {
    execFileSync('git', ['-C', userDir, 'add', '--', rel], { stdio: 'ignore' });
    // Nothing staged for agents.yaml (its bytes matched HEAD after all) → no
    // empty commit. `diff --cached --quiet` exits 0 when the index equals HEAD
    // for this path, 1 when it differs.
    try {
      execFileSync('git', ['-C', userDir, 'diff', '--cached', '--quiet', '--', rel], { stdio: 'ignore' });
      return false;
    } catch { /* exit 1 → staged changes present, commit them */ }
    // Pathspec-scoped commit: records ONLY agents.yaml even if other paths are
    // staged, so a config write never sweeps unrelated staged work into its commit.
    execFileSync(
      'git',
      ['-C', userDir, '-c', 'commit.gpgsign=false', 'commit', '--no-verify',
        '-m', 'chore(config): update agents.yaml', '--', rel],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false; // fail open — see the doc comment.
  }
}

/** Partition the in-memory Meta across files by sync-domain: central `agents.yaml`; tracked
 * device doc (`routines:`, `config:`, `browser:`, `projectRoot`); untracked pins JSON;
 * machine-local version-resources JSON. Empty `agents:`/`versions:` are not written. */
/** Fleet-shared (`central`) Meta keys: the OPT-IN allowlist written to the synced agents.yaml.
 * Every unlisted key defaults to device scope ({@link metaKeyScope}), so a new key cannot
 * silently churn the shared file; sharing is a deliberate edit here (PHNX-3315). */
const CENTRAL_META_KEYS = [
  'accounts',
  'run',
  'model',
  'watchdog',
  'lease',
  'secrets',
  'budget',
  'feed',
  'beta',
  'registries',
  'profiles',
  'source',
  'extraRepos',
  'brands',
  'actors',
  'seededPresets',
  'hooks',
  'config',
  'hosts',
  'fleet',
  'share',
  'notify',
] as const satisfies readonly (keyof Meta)[];

/** Device-scoped Meta keys with BESPOKE routing (pins JSON, version-resources JSON, or a
 * remapped device-doc sub-block), handled by hand in {@link writeMetaUnlocked} and
 * {@link overlayMachineLocal}. Unlisted device keys round-trip generically under their own name. */
const BESPOKE_DEVICE_KEYS = [
  'agents',
  'isolatedAgents',
  'versions',
  'deviceRoutines',
  'deviceConfig',
  'deviceBrowser',
  'deviceFleet',
  'deviceHosts',
  'deviceAccounts',
  'projectRoot',
] as const satisfies readonly (keyof Meta)[];

const CENTRAL_KEY_SET: ReadonlySet<string> = new Set(CENTRAL_META_KEYS);

/** Compile-time exhaustiveness: every Meta key must be filed as central or bespoke-device.
 * A nudge, not a safety check: {@link metaKeyScope} still defaults an unfiled key to
 * `'device'`, so it never leaks to the synced file. */
type ClassifiedMetaKey = (typeof CENTRAL_META_KEYS)[number] | (typeof BESPOKE_DEVICE_KEYS)[number];
const _metaKeysAreExhaustive: keyof Meta extends ClassifiedMetaKey ? true : never = true;
void _metaKeysAreExhaustive;

/** Sync-domain of a Meta key: `'central'` only for the opt-in allowlist, `'device'` for
 * everything else. This drives the generic device-doc router, and an unclassified key
 * lands in the safe per-box file. */
function metaKeyScope(key: string): 'central' | 'device' {
  return CENTRAL_KEY_SET.has(key) ? 'central' : 'device';
}

/** Bespoke device keys as a runtime Set (the generic router skips these). */
const BESPOKE_DEVICE_KEY_SET: ReadonlySet<string> = new Set<string>([
  ...BESPOKE_DEVICE_KEYS,
  // The `browser` tombstone is device-scoped but bespoke: lib/browser/registry.ts
  // drains it (collision-checked) into deviceBrowser, so the generic router must
  // never blindly relocate it.
  'browser',
]);

/** Device-doc sub-block names the read/write paths handle BESPOKE-ly. The generic device-doc
 * overlay skips them so it only surfaces genuine generic keys. */
const BESPOKE_DEVICE_DOC_KEYS: ReadonlySet<string> = new Set<string>([
  'agents',
  'isolatedAgents',
  'routines',
  'config',
  'browser',
  'fleet',
  'hosts',
  'accounts',
  'projectRoot',
  // Legacy top-level doc key the config migration folds into `config:`; never
  // surfaced onto Meta before, so keep the generic overlay from doing so.
  'defaultBrowserProfile',
]);

/** Every key this version models. serializeCentral deletes an on-disk key only when it is
 * KNOWN and absent from the write: a cleared central key, or legacy device cruft in the
 * synced file. Unknown keys from a newer CLI are preserved verbatim. */
const KNOWN_META_KEYS: ReadonlySet<string> = new Set<string>([
  ...CENTRAL_META_KEYS,
  ...BESPOKE_DEVICE_KEYS,
  // Removed browser-profile store. Kept only as a serializer tombstone so the
  // first registry read can migrate it into this device's file and delete it.
  'browser',
]);

/** Rewrite a frozen `agents.yaml` header to the current {@link META_HEADER} (PHNX-3315).
 * Healed textually on the serialized string, since `yaml` may fold the header onto the first
 * key's comment. Strips a stale header and prepends the canonical one; body comments stay. */
function healMetaHeader(serialized: string): string {
  const headerBlock =
    /^# agents-cli metadata\n# Auto-generated - do not edit manually\n(?:# (?:https:\/\/github\.com\/phnx-labs\/[^\n]*|yaml-language-server: \$schema=[^\n]*)\n)*\n?/;
  const stripped = serialized.replace(headerBlock, '');
  // No header present: leave the file exactly as is. We heal a STALE header, never prepend one
  // to a headerless hand-authored file on its first central change.
  return stripped === serialized ? serialized : META_HEADER + stripped;
}

/** True when the top-level agents.yaml carries a header that is not the canonical
 * {@link META_HEADER}. Absent or headerless files are not stale. Surfaced as config drift
 * by `agents sync status` (PHNX-3315). */
export function hasStaleMetaHeader(): boolean {
  let content: string;
  try { content = fs.readFileSync(META_FILE, 'utf-8'); } catch { return false; }
  return healMetaHeader(content) !== content;
}

/** Raw on-disk top-level user `agents.yaml` (no system merge, overlay or cache), or null if
 * absent or unparseable. Used by config-drift detection so system defaults are not
 * mis-attributed as this box's own leak (PHNX-3315). */
export function readTopLevelUserMeta(): Record<string, unknown> | null {
  let content: string;
  try { content = fs.readFileSync(META_FILE, 'utf-8'); } catch { return null; }
  try {
    const parsed = yaml.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* malformed — nothing to report */ }
  return null;
}

/** Top-level keys on disk in the central `agents.yaml` ({} if absent or unparseable).
 * The device-doc router uses it to leave a FOREIGN key from a newer CLI in place. */
function readCentralKeys(): ReadonlySet<string> {
  return new Set(Object.keys(readTopLevelUserMeta() ?? {}));
}

/** Serialize central meta to `agents.yaml` WITHOUT destroying hand-written comments.
 * Plain `yaml.stringify` drops them, so the byte compare rewrites on every write and wedges
 * `agents sync`. We edit a parsed Document in place; with no central change, bytes are unchanged. */
function serializeCentral(central: Record<string, unknown>): string {
  const isEmpty = Object.keys(central).length === 0;
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(META_FILE, 'utf-8');
  } catch {
    /* first write — no file yet */
  }
  if (existing == null) {
    // Empty central: write the header only. `yaml.stringify({})` emits a flow `{}` that would make
    // a later `doc.set()` flow-ify the whole file.
    return isEmpty ? META_HEADER : META_HEADER + yaml.stringify(central);
  }
  const doc = yaml.parseDocument(existing);
  const current: Record<string, unknown> = (doc.toJSON() as Record<string, unknown>) ?? {};
  let changed = false;
  for (const [k, v] of Object.entries(central)) {
    if (JSON.stringify(current[k]) !== JSON.stringify(v)) {
      doc.set(k, v);
      changed = true;
    }
  }
  for (const k of Object.keys(current)) {
    // Delete only keys THIS version knows. An unknown key (from a newer CLI) is preserved, since
    // deleting it would sync the loss fleet-wide. A known device key lingering here is removed.
    if (!(k in central) && KNOWN_META_KEYS.has(k)) {
      // RUSH-2837: a partial writeMeta missing `share` deleted the share endpoint and synced that
      // fleet-wide. `share` is restored only by setup/join, so never drop it on omission.
      // Explicit `share: null` still goes through doc.set above.
      if (k === 'share') continue;
      doc.delete(k);
      changed = true;
    }
  }
  // No central field changed: keep the file byte-identical so writeIfChanged skips it.
  // A device-only write must not rewrite the shared file, nor heal the header; that churn wedges
  // `agents sync` and blocks fleet pulls.
  if (!changed) return existing;
  // Everything cleared → header only (never leave a flow `{}` behind). Byte-stable
  // when the file is already exactly the current header.
  if (isEmpty) return existing === META_HEADER ? existing : META_HEADER;
  // A central key changed: serialize the edited doc and heal a frozen header. stringifyDoc
  // normalizes a legacy flow root `{}` to block but does not force block elsewhere, which
  // disagreed with feed.ts/activity.ts/migrate.ts (RUSH-2505). Headerless files gain no header.
  return healMetaHeader(stringifyDoc(doc));
}

/** Write `meta` (central, device docs, pins) WITHOUT taking the meta lock; the caller must hold
 * {@link withMetaLock}, so it can read, decide and commit under ONE lock. Returns whether the
 * central bytes changed; it never commits (call {@link commitCentralConfig} after unlock). */
export function writeMetaUnlocked(meta: Meta): boolean {
  const writesDeviceRoutines = Object.prototype.hasOwnProperty.call(meta, 'deviceRoutines');
  const writesDeviceConfig = Object.prototype.hasOwnProperty.call(meta, 'deviceConfig');
  const writesDeviceBrowser = Object.prototype.hasOwnProperty.call(meta, 'deviceBrowser');
  const writesDeviceFleet = Object.prototype.hasOwnProperty.call(meta, 'deviceFleet');
  const writesDeviceHosts = Object.prototype.hasOwnProperty.call(meta, 'deviceHosts');
  const writesDeviceAccounts = Object.prototype.hasOwnProperty.call(meta, 'deviceAccounts');
  const writesProjectRoot = Object.prototype.hasOwnProperty.call(meta, 'projectRoot');
  // INVARIANT: every key destructured here must be in BESPOKE_DEVICE_KEYS and vice versa.
  // Otherwise it falls into `central`, the generic router skips it, and it silently syncs to
  // the shared file. Keep the lists in lockstep.
  const { agents, isolatedAgents, versions, deviceRoutines, deviceConfig, deviceBrowser, deviceFleet, deviceHosts, deviceAccounts, projectRoot, ...central } = meta;

  // Write the machine-local files FIRST, then strip central — so a crash mid-write
  // never removes pins/versions from central before they're persisted elsewhere.
  const hasAgents = !!agents && Object.keys(agents).length > 0;
  // The isolated pointer names a version installed on THIS machine, like a global pin, so it
  // belongs in the pins file, not the synced central doc where other machines would inherit it.
  const hasIsolatedAgents = !!isolatedAgents && Object.keys(isolatedAgents).length > 0;
  // Pins (`agents:` and `isolatedAgents:`) are machine-local runtime state: they live in the
  // untracked .history pins JSON, never the tracked device doc, where they churned commits
  // on every `agents use` / install.
  const pinsPath = getDevicePinsPath();
  if (hasAgents || hasIsolatedAgents) {
    const pins: { agents?: Meta['agents']; isolatedAgents?: Meta['isolatedAgents'] } = {};
    if (hasAgents) pins.agents = agents;
    if (hasIsolatedAgents) pins.isolatedAgents = isolatedAgents;
    fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
    writeIfChanged(pinsPath, JSON.stringify(pins, null, 2) + '\n');
  } else if (fs.existsSync(pinsPath)) {
    // Every pin was cleared. Persist the emptied file instead of skipping the
    // write — otherwise the stale pins file survives and overlayMachineLocal
    // re-applies the removed pin on the next read.
    writeIfChanged(pinsPath, '{}\n');
  }

  // The tracked device doc carries operator-owned fields: `routines:`, `config:` (from
  // lib/device-config.ts), machine-local browser defaults and projectRoot. Merge over the existing
  // doc so an outside `config:` block is never clobbered; stray pins are stripped.
  const devicePath = getDeviceMetaPath();
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(devicePath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(devicePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch { /* preserve the existing tolerance for malformed legacy device YAML */ }
  }
  delete doc.agents;
  delete doc.isolatedAgents;
  if (Array.isArray(deviceRoutines)) doc.routines = deviceRoutines;
  else if (writesDeviceRoutines) delete doc.routines;
  const hasDeviceConfig = !!deviceConfig && Object.keys(deviceConfig).length > 0;
  if (hasDeviceConfig) doc.config = deviceConfig;
  else if (writesDeviceConfig) delete doc.config;
  const hasDeviceBrowser = !!deviceBrowser && Object.keys(deviceBrowser).length > 0;
  if (hasDeviceBrowser) doc.browser = deviceBrowser;
  else if (writesDeviceBrowser) delete doc.browser;
  // PHNX-3315 device-scoped fleet/hosts/accounts blocks: this box's OWN slice, unioned across
  // device docs at read time (lib/devices/device-docs.ts). Empty slices are dropped so no
  // committed empty maps are left behind.
  const fleetDiscovery = deviceFleet?.discovery && Object.keys(deviceFleet.discovery).length > 0
    ? deviceFleet.discovery : undefined;
  const fleetIgnored = deviceFleet?.ignored && deviceFleet.ignored.length > 0
    ? deviceFleet.ignored : undefined;
  if (fleetDiscovery || fleetIgnored) {
    const df: Record<string, unknown> = {};
    if (fleetDiscovery) df.discovery = fleetDiscovery;
    if (fleetIgnored) df.ignored = fleetIgnored;
    doc.fleet = df;
  } else if (writesDeviceFleet) delete doc.fleet;
  const hasDeviceHosts = !!deviceHosts && Object.keys(deviceHosts).length > 0;
  if (hasDeviceHosts) doc.hosts = deviceHosts;
  else if (writesDeviceHosts) delete doc.hosts;
  const accountsNative = deviceAccounts?.native && Object.keys(deviceAccounts.native).length > 0
    ? deviceAccounts.native : undefined;
  const accountsBindings = deviceAccounts?.bindings && Object.keys(deviceAccounts.bindings).length > 0
    ? deviceAccounts.bindings : undefined;
  // This box's account⇄home map (PHNX-3940) is device-scoped, so it round-trips
  // through the device doc alongside native/bindings, never the synced central file.
  const accountsHomes = deviceAccounts?.homes && Object.keys(deviceAccounts.homes).length > 0
    ? deviceAccounts.homes : undefined;
  // In-flight connect attempts (PHNX-3940), device-scoped like homes.
  const accountsPending = deviceAccounts?.pendingConnects && Object.keys(deviceAccounts.pendingConnects).length > 0
    ? deviceAccounts.pendingConnects : undefined;
  const accountsSlots = deviceAccounts?.slots && Object.keys(deviceAccounts.slots).length > 0
    ? deviceAccounts.slots : undefined;
  if (accountsNative || accountsBindings || accountsHomes || accountsPending || accountsSlots) {
    const da: Record<string, unknown> = {};
    if (accountsNative) da.native = accountsNative;
    if (accountsBindings) da.bindings = accountsBindings;
    if (accountsHomes) da.homes = accountsHomes;
    if (accountsPending) da.pendingConnects = accountsPending;
    if (accountsSlots) da.slots = accountsSlots;
    doc.accounts = da;
  } else if (writesDeviceAccounts) delete doc.accounts;
  const hasProjectRoot = typeof projectRoot === 'string' && projectRoot.length > 0;
  if (hasProjectRoot) doc.projectRoot = projectRoot;
  else if (writesProjectRoot) delete doc.projectRoot;

  // Generic device-scoped keys (PHNX-3315): a device-classified key without bespoke routing
  // round-trips through this box's device doc under its own name, never reaching central.
  // A key unknown to this version but already in central is a FOREIGN key from a newer CLI: kept.
  const centralRecord = central as Record<string, unknown>;
  const onDiskCentralKeys = readCentralKeys();
  for (const k of Object.keys(centralRecord)) {
    if (metaKeyScope(k) !== 'device') continue;            // fleet-shared: stays central
    if (BESPOKE_DEVICE_KEY_SET.has(k)) continue;           // bespoke (incl. browser tombstone)
    if (!KNOWN_META_KEYS.has(k) && onDiskCentralKeys.has(k)) continue; // foreign — preserve
    doc[k] = centralRecord[k];
    delete centralRecord[k];
  }

  if (Object.keys(doc).length > 0) {
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    writeIfChanged(devicePath, META_HEADER + yaml.stringify(doc));
  } else if (fs.existsSync(devicePath)) {
    // Nothing operator-owned remains — remove the doc rather than leaving an
    // empty tracked file behind.
    fs.rmSync(devicePath, { force: true });
    try {
      fs.rmdirSync(path.dirname(devicePath));
    } catch { /* not empty — other files live in the device dir */ }
  }

  if (versions && Object.keys(versions).length > 0) {
    const vrPath = getVersionResourcesPath();
    fs.mkdirSync(path.dirname(vrPath), { recursive: true });
    writeIfChanged(vrPath, JSON.stringify(versions, null, 2) + '\n');
  }

  const centralChanged = writeIfChanged(META_FILE, serializeCentral(central));
  metaCache = null;
  return centralChanged;
}

/** Overlay this machine's local state onto a central-portable Meta: `agents:`/`isolatedAgents:`
 * from the pins file (device wins), `routines:`/`browser:`/`projectRoot` from the device doc,
 * `versions:` from the history JSON (wholesale; central's copy if the file is absent). */
function overlayMachineLocal(meta: Meta): Meta {
  const pinsPath = getDevicePinsPath();
  if (fs.existsSync(pinsPath)) {
    try {
      const pins = JSON.parse(fs.readFileSync(pinsPath, 'utf-8')) as {
        agents?: Meta['agents'];
        isolatedAgents?: Meta['isolatedAgents'];
      };
      if (pins?.agents) meta.agents = { ...meta.agents, ...pins.agents };
      if (pins?.isolatedAgents) meta.isolatedAgents = { ...meta.isolatedAgents, ...pins.isolatedAgents };
    } catch { /* ignore malformed pins file */ }
  }
  const devicePath = getDeviceMetaPath();
  if (fs.existsSync(devicePath)) {
    let dm: (Meta & { routines?: unknown; browser?: unknown }) | null = null;
    try {
      dm = yaml.parse(fs.readFileSync(devicePath, 'utf-8')) as Meta & {
        routines?: unknown;
        browser?: unknown;
      };
    } catch { /* preserve the existing tolerance for malformed legacy device YAML */ }
    if (dm) {
      // Pre-migration pins may still live in the tracked doc — honor them until
      // migrateDeviceConfigStores strips them. Pins-file values already applied
      // above win on key conflict.
      if (dm?.agents) meta.agents = { ...dm.agents, ...meta.agents };
      if (dm?.isolatedAgents) meta.isolatedAgents = { ...dm.isolatedAgents, ...meta.isolatedAgents };
      if (typeof dm?.projectRoot === 'string') meta.projectRoot = dm.projectRoot;
      if (dm?.browser && typeof dm.browser === 'object' && !Array.isArray(dm.browser)) {
        meta.deviceBrowser = { ...meta.deviceBrowser, ...(dm.browser as Record<string, never>) };
      }
      if (dm?.config && typeof dm.config === 'object' && !Array.isArray(dm.config)) {
        meta.deviceConfig = { ...meta.deviceConfig, ...(dm.config as Record<string, unknown>) };
      }
      // PHNX-3315: this box's own device-scoped fleet/hosts/accounts slices; the cross-box union
      // is computed in lib/devices/device-docs.ts. A malformed block is a HARD error: a silent
      // drop would let the next write overwrite the whole block with only the new entry.
      const isMap = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === 'object' && !Array.isArray(v);
      const dmRaw = dm as { fleet?: unknown; hosts?: unknown; accounts?: unknown };
      if (dmRaw.fleet !== undefined) {
        if (!isMap(dmRaw.fleet)) throw new Error(`Device config corrupted at ${devicePath}: fleet must be a map.`);
        const df = dmRaw.fleet as { discovery?: unknown; ignored?: unknown };
        if (df.discovery !== undefined && !isMap(df.discovery)) {
          throw new Error(`Device config corrupted at ${devicePath}: fleet.discovery must be a map.`);
        }
        if (df.ignored !== undefined && !Array.isArray(df.ignored)) {
          throw new Error(`Device config corrupted at ${devicePath}: fleet.ignored must be a list.`);
        }
        const discovery = df.discovery as Record<string, 'approved' | 'ignored'> | undefined;
        const ignored = df.ignored as NonNullable<Meta['deviceFleet']>['ignored'] | undefined;
        if (discovery || ignored) meta.deviceFleet = { ...(discovery ? { discovery } : {}), ...(ignored ? { ignored } : {}) };
      }
      if (dmRaw.hosts !== undefined) {
        if (!isMap(dmRaw.hosts)) throw new Error(`Device config corrupted at ${devicePath}: hosts must be a map.`);
        meta.deviceHosts = { ...meta.deviceHosts, ...(dmRaw.hosts as Meta['hosts']) };
      }
      if (dmRaw.accounts !== undefined) {
        if (!isMap(dmRaw.accounts)) throw new Error(`Device config corrupted at ${devicePath}: accounts must be a map.`);
        const acc = dmRaw.accounts as { native?: unknown; bindings?: unknown; homes?: unknown; pendingConnects?: unknown; slots?: unknown };
        if (acc.native !== undefined && !isMap(acc.native)) {
          throw new Error(`Device config corrupted at ${devicePath}: accounts.native must be a map.`);
        }
        if (acc.bindings !== undefined && !isMap(acc.bindings)) {
          throw new Error(`Device config corrupted at ${devicePath}: accounts.bindings must be a map.`);
        }
        if (acc.homes !== undefined && !isMap(acc.homes)) {
          throw new Error(`Device config corrupted at ${devicePath}: accounts.homes must be a map.`);
        }
        if (acc.pendingConnects !== undefined && !isMap(acc.pendingConnects)) {
          throw new Error(`Device config corrupted at ${devicePath}: accounts.pendingConnects must be a map.`);
        }
        if (acc.slots !== undefined && !isMap(acc.slots)) {
          throw new Error(`Device config corrupted at ${devicePath}: accounts.slots must be a map.`);
        }
        const native = acc.native as NonNullable<Meta['deviceAccounts']>['native'] | undefined;
        const bindings = acc.bindings as NonNullable<Meta['deviceAccounts']>['bindings'] | undefined;
        const homes = acc.homes as NonNullable<Meta['deviceAccounts']>['homes'] | undefined;
        const pendingConnects = acc.pendingConnects as NonNullable<Meta['deviceAccounts']>['pendingConnects'] | undefined;
        const slots = acc.slots as NonNullable<Meta['deviceAccounts']>['slots'] | undefined;
        if (native || bindings || homes || pendingConnects || slots) meta.deviceAccounts = { ...(native ? { native } : {}), ...(bindings ? { bindings } : {}), ...(homes ? { homes } : {}), ...(pendingConnects ? { pendingConnects } : {}), ...(slots ? { slots } : {}) };
      }
      if (Object.prototype.hasOwnProperty.call(dm, 'routines')) {
        if (!Array.isArray(dm.routines) || dm.routines.some((name) => typeof name !== 'string')) {
          throw new Error(`Device config corrupted at ${devicePath}: routines must be a string list.`);
        }
        meta.deviceRoutines = dm.routines;
      }
      // Generic device-scoped keys (PHNX-3315): device-doc keys not bespoke-handled map back onto
      // Meta under their own name, symmetric with the generic write in writeMetaUnlocked.
      for (const [k, v] of Object.entries(dm as Record<string, unknown>)) {
        if (BESPOKE_DEVICE_DOC_KEYS.has(k)) continue;
        (meta as Record<string, unknown>)[k] = v;
      }
    }
  }
  const vrPath = getVersionResourcesPath();
  if (fs.existsSync(vrPath)) {
    try {
      const vr = JSON.parse(fs.readFileSync(vrPath, 'utf-8')) as Meta['versions'];
      if (vr) meta.versions = vr;
    } catch { /* ignore malformed history file */ }
  }
  return meta;
}

/** One-shot migration: move agents.yaml from the system repo to the user repo.
 * Idempotent; no-ops if the user file exists or the system file is absent. */
function migrateSystemMetaToUser(): void {
  if (fs.existsSync(META_FILE)) return;
  if (!fs.existsSync(SYSTEM_META_FILE)) return;
  try {
    if (!fs.existsSync(USER_AGENTS_DIR)) {
      fs.mkdirSync(USER_AGENTS_DIR, { recursive: true, mode: 0o700 });
    }
    fs.renameSync(SYSTEM_META_FILE, META_FILE);
    console.log('Migrated agents.yaml to ~/.agents/');
  } catch {
    // Best-effort; proceed with fresh state if it fails.
  }
}

/** Read and cache ~/.agents/agents.yaml, migrating legacy locations if needed. The cache is
 * keyed on the mtimes of the user and system files (merged meta). `writeMetaUnlocked` clears
 * it; a change by ANOTHER process is caught by the mtime check on the next read. */
export function readMeta(options: { migrate?: boolean } = {}): Meta {
  const migrate = options.migrate !== false;
  if (migrate) ensureAgentsDir();
  // A preview must not suppress a later real migration by populating its cache.
  const remember = (meta: Meta): Meta => migrate ? rememberMeta(meta) : meta;

  // Fast path: serve from cache when both source files are byte-identical to
  // what we last parsed. Reduces N readMeta calls per CLI invocation to ~2 stat
  // syscalls plus an in-memory object spread.
  if (migrate && metaCache) {
    if (currentMetaStamp() === metaCache.stamp) {
      return metaCache.meta;
    }
  }

  // agents.yaml migration from ~/.agents-system/ is handled only by runMigration() in
  // migrate.ts (postinstall and a bootstrap step). Calling it here would mutate real
  // filesystem state in tests that import this module.

  // Legacy migration: check for old meta.yaml in system dir
  const oldMetaFile = path.join(SYSTEM_AGENTS_DIR, 'meta.yaml');
  if (fs.existsSync(oldMetaFile) && !fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(oldMetaFile, 'utf-8');
      const parsed = yaml.parse(content) as any;
      const meta: Meta = {};

      if (parsed.versions) {
        meta.agents = {};
        for (const [agent, state] of Object.entries(parsed.versions)) {
          const s = state as any;
          if (s?.default) {
            (meta.agents as Record<string, string>)[agent] = s.default;
          }
        }
      }

      if (parsed.registries) {
        meta.registries = parsed.registries;
      }

      // Lock-safe, commit-free write: withMetaLock is reentrant and writeMetaUnlocked never spawns
      // git. The public writeMeta would run a commit's git subprocess inside the non-heartbeated
      // lock. This legacy migration self-heals on the next daemon publish or central write.
      if (migrate) {
        withMetaLock(() => writeMetaUnlocked(meta));
        try { fs.unlinkSync(oldMetaFile); } catch { /* non-critical */ }
      }
      return remember(meta);
    } catch {
      /* meta.yaml migration failed */
    }
  }

  // Merge agents.yaml from both system and user repos. User repo wins on conflicts.
  let systemMeta: Meta | null = null;
  let userMeta: Meta | null = null;

  if (fs.existsSync(SYSTEM_META_FILE)) {
    try {
      const content = fs.readFileSync(SYSTEM_META_FILE, 'utf-8');
      systemMeta = yaml.parse(content) as Meta;
    } catch { /* ignore */ }
  }

  if (fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      userMeta = yaml.parse(content) as Meta;
    } catch { /* ignore */ }
  }

  if (systemMeta || userMeta) {
    // Merge: system as base, user overwrites
    const base = createDefaultMeta();
    const meta: Meta = {
      ...base,
      ...systemMeta,
      ...userMeta,
      agents: { ...systemMeta?.agents, ...userMeta?.agents },
    };
    // Merge registries carefully to preserve type
    if (systemMeta?.registries || userMeta?.registries) {
      meta.registries = {
        ...base.registries,
        ...systemMeta?.registries,
        ...userMeta?.registries,
      } as Meta['registries'];
    }

    overlayMachineLocal(meta);
    return remember(meta);
  }

  const meta = createDefaultMeta();
  overlayMachineLocal(meta);
  return remember(meta);
}

/** Serialize and write agents.yaml to the user repo, invalidating the in-memory cache. */
export function writeMeta(meta: Meta): void {
  const centralChanged = withMetaLock(() => writeMetaUnlocked(meta));
  commitCentralConfigAfterWrite(centralChanged);
}

/** Update agents.yaml under lock and return the new state. */
export function updateMeta(updates: Partial<Meta> | ((meta: Meta) => Meta)): Meta {
  let centralChanged = false;
  const newMeta = withMetaLock(() => {
    const meta = readMeta();
    const nm = typeof updates === 'function'
      ? updates(meta)
      : { ...meta, ...updates };
    centralChanged = writeMetaUnlocked(nm);
    return nm;
  });
  commitCentralConfigAfterWrite(centralChanged);
  return newMeta;
}

/** Commit-on-write, run AFTER {@link withMetaLock} releases so git subprocesses never run in
 * the non-heartbeated lock window. Commits the central agents.yaml only on a real byte change,
 * so it is not left dirty and does not wedge fleet pulls (PHNX-3968). */
export function commitCentralConfigAfterWrite(centralChanged: boolean): void {
  if (centralChanged) commitCentralConfig(USER_AGENTS_DIR);
}

/** Derive a filesystem-safe local clone path for a package source URL. */
export function getPackageLocalPath(source: string): string {
  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(PACKAGES_DIR, sanitized);
}

// ─── Version resource tracking ────────────────────────────────────────────────

import type { AgentId, ResourceType, VersionResources, ResourcePattern } from './types.js';

/** @deprecated No-op. Use ensureVersionResourcePatterns; kept for callers that still use it. */
export function recordVersionResources(
  _agent: AgentId,
  _version: string,
  _resourceType: ResourceType,
  _resources: string[]
): void {
  // intentional no-op — tracking moved to pattern-based ensureVersionResourcePatterns
}

/** Write default resource selection patterns for an agent@version. Writes each field only if
 * unset, preserving user customization. Pass all types in one call to batch the write. */
export function ensureVersionResourcePatterns(
  agent: AgentId,
  version: string,
  updates: Partial<Record<Exclude<keyof VersionResources, 'rulesPreset'>, ResourcePattern[]>>
): void {
  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};

  const vr = meta.versions[agent]![version];
  let changed = false;
  for (const [type, patterns] of Object.entries(updates) as [Exclude<keyof VersionResources, 'rulesPreset'>, ResourcePattern[]][]) {
    if (!vr[type] || (vr[type] as ResourcePattern[]).length === 0) {
      (vr as Record<string, unknown>)[type] = patterns;
      changed = true;
    }
  }
  if (changed) writeMeta(meta);
}

/** Resource types that resolve across the extra-repo layer, mirroring `defaultPatterns()`:
 * never permissions (`system:*`) or mcp (`user:*`). */
const EXTRA_ELIGIBLE_TYPES: readonly (keyof VersionResources)[] = [
  'commands', 'skills', 'hooks', 'subagents', 'plugins', 'workflows',
];

/** Insert `<alias>:*` after the system/user/other-extra includes and before `project:*`, unless
 * the alias is already included or excluded (`!alias:...`). Returns the same array on no-op. */
export function withAlias(list: ResourcePattern[], alias: string): ResourcePattern[] {
  const prefix = `${alias}:`;
  if (list.some(p => p === `${alias}:*` || p.startsWith(prefix) || p.startsWith(`!${prefix}`))) {
    return list;
  }
  const next = [...list];
  const projIdx = next.findIndex(p => p === 'project:*' || p.startsWith('project:'));
  if (projIdx >= 0) next.splice(projIdx, 0, `${alias}:*`);
  else next.push(`${alias}:*`);
  return next;
}

/** Strip every reference to `<alias>:...` / `!<alias>:...` from a selector list. */
export function withoutAlias(list: ResourcePattern[], alias: string): ResourcePattern[] {
  const prefix = `${alias}:`;
  const next = list.filter(p => !(p.startsWith(prefix) || p.startsWith(`!${prefix}`)));
  return next.length === list.length ? list : next;
}

/** Backfill (add=true) or strip (add=false) an extra-repo alias across installed versions'
 * selectors. Unset lists are left for `defaultPatterns()`. Returns the pairs changed. */
export function applyExtraAliasToVersions(alias: string, add: boolean): number {
  const meta = readMeta();
  if (!meta.versions) return 0;
  let changed = false;
  let count = 0;
  for (const versions of Object.values(meta.versions)) {
    if (!versions) continue;
    for (const vr of Object.values(versions)) {
      if (!vr) continue;
      let touched = false;
      for (const type of EXTRA_ELIGIBLE_TYPES) {
        const cur = (vr as Record<string, ResourcePattern[] | undefined>)[type];
        if (!Array.isArray(cur) || cur.length === 0) continue;
        const next = add ? withAlias(cur, alias) : withoutAlias(cur, alias);
        if (next !== cur) {
          (vr as Record<string, ResourcePattern[]>)[type] = next;
          touched = true;
          changed = true;
        }
      }
      if (touched) count++;
    }
  }
  if (changed) writeMeta(meta);
  return count;
}

export function getVersionResources(
  agent: AgentId,
  version: string
): VersionResources | null {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version] || null;
}

/** Active rules preset for an agent@version. Defaults to "default" when unset. */
export function getActiveRulesPreset(agent: AgentId, version: string): string {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version]?.rulesPreset || 'default';
}

/** Persist the active rules preset for an agent@version. */
export function setActiveRulesPreset(
  agent: AgentId,
  version: string,
  preset: string
): void {
  const meta = readMeta();
  if (!meta.versions) meta.versions = {};
  if (!meta.versions[agent]) meta.versions[agent] = {};
  if (!meta.versions[agent]![version]) meta.versions[agent]![version] = {};
  meta.versions[agent]![version].rulesPreset = preset;
  writeMeta(meta);
}
