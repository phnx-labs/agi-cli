
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

function isSamePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    const norm = (p: string) =>
      process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    return norm(a) === norm(b);
  }
}


const USER_AGENTS_DIR = path.join(HOME, '.agents');

const SYSTEM_AGENTS_DIR = path.join(USER_AGENTS_DIR, '.system');

const LEGACY_SYSTEM_AGENTS_DIR = path.join(HOME, '.agents-system');


const META_FILE = path.join(USER_AGENTS_DIR, 'agents.yaml');
const SYSTEM_META_FILE = path.join(SYSTEM_AGENTS_DIR, 'agents.yaml');




const SYSTEM_COMMANDS_DIR = path.join(SYSTEM_AGENTS_DIR, 'commands');
const SYSTEM_HOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'hooks');
const SYSTEM_SKILLS_DIR = path.join(SYSTEM_AGENTS_DIR, 'skills');
const SYSTEM_RULES_DIR = path.join(SYSTEM_AGENTS_DIR, 'rules');
const SYSTEM_MCP_DIR = path.join(SYSTEM_AGENTS_DIR, 'mcp');
const SYSTEM_PERMISSIONS_DIR = path.join(SYSTEM_AGENTS_DIR, 'permissions');
const SYSTEM_SUBAGENTS_DIR = path.join(SYSTEM_AGENTS_DIR, 'subagents');
const SYSTEM_WORKFLOWS_DIR = path.join(SYSTEM_AGENTS_DIR, 'workflows');
const SYSTEM_PLUGINS_DIR = path.join(SYSTEM_AGENTS_DIR, 'plugins');
const SYSTEM_ROUTINES_DIR = path.join(SYSTEM_AGENTS_DIR, 'routines');
const SYSTEM_WEBHOOKS_DIR = path.join(SYSTEM_AGENTS_DIR, 'webhooks');
const SYSTEM_PROMPTCUTS_FILE = path.join(SYSTEM_AGENTS_DIR, 'hooks', 'promptcuts.yaml');
const SYSTEM_MCP_CONFIG_FILE = path.join(SYSTEM_AGENTS_DIR, 'mcp.json');
const SYSTEM_INSTRUCTIONS_FILE = path.join(SYSTEM_AGENTS_DIR, 'instructions.md');


const HISTORY_DIR = path.join(USER_AGENTS_DIR, '.history');

const CACHE_DIR = path.join(USER_AGENTS_DIR, '.cache');

const ROUTINES_DIR = path.join(USER_AGENTS_DIR, 'routines');
const WEBHOOKS_DIR = path.join(USER_AGENTS_DIR, 'webhooks');
const TEAMS_DIR = path.join(USER_AGENTS_DIR, 'teams');
const PROJECTS_DIR = path.join(USER_AGENTS_DIR, 'projects');
const DAEMON_CONFIG_DIR = path.join(USER_AGENTS_DIR, 'daemon');

const SESSIONS_DIR = path.join(HISTORY_DIR, 'sessions');
const SESSIONS_DB_PATH = path.join(SESSIONS_DIR, 'sessions.db');
const ANALYTICS_DIR = path.join(HISTORY_DIR, 'analytics');
const VERSIONS_DIR = path.join(HISTORY_DIR, 'versions');
const RUNS_DIR = path.join(HISTORY_DIR, 'runs');
const TEAMS_AGENTS_DIR = path.join(HISTORY_DIR, 'teams', 'agents');
const BACKUPS_DIR = path.join(HISTORY_DIR, 'backups');
const TRASH_DIR = path.join(HISTORY_DIR, 'trash');
const MAILBOX_DIR = path.join(HISTORY_DIR, 'mailbox');
const FEED_DIR = path.join(HISTORY_DIR, 'feed');
const ACTIVITY_DIR = path.join(HISTORY_DIR, 'activity');

const SHIMS_DIR = path.join(CACHE_DIR, 'shims');
const HOOK_SHIMS_DIR = path.join(SHIMS_DIR, 'hooks');
const HOOK_CACHE_DIR = path.join(CACHE_DIR, 'state', 'hooks');
const BIN_DIR = path.join(CACHE_DIR, 'bin');
const PACKAGES_DIR = path.join(CACHE_DIR, 'packages');
const PLUGINS_DIR = path.join(USER_AGENTS_DIR, 'plugins');
const CLOUD_DIR = path.join(CACHE_DIR, 'cloud');
const TERMINALS_DIR = path.join(CACHE_DIR, 'terminals');
const LOGS_DIR = path.join(CACHE_DIR, 'logs');
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

