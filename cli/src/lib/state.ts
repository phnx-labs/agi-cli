/**
 * Filesystem layout and persistent state for agents-cli.
 *
 * Single root at ~/.agents/ with three internal buckets:
 *
 *   ~/.agents/           — user repo: user-authored resources + agents.yaml
 *                          (git-tracked via `agents repo push`).
 *   ~/.agents/.system/   — system repo: npm-shipped resources, regenerable.
 *                          Don't hand-edit; maintained by npm install /
 *                          `agents repo pull system`.
 *   ~/.agents/.history/  — durable runtime data (sessions, versions, runs,
 *                          teams/agents, trash, backups). Backed up by
 *                          `agents repo push`.
 *   ~/.agents/.cache/    — regenerable runtime data (shims, packages, helpers
 *                          for daemon/pty, terminals, cloud, drive, browser
 *                          chrome-data, logs, companion). Gitignored.
 *
 * Resolution precedence for resources: project > user > system.
 * Every module that needs a path or reads/writes agents.yaml goes through here.
 *
 * Legacy layout (pre-fold): system repo lived at ~/.agents-system/ as a peer
 * of ~/.agents/. runMigration() folds it into ~/.agents/.system/ on first run
 * and leaves a back-compat symlink at the old path.
 */

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

/**
 * Compare two filesystem paths for identity, resolving symlinks and (on
 * Windows) 8.3 short-name vs long-name divergence via the OS realpath.
 * Falls back to a case-folded normalize when a path doesn't exist on disk.
 */
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

/**
 * Legacy system-repo location (pre-fold). Exported so the migrator can fold
 * it into SYSTEM_AGENTS_DIR. No runtime code outside the migrator should
 * reference this — use SYSTEM_AGENTS_DIR.
 */
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
// Built-in monitors shipped in the system repo (gh:phnx-labs/.agents-system).
// Unioned under user monitors by listMonitors()/readMonitor() so a monitor
// shipped here is available on every install, while a user monitor of the same
// name overrides it (a built-in with no `enabled:` field stays opt-in).
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
const PTY_DIR = path.join(HELPERS_DIR, 'pty');
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

/**
 * Header prepended to every agents.yaml the CLI writes (central and per-device
 * docs). Carries the yaml-language-server schema hint so editors validate the
 * file against `schema/agents-yaml.schema.json`. Exported so
 * `lib/devices/config-migration.ts` rewrites a device doc with the same header.
 */
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

/**
 * Backward-compat shim. Returns null when ~/.agents/ is a symlink to the
 * system dir; otherwise returns USER_AGENTS_DIR.
 *
 * @deprecated Use getUserAgentsDir() directly.
 */
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

/**
 * Origin `owner/repo` slug (lowercased, `.git` stripped) of a git checkout, or
 * null when `dir` isn't a git repo / has no origin. Extracts the slug from any
 * remote URL form: `git@host:owner/repo.git`, `https://host/owner/repo.git`,
 * `ssh://git@host/owner/repo`. Sync (mirrors readGitConfigUser in git.ts) so it
 * can be used from the synchronous getProjectAgentsDir walk.
 */
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

/**
 * True when `agentsPath` is itself a git checkout of the user's or system's
 * DotAgents repo — i.e. a *clone* of the very repo whose rules already load as
 * the user/system layer (e.g. `git clone …/.agents.git ~/src/github.com/<you>/.agents`).
 * Such a clone must NOT also be treated as a *project* layer: because project
 * outranks user, a stale clone would silently shadow the live user rules by
 * filename and plant a compiled AGENTS.md in an ancestor dir (RUSH-2037).
 *
 * A legitimate project layer is a plain subdirectory of a project and is never
 * itself a git-repo root, so the cheap `.git` gate skips the (git-spawning)
 * origin comparison for the common case — only a `.agents/` that is its own
 * checkout pays it, and even then it's kept unless its origin matches the
 * user/system DotAgents repo (an unrelated repo checked out at `.agents/`,
 * or a project's own versioned `.agents/`, stays a valid project layer).
 */
function isUserOrSystemRepoCheckout(agentsPath: string): boolean {
  if (!fs.existsSync(path.join(agentsPath, '.git'))) return false;
  const origin = gitOriginSlug(agentsPath);
  if (!origin) return false;
  return canonicalDotAgentsRepoSlugs().has(origin);
}

/**
 * True when `agentsPath` is a reserved `.agents` root that must never be
 * treated as a project layer: the user repo (~/.agents), the system repo
 * (~/.agents/.system), or a git checkout of either canonical DotAgents repo.
 * `getProjectAgentsDir` skips these while walking up; direct-cwd callers
 * (`compileRulesForProject`) consult the same predicate so `$HOME` — whose
 * `.agents/rules` is the user layer itself — can never compile as a
 * "project" (RUSH-2725).
 */
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

/**
 * Resolve the effective promptcuts file: user file if it exists, otherwise
 * the system file. Use this for callers that need a single path (doctor
 * diff, displaying which file is in play). Callers that need the merged
 * shortcut set should use readMergedPromptcuts() instead.
 */
export function getEffectivePromptcutsPath(): string {
  if (fs.existsSync(USER_PROMPTCUTS_FILE)) return USER_PROMPTCUTS_FILE;
  return SYSTEM_PROMPTCUTS_FILE;
}

