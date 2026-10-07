
import type { CloudProviderId } from './cloud/types.js';
import type { FeedBroadcastConfig } from './feed-broadcast.js';

export const AGENT_IDS = ['claude', 'codex', 'cursor', 'opencode', 'openclaw', 'copilot', 'amp', 'goose', 'antigravity', 'grok', 'kimi', 'droid', 'hermes', 'muse', 'warp'] as const;
export type AgentId = typeof AGENT_IDS[number];
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export type AccountAuthMode = 'native' | 'durable' | 'per-device';

export type AuthVerdictName =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
  | 'unconfigured'
  | 'error';

export interface DeviceAccountSlot {
  accountId: string;
  slotDir: string;
  authMode: AccountAuthMode;
  verdict: AuthVerdictName;
  checkedAt?: string;
  pending?: boolean;
}

export type AccountProvisioning = 'portable' | 'per-device';

export interface NativeAccountWorkerCredential {
  bundle: string;
  key: string;
  kind: 'setup-token' | 'api-key';
  mintedAt: string;
}

export interface NativeAccountRecord {
  id: string;
  name: string;
  agent: AgentId;
  identityKey: string;
  identityLabel?: string;
  scope: 'version' | 'device';
  workerCredential?: NativeAccountWorkerCredential;
  provisioning?: AccountProvisioning;
  createdOn?: string;
}

export type RunStrategy = 'pinned' | 'available' | 'balanced';

export type RunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export const RUN_AUTO_KEYWORD = 'auto';

export const RUN_AUTO_HOST_RESOLVED_ENV = 'AGENTS_RUN_AUTO_HOST_RESOLVED';

export const REMOTE_INTERACTIVE_ENV = 'AGENTS_REMOTE_INTERACTIVE';

export interface AgentRunConfig {
  strategy?: RunStrategy;
}

export interface RunDefaults {
  mode?: Mode;
  model?: string;
  effort?: RunEffort;
}

export type RunConfig = Partial<Record<AgentId, AgentRunConfig>> & {
  defaults?: Record<string, RunDefaults>;
};

export type BudgetOnExceed = 'block' | 'warn';

export interface BudgetConfig {
  currency?: string;
  per_run?: number;
  per_day?: number;
  per_agent?: Partial<Record<AgentId, number>>;
  per_project?: number;
  on_exceed?: BudgetOnExceed;
  require_confirm_over?: number;
}

export type BetaFeatureName = 'factory';

export type ChalkColor = 'magenta' | 'green' | 'blue' | 'cyan' | 'yellowBright' | 'redBright' | 'whiteBright' | 'blueBright' | 'greenBright' | 'magentaBright' | 'cyanBright';

export interface AgentConfig {
  id: AgentId;
  name: string;
  color: ChalkColor;
  cliCommand: string;
  npmPackage: string;
  installScript?: string;
  configDir: string;
  homeFiles?: string[];
  authFiles?: string[];
  commandsDir: string;
  commandsSubdir: string;
  skillsDir: string;
  nativeCommandRuntime?: boolean;
  hooksDir: string;
  pluginManifestDir?: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  nativePluginSkills?: boolean;
  ownedSkillDirs?: readonly string[];
  cloudProvider?: CloudProviderId;
  deprecated?: {
    by: string;
    date: string;
    reason: string;
    replacement?: AgentId;
    url?: string;
    hard?: boolean;
  };
  capabilities: {
    hooks: Capability;
    mcp: Capability;
    mcpHttp: Capability;
    mcpHeaders: Capability;
    allowlist: Capability;
    skills: Capability;
    commands: Capability;
    plugins: Capability;
    subagents: Capability;
    rules: RulesCapability;
    workflows: Capability;
    memory: Capability;
    modes: Mode[];
    headlessPlan?: boolean;
    rulesImports?: boolean;
    interactiveRepl?: Capability;
  };
}

export type Capability = boolean | { since?: string; until?: string };

export type RulesCapability = false | { file: string };