export const META_HEADER = `# agents-cli metadata
# Auto-generated - do not edit manually
# https://github.com/phnx-labs/agi-cli
# yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json

`;


export function getAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

export function getSystemAgentsDir(): string {
  return SYSTEM_AGENTS_DIR;
}

export function getLegacySystemAgentsDir(): string {
  return LEGACY_SYSTEM_AGENTS_DIR;
}

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
    } catch {  }
  }
  return USER_AGENTS_DIR;
}

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

function canonicalDotAgentsRepoSlugs(): Set<string> {
  const slugs = new Set<string>([systemRepoSlug(DEFAULT_SYSTEM_REPO).toLowerCase()]);
  for (const dir of [USER_AGENTS_DIR, SYSTEM_AGENTS_DIR]) {
    const slug = gitOriginSlug(dir);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

function isUserOrSystemRepoCheckout(agentsPath: string): boolean {
  if (!fs.existsSync(path.join(agentsPath, '.git'))) return false;
  const origin = gitOriginSlug(agentsPath);
  if (!origin) return false;
  return canonicalDotAgentsRepoSlugs().has(origin);
}

export function isReservedAgentsDir(agentsPath: string): boolean {
  return isSamePath(agentsPath, SYSTEM_AGENTS_DIR)
    || isSamePath(agentsPath, USER_AGENTS_DIR)
    || isUserOrSystemRepoCheckout(agentsPath);
}

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


export function getCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }

export function getHooksDir(): string { return SYSTEM_HOOKS_DIR; }

export function getSkillsDir(): string { return SYSTEM_SKILLS_DIR; }

export function getRulesDir(): string { return SYSTEM_RULES_DIR; }

export function getResolvedRulesDir(): string { return SYSTEM_RULES_DIR; }

export function getMcpDir(): string { return SYSTEM_MCP_DIR; }

export function getPermissionsDir(): string { return process.env.AGENTS_SYSTEM_PERMISSIONS_DIR ?? SYSTEM_PERMISSIONS_DIR; }

export function getSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }

export function getPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }

export function getEffectivePromptcutsPath(): string {
  if (fs.existsSync(USER_PROMPTCUTS_FILE)) return USER_PROMPTCUTS_FILE;
  return SYSTEM_PROMPTCUTS_FILE;
}

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
    }
  }
  return merged;
}

export function getMcpConfigPath(): string { return SYSTEM_MCP_CONFIG_FILE; }

export function getInstructionsPath(): string { return SYSTEM_INSTRUCTIONS_FILE; }


export function getSystemCommandsDir(): string { return SYSTEM_COMMANDS_DIR; }
export function getSystemHooksDir(): string { return SYSTEM_HOOKS_DIR; }
export function getSystemSkillsDir(): string { return SYSTEM_SKILLS_DIR; }
export function getSystemRulesDir(): string { return SYSTEM_RULES_DIR; }
export function getSystemMcpDir(): string { return SYSTEM_MCP_DIR; }
export function getSystemPermissionsDir(): string { return SYSTEM_PERMISSIONS_DIR; }
export function getSystemSubagentsDir(): string { return SYSTEM_SUBAGENTS_DIR; }
export function getSystemPromptcutsPath(): string { return SYSTEM_PROMPTCUTS_FILE; }


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
export function getSecretsDbPath(): string {
  return process.env.AGENTS_SECRETS_DB ?? path.join(USER_SECRETS_DIR, 'secrets.db');
}
export function getAnalyticsDir(): string {
  return process.env.AGENTS_ANALYTICS_DIR ?? ANALYTICS_DIR;
}
export function getUsageDbPath(): string {
  return process.env.AGENTS_USAGE_DB ?? path.join(getAnalyticsDir(), 'usage.db');
}
export function getUserPromptcutsPath(): string { return USER_PROMPTCUTS_FILE; }


export function getHomeDir(): string { return HOME; }

export function getHistoryDir(): string { return HISTORY_DIR; }

export function getCacheDir(): string { return CACHE_DIR; }

export function getPackagesDir(): string { return PACKAGES_DIR; }

export function getRoutinesDir(): string { return process.env.AGENTS_ROUTINES_DIR ?? ROUTINES_DIR; }

export function getProjectsDir(): string { return process.env.AGENTS_PROJECTS_DIR ?? PROJECTS_DIR; }