/**
 * Read promptcuts from system + user with user precedence. Returns the
 * merged `shortcuts` map. Same layering model as parseHookManifest().
 * Returns an empty object when neither file exists or both fail to parse.
 */
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
/**
 * Path to the secrets usage read-model database (~/.agents/secrets/secrets.db).
 * Read at CALL time so a test can redirect it to a temp file via
 * AGENTS_SECRETS_DB without racing the module-load capture of USER_SECRETS_DIR —
 * mirrors the AGENTS_EVENTS_PATH / AGENTS_DEVICES_DIR escape hatches. Holds only
 * value-free usage telemetry (which bundle was created/imported/exported/viewed/
 * accessed/unlocked, when, by whom), never a secret value. It used to be a
 * derived index fed FROM the in-repo secrets engine's own emitSecretAudit
 * chokepoint — not a second write path — the same way sessions.db indexes
 * session metadata off the real session flow. That engine (and its audit
 * emission) moved out of this repo entirely with the standalone `secrets`
 * engine (PHNX-3989), so nothing writes this DB from agents-cli today; the
 * read-side queries in `analytics/usage-db.ts` have no current caller.
 */
export function getSecretsDbPath(): string {
  return process.env.AGENTS_SECRETS_DB ?? path.join(USER_SECRETS_DIR, 'secrets.db');
}
/**
 * Path to the durable resource-usage warehouse (~/.agents/.history/analytics/usage.db).
 * Value-free frequency/lifecycle events (secrets, agents, browser, …). Read at CALL
 * time so AGENTS_USAGE_DB can redirect tests. Sync shards may also appear as
 * usage.<machine-id>.db beside this default file.
 */
export function getAnalyticsDir(): string {
  return process.env.AGENTS_ANALYTICS_DIR ?? ANALYTICS_DIR;
}
export function getUsageDbPath(): string {
  return process.env.AGENTS_USAGE_DB ?? path.join(getAnalyticsDir(), 'usage.db');
}
export function getUserPromptcutsPath(): string { return USER_PROMPTCUTS_FILE; }

// ─── User operational path getters ────────────────────────────────────────────
//
// Top-level dirs hold definitions/configs only; runtime data lives under
// .history/ (durable) or .cache/ (regenerable). See file header.

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

/**
 * Path to webhook handler YAML definitions (~/.agents/webhooks/). Handlers are
 * one-off triggers for agents/workflows/commands/routines, layered the same way
 * as routines (project > user > system).
 */
export function getWebhooksDir(): string { return process.env.AGENTS_WEBHOOKS_DIR ?? WEBHOOKS_DIR; }

/**
 * Path to built-in routine definitions shipped in the system repo
 * (`~/.agents/.system/routines/`). Unioned under the user routines dir by
 * listJobs()/readJob(): a routine shipped here fires for every install, and a
 * user routine of the same name overrides it (a user copy with `enabled: false`
 * disables the built-in). The daemon fires these; the directory need not exist.
 */
export function getSystemRoutinesDir(): string { return process.env.AGENTS_SYSTEM_ROUTINES_DIR ?? SYSTEM_ROUTINES_DIR; }

/**
 * Path to built-in webhook handler definitions shipped in the system repo
 * (`~/.agents/.system/webhooks/`). Layered under user handlers by `listHandlers()`.
 */
export function getSystemWebhooksDir(): string { return process.env.AGENTS_SYSTEM_WEBHOOKS_DIR ?? SYSTEM_WEBHOOKS_DIR; }

/**
 * Path to a project-scoped routines directory (`<project>/.agents/routines/`),
 * or null when no project `.agents/` is found by walking up from cwd.
 *
 * Project routines participate in `list`/`view` for inspection always. Daemon
 * firing requires `agents routines enable <name>`, which materialises the
 * routine into the user layer with `source:` provenance (so the daemon, which
 * loads user + system only, can see it) and turns on the device flag in one
 * step. Enablement lives solely in `meta.deviceRoutines`; a project YAML's own
 * `enabled:` field never turns firing on, so a cloned repo cannot auto-run.
 * See `lib/routines-project.ts`.
 */
export function getProjectRoutinesDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'routines');
}

/**
 * Path to a project-scoped webhook handlers directory
 * (`<project>/.agents/webhooks/`), or null when no project `.agents/` is found
 * by walking up from cwd.
 */
export function getProjectWebhooksDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'webhooks');
}

/** Path to routine execution logs (~/.agents/.history/runs/). */
export function getRunsDir(): string { return RUNS_DIR; }

/** Path to monitor YAML definitions (~/.agents/monitors/). */
export function getMonitorsDir(): string { return process.env.AGENTS_MONITORS_DIR ?? MONITORS_DIR; }

/**
 * Path to built-in monitor definitions shipped in the system repo
 * (`~/.agents/.system/monitors/`). Unioned under the user monitors dir by
 * listMonitors()/readMonitor(): a monitor shipped here is available on every
 * install, and a user monitor of the same name overrides it. A built-in is
 * enabled by default like every other system-layer resource — it runs on every
 * install unless the user shadows it with `enabled: false` (via `agents monitors
 * pause`, which materializes a user copy; writes never touch this pull-only
 * mirror). A shared-input built-in still carries its own `device:` owner pin in
 * the shipped YAML so exactly one box fires it (SING-9). The directory need not
 * exist.
 */
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