export type CapabilityName = 'hooks' | 'mcp' | 'mcpHttp' | 'mcpHeaders' | 'allowlist' | 'skills' | 'commands' | 'plugins' | 'subagents' | 'rules' | 'workflows' | 'memory' | 'interactiveRepl';
export type Mode = 'plan' | 'edit' | 'auto' | 'skip';

export const ALL_MODES: readonly Mode[] = ['plan', 'edit', 'auto', 'skip'] as const;

export type CapabilityFailReason = 'unsupported' | 'too_old' | 'too_new';

export type CapabilityResult =
  | { ok: true }
  | { ok: false; reason: CapabilityFailReason; need?: string };

export interface McpServerConfig {
  command?: string;
  url?: string;
  transport: 'stdio' | 'http' | 'sse';
  scope: 'user' | 'project';
  agents?: AgentId[];
  agentVersions?: Partial<Record<AgentId, string[]>>;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface HookConfig {
  name: string;
  script: string;
  dataFile?: string;
}

export interface HookMatches {
  prompt_contains?: string;
  prompt_matches?: string;
  tool_name?: string | string[];
  tool_args_match?: string;
  git_dirty?: boolean;
  cwd_includes?: string | string[];
  project_has?: string;
  /**
   * Permission modes the hook fires in (e.g. `plan`). Unlike the other
   * predicates this one is fail-open on absence: an input that carries no
   * permission_mode/permissionMode field passes, because only some harnesses
   * (Claude Code) report the live mode — an explicit non-listed value skips.
   */
  permission_mode?: string | string[];
  permission_mode_not?: string | string[];
}

export type HookCacheKey = 'global' | 'per-cwd' | 'per-session' | 'per-project';

export type HookCachePrefetch = 'none' | 'background';

export interface HookCacheConfig {
  ttl: number | string;
  key?: HookCacheKey;
  prefetch?: HookCachePrefetch;
}

export type HookCache = string | HookCacheConfig;

export interface ManifestHook {
  script: string;
  events: string[];
  timeout?: number;
  matcher?: string;
  /** @deprecated Use the agent capability table; field is ignored. */
  agents?: AgentId[];
  enabled?: boolean;
  override?: boolean;
  matches?: HookMatches;
  cache?: HookCache;
}

export interface HookResourceEntry {
  name: string;
  events: string[];
  timeout?: number;
  matcher?: string;
}

export interface InstalledHook {
  name: string;
  path: string;
  dataFile?: string;
  scope: 'user' | 'project';
  agent: AgentId;
}

export interface Manifest {
  agents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  budget?: BudgetConfig;
  beta?: {
    enabled?: BetaFeatureName[];
  };
  dependencies?: Record<string, string>;
  mcp?: Record<string, McpServerConfig>;
  defaults?: {
    method?: 'symlink' | 'copy';
    scope?: 'global' | 'project';
    agents?: AgentId[];
  };
}

export interface CommandInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

export interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  keywords?: string[];
  aliases?: string[];
}

export interface SkillInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

export interface SkillState {
  source: string;
  ruleCount: number;
  installations: Partial<Record<AgentId, SkillInstallation>>;
}

export interface InstalledSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  scope: 'user' | 'project';
  agent: AgentId;
}

export interface RepoInfo {
  source: string;
  branch: string;
  commit: string;
  lastSync: string;
}

export const DEFAULT_SYSTEM_REPO = 'gh:phnx-labs/.agents-system';

export function systemRepoSlug(repo: string = DEFAULT_SYSTEM_REPO): string {
  return repo.replace(/^gh:/, '').replace(/\.git$/, '');
}

export type RegistryType = 'mcp' | 'skill';

export interface RegistryConfig {
  url: string;
  enabled: boolean;
  apiKey?: string;
}

export const DEFAULT_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {
    official: {
      url: 'https://registry.modelcontextprotocol.io/v0',
      enabled: true,
    },
  },
  skill: {},
};

export const SEEDED_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {},
  skill: {
    hermes: {
      url: 'https://hermes-agent.nousresearch.com/docs/api/skills-index.json',
      enabled: true,
    },
  },
};