export function getDaemonConfigDir(): string { return process.env.AGENTS_DAEMON_CONFIG_DIR ?? DAEMON_CONFIG_DIR; }

export function getWebhooksDir(): string { return process.env.AGENTS_WEBHOOKS_DIR ?? WEBHOOKS_DIR; }

export function getSystemRoutinesDir(): string { return process.env.AGENTS_SYSTEM_ROUTINES_DIR ?? SYSTEM_ROUTINES_DIR; }

export function getSystemWebhooksDir(): string { return process.env.AGENTS_SYSTEM_WEBHOOKS_DIR ?? SYSTEM_WEBHOOKS_DIR; }

export function getProjectRoutinesDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'routines');
}

export function getProjectWebhooksDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'webhooks');
}

export function getRunsDir(): string { return RUNS_DIR; }

export function getMailboxRootDir(): string { return MAILBOX_DIR; }

export function getFeedDir(): string { return FEED_DIR; }

export function getActivityDir(): string { return ACTIVITY_DIR; }

export function getVersionsDir(): string { return VERSIONS_DIR; }

export function getShimsDir(): string { return SHIMS_DIR; }

export function getHookShimsDir(): string {
  return process.env.AGENTS_HOOK_SHIMS_DIR ?? HOOK_SHIMS_DIR;
}

export function getHookCacheDir(): string {
  return process.env.AGENTS_HOOK_CACHE_DIR ?? HOOK_CACHE_DIR;
}

export function getBinDir(): string { return BIN_DIR; }

export function getBackupsDir(): string { return BACKUPS_DIR; }

export function getPluginsDir(): string { return PLUGINS_DIR; }

export function getSystemPluginsDir(): string { return SYSTEM_PLUGINS_DIR; }

export function getExtraPluginsDir(alias: string): string {
  return path.join(getExtraRepoDir(alias), 'plugins');
}

export function getProjectPluginsDir(cwd: string = process.cwd()): string | null {
  const projectAgentsDir = getProjectAgentsDir(cwd);
  if (!projectAgentsDir) return null;
  return path.join(projectAgentsDir, 'plugins');
}

export function getTrashDir(): string { return TRASH_DIR; }

export function getSessionsDir(): string { return SESSIONS_DIR; }

export function getSessionsDbPath(): string {
  return process.env.AGENTS_SESSIONS_DB ?? SESSIONS_DB_PATH;
}

export function getTeamsDir(): string { return TEAMS_DIR; }

export function getTeamsAgentsDir(): string { return TEAMS_AGENTS_DIR; }

export function getTeamsRegistryPath(): string { return path.join(HISTORY_DIR, 'teams', 'registry.json'); }

function getDevicesDir(): string {
  return process.env.AGENTS_DEVICES_DIR ?? path.join(HISTORY_DIR, 'devices');
}

export function getDevicesRegistryPath(): string { return path.join(getDevicesDir(), 'registry.json'); }

export function getDevicesIgnoredPath(): string { return path.join(getDevicesDir(), 'ignored.json'); }

export function getDevicesAutoLaunchPath(): string { return path.join(getDevicesDir(), 'auto-launch.json'); }

export function getDevicePinsPath(): string { return path.join(getDevicesDir(), `pins-${machineId()}.json`); }

export function getDevicesPendingDir(): string { return path.join(getRuntimeStateDir(), 'devices-pending'); }

export function getCloudDir(): string { return CLOUD_DIR; }

export function getTerminalsDir(): string { return TERMINALS_DIR; }

export function getLogsDir(): string {
  return process.env.AGENTS_LOGS_DIR ?? LOGS_DIR;
}

export function getPerfDir(): string {
  return process.env.AGENTS_PERF_DIR ?? PERF_DIR;
}

export function getPerfDbPath(): string { return path.join(getPerfDir(), 'perf.db'); }

export function getPerfSpoolPath(): string { return path.join(getPerfDir(), 'spool.jsonl'); }

export function getRuntimeStateDir(): string { return process.env.AGENTS_STATE_DIR ?? RUNTIME_STATE_DIR; }

export function getCompanionDir(): string { return COMPANION_CACHE_DIR; }

export function getBrowserRuntimeDir(): string { return BROWSER_RUNTIME_DIR; }

export function getBrowserDurableDir(): string { return path.join(HISTORY_DIR, 'browser-profiles'); }

export function getHelpersDir(): string { return HELPERS_DIR; }