/**
 * Path to generated per-hook caching/timing shims (~/.agents/.cache/shims/hooks/).
 * Read at CALL time — since every hook now resolves through a shim (RUSH-2xxx,
 * pass-through timing for matcher-only hooks), a test that registers hooks
 * in-process (no subprocess HOME override) would otherwise write real shim
 * files into the user's actual ~/.agents/.cache. AGENTS_HOOK_SHIMS_DIR mirrors
 * the AGENTS_EVENTS_PATH / AGENTS_DEVICES_DIR test-isolation escape hatches;
 * never set in production code.
 */
export function getHookShimsDir(): string {
  return process.env.AGENTS_HOOK_SHIMS_DIR ?? HOOK_SHIMS_DIR;
}

/**
 * Path to per-hook stdout cache files (~/.agents/.cache/state/hooks/). Read at
 * CALL time for the same reason as {@link getHookShimsDir} — see its doc.
 */
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

/**
 * The devices dir (the registry lives here; the ignore-list moved to the
 * tracked central agents.yaml as `fleet.ignored` — RUSH-3062). Read at CALL
 * time so a
 * test can redirect it to a temp dir via AGENTS_DEVICES_DIR without racing the
 * module-load capture of HISTORY_DIR — mirrors the AGENTS_EVENTS_PATH /
 * AGENTS_SECRETS_AGENT_DIR test-isolation escape hatches. Never set in
 * production code; it exists so the vitest fork's device-registry writes can
 * never reach the user's real ~/.agents/.history/devices (RUSH-2042).
 */
function getDevicesDir(): string {
  return process.env.AGENTS_DEVICES_DIR ?? path.join(HISTORY_DIR, 'devices');
}

/** Path to the device registry — SSH device profiles with platform/auth metadata. Durable runtime, per-machine (host list + addresses are NOT pulled by `agents repo push`). */
export function getDevicesRegistryPath(): string { return path.join(getDevicesDir(), 'registry.json'); }

/** Path to the LEGACY per-machine device ignore-list — superseded by the tracked `fleet.ignored` list in central agents.yaml (RUSH-3062); only lib/devices/config-migration.ts still reads it (to fold + remove it). */
export function getDevicesIgnoredPath(): string { return path.join(getDevicesDir(), 'ignored.json'); }

/** Path to the LEGACY device auto-launch preference file — which registered devices are eligible/preferred for the ext's auto-host selection. Superseded by the per-device doc `config:` block; only lib/devices/config-migration.ts still reads it (to fold + remove it). */
export function getDevicesAutoLaunchPath(): string { return path.join(getDevicesDir(), 'auto-launch.json'); }

/** Path to THIS machine's agent pins — the `agents:` global defaults and
 * `isolatedAgents:` pointers. Each pin names a version installed on THIS
 * machine, so it is machine-local runtime state and lives beside the device
 * registry under `.history/devices/` (untracked) — NOT in the tracked
 * per-device doc, where auto-written pins caused commit churn on every
 * `agents use` / install. Read at call time like the other devices-dir paths. */
export function getDevicePinsPath(): string { return path.join(getDevicesDir(), `pins-${machineId()}.json`); }

/** Dir of "pending device" sentinels (~/.agents/.cache/state/devices-pending/) — one empty-ish file per newly-discovered, not-yet-approved tailnet node. Written by the daemon probe, read by the menu-bar helper (mirrors the attention sentinel dir). */
export function getDevicesPendingDir(): string { return path.join(getRuntimeStateDir(), 'devices-pending'); }

/** Path to cloud dispatch cache (~/.agents/.cache/cloud/). */
export function getCloudDir(): string { return CLOUD_DIR; }

/** Path to terminal session metadata (~/.agents/.cache/terminals/). */
export function getTerminalsDir(): string { return TERMINALS_DIR; }

/**
 * Path to runtime logs (~/.agents/.cache/logs/). Read at CALL time so
 * AGENTS_LOGS_DIR can redirect it in tests — same test-isolation escape hatch
 * as {@link getHookShimsDir}; never set in production code.
 */
export function getLogsDir(): string {
  return process.env.AGENTS_LOGS_DIR ?? LOGS_DIR;
}

/**
 * Path to disposable performance samples (~/.agents/.cache/perf/).
 * Holds `perf.db` + a hook-shim spool. Loss is acceptable — wipe freely.
 * Read at CALL time: AGENTS_PERF_DIR (the same override perf/db.ts and
 * perf/spool.ts already honor for their own internal resolution) redirects
 * this canonical getter too, so a caller that goes through it directly
 * (hooks/cache.ts's shim generator, the OpenCode timeout sample writer in
 * hooks.ts) doesn't leak samples into the user's real perf warehouse either.
 */
export function getPerfDir(): string {
  return process.env.AGENTS_PERF_DIR ?? PERF_DIR;
}

/** Path to the perf SQLite warehouse (~/.agents/.cache/perf/perf.db). */
export function getPerfDbPath(): string { return path.join(getPerfDir(), 'perf.db'); }

/** Path to the hook-shim NDJSON spool drained into perf.db on open. */
export function getPerfSpoolPath(): string { return path.join(getPerfDir(), 'spool.jsonl'); }

/**
 * Path to per-process runtime state (~/.agents/.cache/state/).
 *
 * `AGENTS_STATE_DIR` redirects it in tests — the same test-isolation escape
 * hatch as `AGENTS_DEVICES_DIR` / `AGENTS_LOGS_DIR`, and resolved at call time
 * for the same reason (a suite pins it after this module is imported).
 *
 * Without it the suite writes into the operator's LIVE state. Concretely: the
 * device registry and ignore-list already redirect via `AGENTS_DEVICES_DIR`, so
 * under test both read empty — and any code path reaching
 * `reconcilePendingSentinels` then computed "every tailnet node is new" and
 * wrote those sentinels into the real `devices-pending/`, which is exactly what
 * the menu bar renders. Running the suite on a dev machine surfaced all 20
 * tailnet nodes as NEW DEVICES, including registered and explicitly ignored
 * ones, and looked like the operator's ignore list had been lost.
 */