export interface McpPackage {
  registry_name: string;
  name: string;
  description?: string;
  runtime?: 'node' | 'python' | 'docker' | 'binary';
  transport?: 'stdio' | 'sse' | 'streamable-http';
  packageArguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpServerEntry {
  name: string;
  description?: string;
  repository?: {
    url: string;
    source?: string;
    directory?: string;
  };
  version_detail?: {
    version: string;
  };
  packages?: McpPackage[];
  _meta?: Record<string, unknown>;
}

export interface McpRegistryResponse {
  servers: Array<{ server: McpServerEntry }>;
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

export interface SkillEntry {
  name: string;
  description?: string;
  source: string;
  identifier?: string;
  repo?: string;
  path?: string;
  author?: string;
  installs?: number;
  tags?: string[];
  trustLevel?: string;
  sha256?: string;
}

export interface SkillRegistryResponse {
  skills: SkillEntry[];
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

export interface RegistrySearchResult {
  name: string;
  description?: string;
  type: 'mcp' | 'skill';
  source: string;
  registry: string;
  version?: string;
  installs?: number;
}

export interface ResolvedPackage {
  type: 'mcp' | 'skill' | 'git' | 'plugin';
  source: string;
  mcpEntry?: McpServerEntry;
  skillEntry?: SkillEntry;
  pluginSpec?: string;
}

export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins' | 'workflows';

export type ResourcePattern = string;

export interface VersionResources {
  rulesPreset?: string;
  skills?:      ResourcePattern[];
  commands?:    ResourcePattern[];
  hooks?:       ResourcePattern[];
  subagents?:   ResourcePattern[];
  plugins?:     ResourcePattern[];
  workflows?:   ResourcePattern[];
  permissions?: ResourcePattern[];
  mcp?:         ResourcePattern[];
}

export interface ResourceProfilePreset {
  description?: string;
  commands?: ResourcePattern[];
  skills?: ResourcePattern[];
  hooks?: ResourcePattern[];
  subagents?: ResourcePattern[];
  plugins?: ResourcePattern[];
  workflows?: ResourcePattern[];
  permissions?: ResourcePattern[];
  mcp?: ResourcePattern[];
  rules?: string;
  rulesPreset?: string;
  secrets?: string[];
}

export interface ResourceProfilesConfig {
  active?: string;
  presets?: Record<string, ResourceProfilePreset>;
}

export interface PluginUserConfigField {
  key: string;
  description: string;
  required?: boolean;
  default?: string;
}

export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  agents?: AgentId[];
  author?: string | { name: string; email?: string; url?: string };
  userConfig?: PluginUserConfigField[];
  dependencies?: string[];
  hooks?: unknown;
  mcpServers?: unknown;
}

export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  skills: string[];
  hooks: string[];
  scripts: string[];
  commands: string[];
  agentDefs: string[];
  workflows: string[];
  memory: string[];
  bin: string[];
  mcpServers: string[];
  lspServers: string[];
  monitors: string[];
  hasMcp: boolean;
  hasSettings: boolean;
  marketplace?: string;
  repoRoot: string;
  readonly snapshotSha: string | undefined;
}

export type MarketplaceSpec =
  | { kind: 'user' }
  | { kind: 'extra'; alias: string; root: string }
  | { kind: 'project'; root: string }
  | { kind: 'system'; root: string };

export interface DiscoveredMarketplace {
  spec: MarketplaceSpec;
  name: string;
  pluginsRoot: string;
  description: string;
}

export interface SubagentFrontmatter {
  name: string;
  description: string;
  model?: string;
  color?: string;
}

export interface DiscoveredSubagent {
  name: string;
  path: string;
  files: string[];
  agentMd: string;
  frontmatter: SubagentFrontmatter;
}

export interface InstalledSubagent {
  name: string;
  path: string;
  files: string[];
  frontmatter: SubagentFrontmatter;
}

export interface ExtraRepoConfig {
  url: string;
  path?: string;
  enabled: boolean;
}

export interface BrandConfig {
  name: string;
  disabledCommands?: string[];
  profile?: string;
  enabled: boolean;
}

export interface ActorConfig {
  kind?: 'human' | 'agent';
  name?: string;
  email?: string;
  github?: string;
  login?: string;
  phoenixId?: string;
}

export interface Meta {
  accounts?: {
    defaults?: Partial<Record<AgentId, string>>;
    native?: Record<string, NativeAccountRecord>;
    bindings?: Record<string, string>;
  };
  deviceAccounts?: {
    native?: Record<string, NativeAccountRecord>;
    bindings?: Record<string, string>;
    homes?: Record<string, string>;
    pendingConnects?: Record<string, string>;
    slots?: Record<string, DeviceAccountSlot>;
  };
  agents?: Partial<Record<AgentId, string>>;
  isolatedAgents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  model?: {
    tiers?: Record<string, Partial<Record<'cheap' | 'default' | 'best' | 'ultra', string>>>;
  };
  watchdog?: {
    rotate?: 'on' | 'off';
  };
  lease?: {
    secretsBundle?: string;
  };
  secrets?: {
    backend?: 'keychain' | 'file' | 'vault';
    policy?: 'always' | 'hold' | 'daily';
    agent?: {
      auto?: boolean;
      holdMs?: number;
      durable?: boolean;
    };
  };
  budget?: BudgetConfig;
  feed?: {
    broadcast?: FeedBroadcastConfig;
  };
  beta?: {
    enabled?: BetaFeatureName[];
  };
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  profiles?: ResourceProfilesConfig;
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  source?: string;
  projectRoot?: string;
  extraRepos?: Record<string, ExtraRepoConfig>;
  brands?: Record<string, BrandConfig>;
  actors?: Record<string, ActorConfig>;
  seededPresets?: string[];
  hooks?: Record<string, ManifestHook>;
  deviceBrowser?: Record<string, BrowserProfileConfig>;
  config?: Record<string, unknown>;
  deviceRoutines?: string[];
  deviceConfig?: Record<string, unknown>;
  hosts?: Record<string, HostEntry>;
  deviceHosts?: Record<string, HostEntry>;
  fleet?: import('./fleet/types.js').FleetManifest;
  deviceFleet?: {
    discovery?: Record<string, 'approved' | 'ignored'>;
    ignored?: import('./fleet/types.js').IgnoredDeviceEntry[];
  };
  share?: {
    baseUrl?: string;
    accountId?: string;
    workerName?: string;
    bucketName?: string;
    domain?: string;
    analyticsToken?: string;
    templateHash?: string;
  };
  notify?: {
    transports?: Record<string, string>;
  };
}


export interface HostEntry {
  source: 'ssh-config' | 'inline';
  address?: string;
  user?: string;
  identityFile?: string;
  os?: string;
  caps?: string[];
  addedAt?: string;
}

export interface BrowserProfileConfig {
  description?: string;
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'firefox' | 'custom';
  binary?: string;
  electron?: boolean;
  targetFilter?: string;
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
  defaultEndpoint?: string;
  launchPolicy?: 'attach-only' | 'launch';
  userDataDir?: string;
  profileDirectory?: string;
  chrome?: {
    headless?: boolean;
    args?: string[];
  };
  secrets?: string;
  viewport?: { width: number; height: number };
  logDir?: string;
  logHost?: string;
  arc?: {
    profileId: string;
    profileName: string;
    spaceId: string;
    spaceTitle: string;
  };
  firefox?: {
    profileName: string;
    iniPath: string;
    isDefault: boolean;
  };
}

export interface SyncOptions {
  agents?: AgentId[];
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  skipClis?: boolean;
  skipMcp?: boolean;
}

export interface PermissionSet {
  name: string;
  description?: string;
  allow: string[];
  deny?: string[];
  additionalDirectories?: string[];
}

export interface InstalledPermission {
  name: string;
  path: string;
  set: PermissionSet;
}

export interface ClaudePermissions {
  permissions: {
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
  };
}

export interface CursorPermissions {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface OpenCodePermissions {
  permission: {
    bash: Record<string, 'allow' | 'deny' | 'ask'>;
  };
}

export interface CodexPermissions {
  approval_policy?: 'on-request' | 'on-failure' | 'never';
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandbox_workspace_write?: {
    network_access?: boolean;
    writable_roots?: string[];
  };
}