export function getDaemonDir(): string { return process.env.AGENTS_DAEMON_DIR ?? DAEMON_DIR; }

export function getTmuxDir(): string { return TMUX_DIR; }

export function getFetchCacheDir(): string { return FETCH_CACHE_DIR; }

export function getCliVersionCachePath(): string { return CLI_VERSION_CACHE_FILE; }

export function getModelsCachePath(): string { return MODELS_CACHE_FILE; }

export function getUpdateCheckPath(): string { return UPDATE_CHECK_FILE; }

export function getMigratedSentinelPath(): string { return MIGRATED_SENTINEL_FILE; }

export function getTrashVersionsDir(): string { return path.join(TRASH_DIR, 'versions'); }

export function getTrashSkillsDir(): string { return path.join(TRASH_DIR, 'skills'); }

export function getTrashCommandsDir(): string { return path.join(TRASH_DIR, 'commands'); }

export function getTrashHooksDir(): string { return path.join(TRASH_DIR, 'hooks'); }

export function getTrashPluginsDir(): string { return path.join(TRASH_DIR, 'plugins'); }

export function getTrashSubagentsDir(): string { return path.join(TRASH_DIR, 'subagents'); }
export function getTrashWorkflowsDir(): string { return path.join(TRASH_DIR, 'workflows'); }
export function getTrashFilesDir(): string { return path.join(TRASH_DIR, 'files'); }

export function getExtraRepoDir(alias: string): string {
  return path.join(HOME, `.agents-${alias}`);
}

export function resolveExtraRepoDir(alias: string, config?: { path?: string }): string {
  if (config?.path) {
    return path.resolve(config.path);
  }
  return getExtraRepoDir(alias);
}

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