export function getRuntimeStateDir(): string { return process.env.AGENTS_STATE_DIR ?? RUNTIME_STATE_DIR; }

/** Path to companion-extension scratch (~/.agents/.cache/companion/). */
export function getCompanionDir(): string { return COMPANION_CACHE_DIR; }

/** Path to browser runtime data — chrome-data, pids (~/.agents/.cache/browser/). */
export function getBrowserRuntimeDir(): string { return BROWSER_RUNTIME_DIR; }

/**
 * Path to DURABLE browser-profile data (~/.agents/.history/browser-profiles/).
 *
 * This is the persistent home for an attach-only profile's `--user-data-dir` —
 * where a one-time browser sign-in lives. It sits under `.history` (durable),
 * NOT `.cache` (regenerable), for two reasons the ticket (PHNX-3967) named:
 *  - `agents browser profiles remove` sweeps `~/.agents/.cache/browser/<name>*`;
 *    a durable dir here survives that so logins are not wiped by a routine cleanup.
 *  - A cache wipe or the daemon reaper never touches it, so a signed-in Comet
 *    survives quit+relaunch.
 * The user's canonical Comet is launched with this as `--user-data-dir`, and the
 * ownership guard in the local driver compares the running instance's
 * `--user-data-dir` against it to reject a foreign port-squatter.
 */
export function getBrowserDurableDir(): string { return path.join(HISTORY_DIR, 'browser-profiles'); }

/** Path to helper subprocess scratch (~/.agents/.cache/helpers/). */
export function getHelpersDir(): string { return HELPERS_DIR; }

/**
 * Path to scheduler daemon scratch (~/.agents/.cache/helpers/daemon/) — holds
 * the daemon pid file, heartbeat, start lock, and log. AGENTS_DAEMON_DIR
 * redirects it to a fork-private temp so daemon tests (which write pid/heartbeat
 * files and acquire the real start lock) can never clobber a live daemon's state
 * on a dev machine — the surgical mirror of AGENTS_DEVICES_DIR /
 * AGENTS_HOOK_SHIMS_DIR, leaving HOME untouched. Read at CALL time (daemon.ts
 * resolves every path helper through this), so tests/setup.ts can set it before
 * the daemon module is exercised. Never set in production code.
 */
export function getDaemonDir(): string { return process.env.AGENTS_DAEMON_DIR ?? DAEMON_DIR; }

/** Path to PTY server scratch (~/.agents/.cache/helpers/pty/). */
export function getPtyDir(): string { return PTY_DIR; }

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

/**
 * Path to a single user-level extra DotAgent repo clone (~/.agents-<alias>/).
 *
 * Extra repos are user-defined config — they live as peer dirs to ~/.agents/,
 * not under the system repo. `agents repo add` clones here by default.
 */
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

/**
 * Per-device machine-local version pins — `~/.agents/devices/<machine>/agents.yaml`.
 * Committed and synced, but each machine only ever writes its OWN folder, so
 * pulls never conflict. `<machine>` = machineId() (Tailscale-aligned short name).
 */
export function getDeviceMetaPath(): string {
  return path.join(USER_AGENTS_DIR, 'devices', machineId(), 'agents.yaml');
}

/**
 * Machine-local per-version resource tracking — `~/.agents/.history/version-resources.json`.
 * Gitignored (under .history/) and regenerable; never synced.
 */
export function getVersionResourcesPath(): string {
  return path.join(HISTORY_DIR, 'version-resources.json');
}

/**
 * Combined cache stamp across all four Meta sources: central + system
 * agents.yaml, this machine's device pins, and the version-resources tracking.
 * A delimited string, NOT a numeric sum — summing down-scaled epoch-ms values
 * loses precision (float64 rounds sub-unit terms away at ~1.75e12), so a change
 * in any one file must contribute at full resolution.
 */
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

/** Atomic write only when the on-disk content differs — avoids needless mtime
 * bumps (which would thrash the meta cache) on no-op field routing. Returns
 * whether it actually wrote, so a caller can react only to a real change (e.g.
 * commit the central agents.yaml exactly when its bytes moved). */
function writeIfChanged(filePath: string, content: string): boolean {
  let current: string | null = null;
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch { /* absent */ }
  if (current === content) return false;
  atomicWriteFileSync(filePath, content);
  return true;
}

/**
 * True in the always-on daemon process (launched as `agents __daemon-run`,
 * see cli/src/index.ts). The daemon owns central git commits through
 * fleet-shared-repo-sync's publish tick, so a central write from inside the
 * daemon must NOT also commit here — that would race the publisher's own
 * add/commit/rebase/push on the same index. Every ordinary CLI invocation
 * returns false and commits its own central edit synchronously.
 */
function isDaemonProcess(): boolean {
  return process.argv[2] === '__daemon-run';
}

/**
 * Commit the central `agents.yaml` in the user repo, synchronously, so a CLI
 * config mutation never leaves the working tree dirty on that one shared-line
 * file at rest.
 *
 * Why this exists: CLI config commands rewrite the fleet-shared central
 * agents.yaml as a plain file write. Left uncommitted, the tree is dirty on
 * agents.yaml between the write and the daemon's next 15-min publish tick — and
 * a peer's incoming publish commit (which also touches agents.yaml) then trips
 * `dirtyTreeRefusal` ("incoming changes touch uncommitted paths: agents.yaml"),
 * wedging `agents repo pull` fleet-wide (PHNX-3968). Committing the central edit
 * in the same command that made it closes that window: agents.yaml is clean at
 * rest, so nothing incoming can collide with it. Called AFTER the meta lock
 * releases (see {@link commitCentralConfigAfterWrite}) so the git subprocesses
 * never run inside the short, non-heartbeated lockfile window; the user repo
 * already pushes.
 *
 * Scoped tightly: only called when the central bytes actually changed, and never
 * from the daemon (see {@link isDaemonProcess}). A commit failure fails open —
 * a concurrent daemon holding `index.lock`, a mid-rebase repo — leaving
 * agents.yaml dirty; the next successful central write commits it, and until
 * then a pull that would collide refuses rather than losing data. A config
 * command must never fail because git hiccuped.
 *
 * Returns whether a commit was created. Exported for the real-repo tests.
 */
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

/**
 * Partition the in-memory Meta across four files by sync-domain:
 *   - central  `~/.agents/agents.yaml`             — portable, everything else
 *              (including the user-scope `config:` block and the fleet-wide
 *              config defaults under `fleet.defaults.config`)
 *   - device   `~/.agents/devices/<machine>/agents.yaml` — TRACKED operator doc:
 *              `routines:` + `config:` (per-device operator settings) + machine-local
 *              `browser:` / `projectRoot` (never synced)
 *   - pins     `~/.agents/.history/devices/pins-<host>.json` — `agents:` +
 *              `isolatedAgents:` (machine-local runtime, untracked)
 *   - history  `~/.agents/.history/version-resources.json` — `versions:` (machine-local)
 * All callers funnel through writeMeta → here, so nothing else changes. Empty
 * `agents:` / `versions:` are not written (no empty committed files).
 */
/**
 * Fleet-shared (`central`) Meta keys — the OPT-IN allowlist. A key listed here is
 * written to the synced `~/.agents/agents.yaml`. Device-scope is the DEFAULT:
 * {@link metaKeyScope} returns `'device'` for every Meta key NOT listed here, so a
 * newly-added key can never SILENTLY churn the shared file the way a
 * central-by-default would — the very trap behind the recurring agents.yaml churn.
 * Making a key fleet-shared is now a deliberate edit HERE, not the path of least
 * resistance (PHNX-3315).
 */
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

/**
 * Device-scoped Meta keys with BESPOKE routing — each lands in a special file
 * (pins JSON / version-resources JSON) or a REMAPPED device-doc sub-block
 * (`deviceHosts`->`hosts:`, `deviceFleet`->`fleet:`, ...), so their handling is
 * hand-written in {@link writeMetaUnlocked} / {@link overlayMachineLocal} and kept
 * behavior-identical. A device-scoped key NOT listed here is a GENERIC device key:
 * it round-trips through `devices/<host>/agents.yaml` under its OWN name with no
 * bespoke wiring (see the generic loops in those two functions). The `browser`
 * tombstone is bespoke too — drained by lib/browser/registry.ts.
 */
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

/**
 * Compile-time exhaustiveness: every Meta key must be filed as central or
 * bespoke-device above. Add a Meta field without filing it and this line stops
 * compiling — a nudge, NOT a safety gate: {@link metaKeyScope} still defaults an
 * unfiled key to `'device'` at runtime, so even a slipped-through key lands
 * per-box and never leaks to the synced file. File it into {@link CENTRAL_META_KEYS}
 * (fleet-shared) or {@link BESPOKE_DEVICE_KEYS} (per-box).
 */
type ClassifiedMetaKey = (typeof CENTRAL_META_KEYS)[number] | (typeof BESPOKE_DEVICE_KEYS)[number];
const _metaKeysAreExhaustive: keyof Meta extends ClassifiedMetaKey ? true : never = true;
void _metaKeysAreExhaustive;

/**
 * Sync-domain of a Meta key. `'central'` ONLY for the opt-in allowlist; `'device'`
 * by DEFAULT for everything else — so the classification is authoritative (it
 * DRIVES the generic device-doc router below) rather than a decorative string map,
 * and forgetting to classify a new key routes it to the SAFE per-box file.
 */
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

/**
 * Device-doc sub-block names the read/write paths handle BESPOKE-ly (each maps to
 * a different `device*` Meta key, or lives in a separate file). The generic
 * device-doc overlay skips these so it only surfaces genuine generic keys.
 */
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

/**
 * Every key this version models (central + device). serializeCentral deletes an
 * on-disk key only when it is KNOWN and absent from the write's in-memory object:
 * a central key the caller cleared, OR a device key that is legacy cruft in the
 * synced file (device keys are routed to the per-machine file, so one lingering
 * in central is stale and must be migrated out). A key NOT listed here — e.g. one
 * a newer CLI version added — is preserved verbatim, never dropped + synced away.
 */
const KNOWN_META_KEYS: ReadonlySet<string> = new Set<string>([
  ...CENTRAL_META_KEYS,
  ...BESPOKE_DEVICE_KEYS,
  // Removed browser-profile store. Kept only as a serializer tombstone so the
  // first registry read can migrate it into this device's file and delete it.
  'browser',
]);