export function ensureAgentsDir(): void {
  const opts = { recursive: true, mode: 0o700 } as const;

  if (!fs.existsSync(USER_AGENTS_DIR)) {
    fs.mkdirSync(USER_AGENTS_DIR, opts);
  }
  try { fs.chmodSync(USER_AGENTS_DIR, 0o700); } catch {}

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


export function createDefaultMeta(): Meta {
  return {};
}

let metaCache: { stamp: string; meta: Meta } | null = null;
let metaLockDepth = 0;

function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function getDeviceMetaPath(): string {
  return path.join(USER_AGENTS_DIR, 'devices', machineId(), 'agents.yaml');
}

export function getVersionResourcesPath(): string {
  return path.join(HISTORY_DIR, 'version-resources.json');
}

function currentMetaStamp(): string {
  return safeMtimeMs(META_FILE)
    + '|' + safeMtimeMs(SYSTEM_META_FILE)
    + '|' + safeMtimeMs(getDeviceMetaPath())
    + '|' + safeMtimeMs(getDevicePinsPath())
    + '|' + safeMtimeMs(getVersionResourcesPath());
}

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

function writeIfChanged(filePath: string, content: string): boolean {
  let current: string | null = null;
  try { current = fs.readFileSync(filePath, 'utf-8'); } catch {  }
  if (current === content) return false;
  atomicWriteFileSync(filePath, content);
  return true;
}

export function commitCentralConfig(
  userDir: string,
  rel = 'agents.yaml',
  message = 'chore(config): update agents.yaml',
): boolean {
  try {
    execFileSync('git', ['-C', userDir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    return false;
  }
  try {
    execFileSync('git', ['-C', userDir, 'add', '--', rel], { stdio: 'ignore' });
    try {
      execFileSync('git', ['-C', userDir, 'diff', '--cached', '--quiet', '--', rel], { stdio: 'ignore' });
      return false;
    } catch {  }
    execFileSync(
      'git',
      ['-C', userDir, '-c', 'commit.gpgsign=false', 'commit', '--no-verify',
        '-m', message, '--', rel],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

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

type ClassifiedMetaKey = (typeof CENTRAL_META_KEYS)[number] | (typeof BESPOKE_DEVICE_KEYS)[number];
const _metaKeysAreExhaustive: keyof Meta extends ClassifiedMetaKey ? true : never = true;
void _metaKeysAreExhaustive;

function metaKeyScope(key: string): 'central' | 'device' {
  // Central sync is an explicit allowlist; every other key remains machine-local.
  return CENTRAL_KEY_SET.has(key) ? 'central' : 'device';
}

const BESPOKE_DEVICE_KEY_SET: ReadonlySet<string> = new Set<string>([
  ...BESPOKE_DEVICE_KEYS,
  'browser',
]);

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
  'defaultBrowserProfile',
]);

const KNOWN_META_KEYS: ReadonlySet<string> = new Set<string>([
  ...CENTRAL_META_KEYS,
  ...BESPOKE_DEVICE_KEYS,
  'browser',
]);

function healMetaHeader(serialized: string): string {
  const headerBlock =
    /^# agents-cli metadata\n# Auto-generated - do not edit manually\n(?:# (?:https:\/\/github\.com\/phnx-labs\/[^\n]*|yaml-language-server: \$schema=[^\n]*)\n)*\n?/;
  const stripped = serialized.replace(headerBlock, '');
  return stripped === serialized ? serialized : META_HEADER + stripped;
}

export function hasStaleMetaHeader(): boolean {
  let content: string;
  try { content = fs.readFileSync(META_FILE, 'utf-8'); } catch { return false; }
  return healMetaHeader(content) !== content;
}

export function readTopLevelUserMeta(): Record<string, unknown> | null {
  let content: string;
  try { content = fs.readFileSync(META_FILE, 'utf-8'); } catch { return null; }
  try {
    const parsed = yaml.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {  }
  return null;
}

function readCentralKeys(): ReadonlySet<string> {
  return new Set(Object.keys(readTopLevelUserMeta() ?? {}));
}

function serializeCentral(central: Record<string, unknown>): string {
  // Preserve unknown central keys so an older binary cannot sync away newer data.
  const isEmpty = Object.keys(central).length === 0;
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(META_FILE, 'utf-8');
  } catch {
  }
  if (existing == null) {
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
    if (!(k in central) && KNOWN_META_KEYS.has(k)) {
      if (k === 'share') continue;
      doc.delete(k);
      changed = true;
    }
  }
  if (!changed) return existing;
  if (isEmpty) return existing === META_HEADER ? existing : META_HEADER;
  return healMetaHeader(stringifyDoc(doc));
}

export function writeMetaUnlocked(meta: Meta): boolean {
  const writesDeviceRoutines = Object.prototype.hasOwnProperty.call(meta, 'deviceRoutines');
  const writesDeviceConfig = Object.prototype.hasOwnProperty.call(meta, 'deviceConfig');
  const writesDeviceBrowser = Object.prototype.hasOwnProperty.call(meta, 'deviceBrowser');
  const writesDeviceFleet = Object.prototype.hasOwnProperty.call(meta, 'deviceFleet');
  const writesDeviceHosts = Object.prototype.hasOwnProperty.call(meta, 'deviceHosts');
  const writesDeviceAccounts = Object.prototype.hasOwnProperty.call(meta, 'deviceAccounts');
  const writesProjectRoot = Object.prototype.hasOwnProperty.call(meta, 'projectRoot');
  const { agents, isolatedAgents, versions, deviceRoutines, deviceConfig, deviceBrowser, deviceFleet, deviceHosts, deviceAccounts, projectRoot, ...central } = meta;

  const hasAgents = !!agents && Object.keys(agents).length > 0;
  const hasIsolatedAgents = !!isolatedAgents && Object.keys(isolatedAgents).length > 0;
  const pinsPath = getDevicePinsPath();
  if (hasAgents || hasIsolatedAgents) {
    const pins: { agents?: Meta['agents']; isolatedAgents?: Meta['isolatedAgents'] } = {};
    if (hasAgents) pins.agents = agents;
    if (hasIsolatedAgents) pins.isolatedAgents = isolatedAgents;
    fs.mkdirSync(path.dirname(pinsPath), { recursive: true });
    writeIfChanged(pinsPath, JSON.stringify(pins, null, 2) + '\n');
  } else if (fs.existsSync(pinsPath)) {
    writeIfChanged(pinsPath, '{}\n');
  }

  const devicePath = getDeviceMetaPath();
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(devicePath)) {
    try {
      const parsed = yaml.parse(fs.readFileSync(devicePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {  }
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
  const accountsHomes = deviceAccounts?.homes && Object.keys(deviceAccounts.homes).length > 0
    ? deviceAccounts.homes : undefined;
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

  const centralRecord = central as Record<string, unknown>;
  const onDiskCentralKeys = readCentralKeys();
  for (const k of Object.keys(centralRecord)) {
    if (metaKeyScope(k) !== 'device') continue;
    if (BESPOKE_DEVICE_KEY_SET.has(k)) continue;
    if (!KNOWN_META_KEYS.has(k) && onDiskCentralKeys.has(k)) continue;
    doc[k] = centralRecord[k];
    delete centralRecord[k];
  }

  if (Object.keys(doc).length > 0) {
    fs.mkdirSync(path.dirname(devicePath), { recursive: true });
    writeIfChanged(devicePath, META_HEADER + yaml.stringify(doc));
  } else if (fs.existsSync(devicePath)) {
    fs.rmSync(devicePath, { force: true });
    try {
      fs.rmdirSync(path.dirname(devicePath));
    } catch {  }
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
    } catch {  }
  }
  const devicePath = getDeviceMetaPath();
  if (fs.existsSync(devicePath)) {
    let dm: (Meta & { routines?: unknown; browser?: unknown }) | null = null;
    try {
      dm = yaml.parse(fs.readFileSync(devicePath, 'utf-8')) as Meta & {
        routines?: unknown;
        browser?: unknown;
      };
    } catch {  }
    if (dm) {
      if (dm?.agents) meta.agents = { ...dm.agents, ...meta.agents };
      if (dm?.isolatedAgents) meta.isolatedAgents = { ...dm.isolatedAgents, ...meta.isolatedAgents };
      if (typeof dm?.projectRoot === 'string') meta.projectRoot = dm.projectRoot;
      if (dm?.browser && typeof dm.browser === 'object' && !Array.isArray(dm.browser)) {
        meta.deviceBrowser = { ...meta.deviceBrowser, ...(dm.browser as Record<string, never>) };
      }
      if (dm?.config && typeof dm.config === 'object' && !Array.isArray(dm.config)) {
        meta.deviceConfig = { ...meta.deviceConfig, ...(dm.config as Record<string, unknown>) };
      }
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
    } catch {  }
  }
  return meta;
}

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
  }
}

export function readMeta(options: { migrate?: boolean } = {}): Meta {
  const migrate = options.migrate !== false;
  if (migrate) ensureAgentsDir();
  const remember = (meta: Meta): Meta => migrate ? rememberMeta(meta) : meta;

  if (migrate && metaCache) {
    if (currentMetaStamp() === metaCache.stamp) {
      return metaCache.meta;
    }
  }


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

      if (migrate) {
        withMetaLock(() => writeMetaUnlocked(meta));
        try { fs.unlinkSync(oldMetaFile); } catch {  }
      }
      return remember(meta);
    } catch {
    }
  }

  let systemMeta: Meta | null = null;
  let userMeta: Meta | null = null;

  if (fs.existsSync(SYSTEM_META_FILE)) {
    try {
      const content = fs.readFileSync(SYSTEM_META_FILE, 'utf-8');
      systemMeta = yaml.parse(content) as Meta;
    } catch {  }
  }

  if (fs.existsSync(META_FILE)) {
    try {
      const content = fs.readFileSync(META_FILE, 'utf-8');
      userMeta = yaml.parse(content) as Meta;
    } catch {  }
  }

  if (systemMeta || userMeta) {
    const base = createDefaultMeta();
    const meta: Meta = {
      ...base,
      ...systemMeta,
      ...userMeta,
      agents: { ...systemMeta?.agents, ...userMeta?.agents },
    };
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

export function writeMeta(meta: Meta): void {
  const centralChanged = withMetaLock(() => writeMetaUnlocked(meta));
  commitCentralConfigAfterWrite(centralChanged);
}

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

export function commitCentralConfigAfterWrite(centralChanged: boolean): void {
  if (centralChanged) commitCentralConfig(USER_AGENTS_DIR);
}

export function getPackageLocalPath(source: string): string {
  const sanitized = source
    .replace(/^gh:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\//g, '-');
  return path.join(PACKAGES_DIR, sanitized);
}


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

const EXTRA_ELIGIBLE_TYPES: readonly (keyof VersionResources)[] = [
  'commands', 'skills', 'hooks', 'subagents', 'plugins', 'workflows',
];

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

export function withoutAlias(list: ResourcePattern[], alias: string): ResourcePattern[] {
  const prefix = `${alias}:`;
  const next = list.filter(p => !(p.startsWith(prefix) || p.startsWith(`!${prefix}`)));
  return next.length === list.length ? list : next;
}

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

export function getActiveRulesPreset(agent: AgentId, version: string): string {
  const meta = readMeta();
  return meta.versions?.[agent]?.[version]?.rulesPreset || 'default';
}

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