/**
 * Rewrite a frozen `agents.yaml` header to the current {@link META_HEADER}.
 *
 * `serializeCentral` parses the existing file to preserve its hand-written body
 * comments, but that also preserves the leading metadata header verbatim, so a
 * top-level file written before the agi-cli rename (or before the `$schema` line
 * existed) keeps its stale header forever — every freshly-written device doc gets
 * the current header while the shared file is left behind (PHNX-3315).
 *
 * The header is healed TEXTUALLY, on the already-serialized string, rather than
 * via `doc.commentBefore`: the `yaml` library folds the whole leading comment
 * block onto the FIRST key's `commentBefore` when that key already carries a
 * hand-written comment, so the header is not reliably the document comment — but
 * it is always the top block of the output. Strip a leading `agents-cli metadata`
 * header (any pre-rename variant, with or without the `$schema` line — the URL
 * and schema lines are matched specifically so a hand-written body comment is
 * never mistaken for a header line) and prepend the canonical header. A file with
 * no recognizable header simply gains one. Body comments, which sit below the
 * blank line that terminates the header, are untouched.
 */
function healMetaHeader(serialized: string): string {
  const headerBlock =
    /^# agents-cli metadata\n# Auto-generated - do not edit manually\n(?:# (?:https:\/\/github\.com\/phnx-labs\/[^\n]*|yaml-language-server: \$schema=[^\n]*)\n)*\n?/;
  const stripped = serialized.replace(headerBlock, '');
  // No metadata header present (replace was a no-op) → leave the file exactly as
  // it is. We heal a STALE header; we never prepend one to a file that never had
  // it (that would rewrite a hand-authored, headerless central file on the first
  // real central change). A current header round-trips to the identical bytes.
  return stripped === serialized ? serialized : META_HEADER + stripped;
}

/**
 * True when the top-level `~/.agents/agents.yaml` carries a metadata header that
 * is NOT the canonical {@link META_HEADER} — the P1 frozen-header case a box only
 * heals on its next central write (serializeCentral). An absent or headerless
 * file is NOT stale (a headerless central file is deliberately left alone).
 * Surfaced as config drift by `agents sync status` (PHNX-3315).
 */
export function hasStaleMetaHeader(): boolean {
  let content: string;
  try { content = fs.readFileSync(META_FILE, 'utf-8'); } catch { return false; }
  return healMetaHeader(content) !== content;
}

/**
 * Parse the top-level user `agents.yaml` (this box's synced central file) WITHOUT
 * the system-repo merge, machine-local overlay, or cache — the raw on-disk central
 * map, or null when the file is absent/unparseable. Used by config-drift detection
 * to see the central blocks that should have folded into the device doc, without
 * mis-attributing a system-repo default as this box's own leak (PHNX-3315).
 */
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

/**
 * Top-level keys currently on disk in the central `agents.yaml` ({} when the file
 * is absent or unparseable). The generic device-doc router uses this to leave a
 * FOREIGN key — one this version does not model, already written to central by a
 * newer CLI — in place instead of relocating it to this box's device doc.
 */
function readCentralKeys(): ReadonlySet<string> {
  return new Set(Object.keys(readTopLevelUserMeta() ?? {}));
}

/**
 * Serialize the central (synced) meta to `agents.yaml` WITHOUT destroying the
 * hand-written comments in the committed file.
 *
 * `yaml.stringify(central)` drops every comment, so the freshly-written bytes
 * never equal the comment-annotated file on disk — `writeIfChanged`'s byte
 * compare then rewrites on EVERY meta write, leaving `agents.yaml` perpetually
 * dirty and wedging `agents sync` ("Blocked by local changes"). Instead we parse
 * the existing file into a `yaml.Document` (which preserves comments + ordering)
 * and edit only the keys that actually changed — untouched keys, and all their
 * comments, are left byte-stable. If nothing central changed we return the exact
 * existing bytes, so a device-field-only write no longer touches `agents.yaml` at
 * all. Falls back to plain stringify only when the file doesn't exist yet.
 */
function serializeCentral(central: Record<string, unknown>): string {
  const isEmpty = Object.keys(central).length === 0;
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(META_FILE, 'utf-8');
  } catch {
    /* first write — no file yet */
  }
  if (existing == null) {
    // Empty central → header only. `yaml.stringify({})` emits `{}` (a FLOW empty
    // map); once that lands on disk, a later parseDocument sees a flow root and
    // doc.set() below would inherit flow, flow-ifying the whole file. Writing just
    // the header avoids seeding that poison.
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
    // Only delete a key THIS version knows about. A key not in KNOWN_META_KEYS
    // (e.g. one a newer CLI version added) is preserved verbatim — deleting it
    // here would drop it and sync the deletion fleet-wide (the agents.yaml
    // config data-loss bug). A known device key lingering in the synced file is
    // still removed — it belongs in the per-machine file, not here.
    if (!(k in central) && KNOWN_META_KEYS.has(k)) {
      // RUSH-2837: a partial writeMeta (reconstructed Meta missing `share`)
      // deleted the share endpoint from agents.yaml and synced that deletion
      // fleet-wide. `share` is restored only by setup/join — never drop it
      // just because this write omitted the key. Explicit `share: null` still
      // goes through doc.set above.
      if (k === 'share') continue;
      doc.delete(k);
      changed = true;
    }
  }
  // No central field changed → keep the file byte-identical (comments intact), so
  // writeIfChanged skips it and the churn loop never starts. A device-only write
  // (pins/routines/etc. routed elsewhere) reaches here with changed=false and
  // MUST NOT rewrite the shared file — header healing waits for a genuine central
  // change below rather than dirtying agents.yaml on an unrelated write, which is
  // the very churn that wedges `agents sync` and blocks fleet pulls.
  if (!changed) return existing;
  // Everything cleared → header only (never leave a flow `{}` behind). Byte-stable
  // when the file is already exactly the current header.
  if (isEmpty) return existing === META_HEADER ? existing : META_HEADER;
  // A central key changed: serialize the edited doc and heal a frozen header on
  // the result. stringifyDoc still normalizes a legacy flow root (`{}`) to block,
  // so edited nodes do not render flow (`disabledCommands: [ teams ]` instead of a
  // `- teams` block list), but it no longer forces block on a normal document —
  // that flattened committed flow sequences and made this writer disagree with
  // feed.ts/activity.ts/migrate.ts on the same file (RUSH-2505). parseDocument
  // still preserves body comments + key ordering; healMetaHeader is a no-op unless
  // a stale metadata header is actually present, so a headerless central file is
  // updated in place without gaining one.
  return healMetaHeader(stringifyDoc(doc));
}

/**
 * Write `meta` to disk (central + device docs + pins) WITHOUT taking the meta
 * lock — the caller must already hold it via {@link withMetaLock}. Exported so a
 * writer that needs to read fresh state, decide, and commit within a SINGLE lock
 * acquisition (e.g. browser tombstone eviction) can do so without the
 * read-snapshot-then-separately-lock race that {@link updateMeta} would impose.
 *
 * Returns whether the central `agents.yaml` bytes actually changed, so the
 * caller can commit it once — {@link commitCentralConfig} — AFTER releasing the
 * meta lock (the git subprocesses must not run inside the short, non-heartbeated
 * lockfile window). This function never commits.
 */
export function writeMetaUnlocked(meta: Meta): boolean {
  const writesDeviceRoutines = Object.prototype.hasOwnProperty.call(meta, 'deviceRoutines');
  const writesDeviceConfig = Object.prototype.hasOwnProperty.call(meta, 'deviceConfig');
  const writesDeviceBrowser = Object.prototype.hasOwnProperty.call(meta, 'deviceBrowser');
  const writesDeviceFleet = Object.prototype.hasOwnProperty.call(meta, 'deviceFleet');
  const writesDeviceHosts = Object.prototype.hasOwnProperty.call(meta, 'deviceHosts');
  const writesDeviceAccounts = Object.prototype.hasOwnProperty.call(meta, 'deviceAccounts');
  const writesProjectRoot = Object.prototype.hasOwnProperty.call(meta, 'projectRoot');
  // INVARIANT: every key destructured here must also be in BESPOKE_DEVICE_KEYS (and
  // vice versa) — a bespoke device key that is classified but NOT pulled out here
  // would fall into `central`, and the generic router skips it (BESPOKE_DEVICE_KEY_SET),
  // so it would silently sync to the shared file. Keep the two lists in lockstep.
  const { agents, isolatedAgents, versions, deviceRoutines, deviceConfig, deviceBrowser, deviceFleet, deviceHosts, deviceAccounts, projectRoot, ...central } = meta;

  // Write the machine-local files FIRST, then strip central — so a crash mid-write
  // never removes pins/versions from central before they're persisted elsewhere.
  const hasAgents = !!agents && Object.keys(agents).length > 0;
  // The isolated pointer names a version installed on THIS machine, exactly like a
  // global pin, so it belongs beside `agents` in the pins file rather than in the
  // central doc that syncs — otherwise another machine inherits a pointer to a copy
  // it does not have.
  const hasIsolatedAgents = !!isolatedAgents && Object.keys(isolatedAgents).length > 0;
  // Pins (`agents:` defaults + `isolatedAgents:`) are machine-local runtime
  // state — they live in the untracked .history pins JSON, never in the tracked
  // per-device doc (auto-written pins there caused commit churn on every
  // `agents use` / install).
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

  // The tracked per-device doc carries operator-owned fields: `routines:`
  // (device-local activation) from here, `config:` from lib/device-config.ts,
  // and machine-local browser defaults / projectRoot (never fleet policy).
  // Merge over the existing doc so a `config:` block written outside this path
  // is never clobbered. Pins are stripped defensively — they belong to the pins
  // file now (the migration strips them too; a hand-edited doc converges on the
  // next write).
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
  // PHNX-3315 device-scoped fleet/hosts/accounts blocks. Each is this box's OWN
  // slice; the effective fleet view is unioned across every device doc at read
  // time (lib/devices/device-docs.ts). Empty slices are dropped so a box that
  // has made no decision leaves no key behind (no committed empty maps).
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

  // Generic device-scoped keys (PHNX-3315): any key left in `central` that this
  // version classifies as device but does NOT bespoke-route round-trips through
  // this box's device doc under its OWN name — so a NEWLY DECLARED device-scoped
  // key lands per-box BY DEFAULT, with no bespoke wiring, and never reaches the
  // synced central file. Today the bespoke set covers every device key, so this
  // loop moves nothing (behavior-identical). A key that is UNKNOWN to this version
  // AND already present in the on-disk central file is a FOREIGN key a newer CLI
  // wrote as central — left in `central` and preserved verbatim by serializeCentral
  // (the fleet-wide config-loss guard), never relocated to this box's doc.
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

/**
 * Overlay this machine's local state onto a central-portable Meta:
 *   - `agents:` and `isolatedAgents:` from the pins file (device wins; the union
 *     both preserves the one-level merge and self-heals a pre-migration central that
 *     still has pins)
 *   - `routines:` / machine-local `browser:` / `projectRoot` from the tracked device
 *     doc (device-local; the doc's `config:` block is read by lib/device-config.ts,
 *     not overlaid here)
 *   - `versions:` from the history JSON (wholesale replace; falls back to
 *     whatever central carried when the history file doesn't exist yet)
 */
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
      // PHNX-3315: this box's own device-scoped fleet/hosts/accounts slices.
      // These populate the `device*` keys the writers read-modify-write; the
      // effective UNION across all boxes is computed separately by
      // lib/devices/device-docs.ts, not here (this overlay is this box only).
      // A malformed block on THIS box's own doc is a HARD error, exactly like
      // `routines` below and the cross-box union readers (device-docs.ts): a
      // silent drop would let the next writeMetaUnlocked round-trip overwrite the
      // whole block with just the new entry, discarding the rest on this box's
      // tracked file (PHNX-3315).
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
      // Generic device-scoped keys (PHNX-3315): device-doc keys this overlay does
      // NOT bespoke-handle map straight back onto Meta under their own name —
      // symmetry with the generic write in writeMetaUnlocked. The bespoke sub-blocks
      // are handled above and skipped, so a stock device doc surfaces nothing extra.
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

/**
 * One-shot migration: move agents.yaml from system repo to user repo.
 * Idempotent — no-ops if user file already exists or system file absent.
 */
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

/**
 * Read and cache ~/.agents/agents.yaml, migrating from legacy locations if needed.
 *
 * Cache invariants:
 * - Cache key is the mtime of the user agents.yaml.
 * - `writeMetaUnlocked` clears the cache; in-process callers always see fresh state.
 * - If the file is mutated by ANOTHER process while we hold a stale cache, the
 *   mtime check below catches it on the next read (assuming the mtime advanced).
 * - The cache stores the merged system+user meta; both files' mtimes contribute.
 */
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

  // NOTE: agents.yaml migration from ~/.agents-system/ to ~/.agents/ is handled
  // exclusively by runMigration() in migrate.ts, called from postinstall and
  // from a one-shot bootstrap step in src/index.ts. Calling it here would
  // mutate real-user filesystem state during test runs that import this
  // module, causing cross-test pollution.

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

      // Lock-safe, commit-free write: withMetaLock is reentrant (see
      // metaLockDepth), so this writes under the lock when called standalone and
      // is a no-op re-entry when readMeta runs inside updateMeta/writeMeta's held
      // lock — and writeMetaUnlocked never spawns git. Calling the PUBLIC
      // writeMeta here would run commit-on-write's git subprocess inside a held,
      // non-heartbeated lock. This one-shot legacy migration needs no synchronous
      // commit: it self-heals on the daemon's next publish tick or the next real
      // CLI central write.
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

/**
 * Commit-on-write, invoked AFTER {@link withMetaLock} releases so the git
 * subprocesses never run inside the short, non-heartbeated meta-lock window.
 * A CLI command that actually moved the fleet-shared central agents.yaml commits
 * it so the tree is never left dirty on that file at rest — the window that
 * trips `dirtyTreeRefusal` and wedges pulls fleet-wide (PHNX-3968). Gated on a
 * real byte change and never run in the daemon, whose publish tick owns central
 * commits. See {@link commitCentralConfig}.
 */
export function commitCentralConfigAfterWrite(centralChanged: boolean): void {
  if (centralChanged && !isDaemonProcess()) {
    commitCentralConfig(USER_AGENTS_DIR);
  }
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

/**
 * @deprecated No-op. Use ensureVersionResourcePatterns instead.
 * Kept for backward compat with command files that still call it.
 */
export function recordVersionResources(
  _agent: AgentId,
  _version: string,
  _resourceType: ResourceType,
  _resources: string[]
): void {
  // intentional no-op — tracking moved to pattern-based ensureVersionResourcePatterns
}

/**
 * Write default resource selection patterns for an agent@version.
 * Only writes each field when it is not already set, preserving user customization.
 * Pass all resource types you want to initialize in one call to batch the write.
 */
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

/**
 * Resource types that resolve across the extra-repo layer. Mirrors
 * `defaultPatterns()`: extras feed commands/skills/hooks/subagents/plugins/
 * workflows, but never permissions (`system:*`) or mcp (`user:*`).
 */
const EXTRA_ELIGIBLE_TYPES: readonly (keyof VersionResources)[] = [
  'commands', 'skills', 'hooks', 'subagents', 'plugins', 'workflows',
];

/**
 * Insert `<alias>:*` at the canonical position (after the system/user/other-extra
 * includes, before `project:*`), unless the alias is already referenced — as an
 * include (`alias:...`) or an exclude (`!alias:...`). Returns a new array when it
 * changes, otherwise the same reference (so callers can detect no-ops cheaply).
 */
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

/**
 * Backfill (add=true) or strip (add=false) an extra-repo alias across every
 * already-installed version's selectors. New versions get the alias via
 * `defaultPatterns()` at scaffold time; this keeps existing versions in sync
 * when an extra repo is registered/enabled or removed. Only touches selector
 * lists that are already set — an unset list is left for `defaultPatterns()`.
 * Returns the number of (agent, version) pairs changed.
 */
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
