/** Core type definitions for agents-cli: every data structure flowing between modules. */

import type { CloudProviderId } from './cloud/types.js';
import type { FeedBroadcastConfig } from './feed-broadcast.js';

/** Unique identifier for a current or legacy AI coding agent. */
export const AGENT_IDS = ['claude', 'codex', 'cursor', 'opencode', 'openclaw', 'copilot', 'amp', 'goose', 'antigravity', 'grok', 'kimi', 'droid', 'hermes', 'muse', 'warp'] as const;
export type AgentId = typeof AGENT_IDS[number];
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** How this box authenticates one account slot (PHNX-3940): native OAuth on the headed device, a
 * durable credential on workers, per-box login for per-device harnesses. */
export type AccountAuthMode = 'native' | 'durable' | 'per-device';

/** Live auth verdict vocabulary, mirroring `lib/auth-health.ts`; duplicated to avoid importing the
 * probe. */
export type AuthVerdictName =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
  | 'unconfigured'
  | 'error';

/** Per-(account, device) slot, kept in the device doc, never the fleet-synced file (paths are per
 * box). */
export interface DeviceAccountSlot {
  accountId: string;
  /** `~/.agents/.history/accounts/<harness>/<accountId>/` — HOME-shaped, no binary. */
  slotDir: string;
  authMode: AccountAuthMode;
  verdict: AuthVerdictName;
  checkedAt?: string;
  /** Onboarding in flight; cleared once the account row is registered. */
  pending?: boolean;
}

/** Whether a worker can be provisioned from a durable credential, or must log in per box. */
export type AccountProvisioning = 'portable' | 'per-device';

/** Pointer to the durable worker credential in a reserved store; never the secret itself. */
export interface NativeAccountWorkerCredential {
  bundle: string;
  key: string;
  kind: 'setup-token' | 'api-key';
  mintedAt: string;
}

/** Fleet-synced native-account row; account-model v2 fields (PHNX-3940) are additive, absent on old
 * rows. */
export interface NativeAccountRecord {
  id: string;
  name: string;
  agent: AgentId;
  identityKey: string;
  identityLabel?: string;
  scope: 'version' | 'device';
  workerCredential?: NativeAccountWorkerCredential;
  provisioning?: AccountProvisioning;
  /** Device that minted this row (the headed origin). */
  createdOn?: string;
}

/** How `agents run <agent>` chooses an installed version when none is pinned. */
export type RunStrategy = 'pinned' | 'available' | 'balanced';

export type RunEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

/** Reserved `<agent>` keyword for `agents run auto`: host affinity, then harness, then account.
 * Lives in lib because exec.ts and hosts/dispatch.ts must agree on it. */
export const RUN_AUTO_KEYWORD = 'auto';

/** Env var exported into the remote shell for `agents run auto` so it does not re-run affinity and
 * hop again. It rides the shell prelude because `--env` reaches only the spawned agent. */
export const RUN_AUTO_HOST_RESOLVED_ENV = 'AGENTS_RUN_AUTO_HOST_RESOLVED';

/** Env var exported for an interactive `--device` run: stdio is a network link, so detach (tmux).
 * Interactive only; a headless dispatch is already detached by `launchDetached`. */
export const REMOTE_INTERACTIVE_ENV = 'AGENTS_REMOTE_INTERACTIVE';

/** Per-agent run strategy config. */
export interface AgentRunConfig {
  strategy?: RunStrategy;
}

/** Default launch options applied by `agents run` when flags are omitted. */
export interface RunDefaults {
  mode?: Mode;
  model?: string;
  effort?: RunEffort;
}

/** `run:` section in agents.yaml. Agent keys keep strategy; `defaults` stores selector rules. */
export type RunConfig = Partial<Record<AgentId, AgentRunConfig>> & {
  defaults?: Record<string, RunDefaults>;
};

/** Action when a budget cap would be exceeded (#346): `block` refuses/kills and exits non-zero;
 * `warn` prints the overrun and proceeds. */
export type BudgetOnExceed = 'block' | 'warn';

/** `budget:` in agents.yaml: cross-vendor spend guardrails (#346), project > user, caps in USD. Only
 * set caps are enforced; `per_agent` is one agent, the rest aggregate across vendors. */
export interface BudgetConfig {
  /** Display currency. Only "USD" is priced today; carried for forward-compat. */
  currency?: string;
  /** Hard cap on the estimated/actual cost of a single run. */
  per_run?: number;
  /** Hard cap on total spend attributed to the current day (local date). */
  per_day?: number;
  /** Per-agent daily caps, keyed by agent id (e.g. { claude: 30, codex: 20 }). */
  per_agent?: Partial<Record<AgentId, number>>;
  /** Hard cap on cumulative spend attributed to the current project. */
  per_project?: number;
  /** block (refuse/kill) or warn (proceed). Defaults to block. */
  on_exceed?: BudgetOnExceed;
  /** Confirm threshold (USD): at or above this pre-flight estimate, prompt unless --yes. Never
   * relaxes a hard cap block. */
  require_confirm_over?: number;
}

/** Preview features that users can opt into via `agents setup beta`. */
export type BetaFeatureName = 'factory';

/** Subset of chalk color names used for agent-specific terminal output. */
export type ChalkColor = 'magenta' | 'green' | 'blue' | 'cyan' | 'yellowBright' | 'redBright' | 'whiteBright' | 'blueBright' | 'greenBright' | 'magentaBright' | 'cyanBright';

/** Static configuration for a single agent -- paths, capabilities, and format conventions. */
export interface AgentConfig {
  id: AgentId;
  name: string;
  color: ChalkColor;
  cliCommand: string;
  npmPackage: string;
  installScript?: string;
  configDir: string;
  homeFiles?: string[]; // Files at $HOME level that need per-version symlink switching (e.g., '.claude.json')
  authFiles?: string[]; // Credential files inside configDir (relative to it) that must be carried across version-homes on switch so sign-in survives version changes (e.g., droid 'auth.v2.file'). Account-global, not version-specific.
  commandsDir: string;
  commandsSubdir: string;
  skillsDir: string;
  /** Agent resolves slash-commands itself (e.g. openclaw), so commands must not be converted to
   * skills. Set to opt a skills-capable agent without a command dir out of conversion. */
  nativeCommandRuntime?: boolean;
  hooksDir: string;
  /** Dir under a plugin where the agent reads its manifest if not `.claude-plugin/`
   * (`.codex-plugin`, `.factory-plugin`, `.` for Copilot); syncPluginToVersion mirrors
   * `plugin.json` there. */
  pluginManifestDir?: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  /** The harness loads plugin skills itself, namespaced `<plugin>:<skill>`; sync must not also
   * flatten them into `skills/`, which listed every plugin skill twice (`/continue`,
   * `/sessions:continue`). */
  nativePluginSkills?: boolean;
  /** Dirs under `skills/` the harness itself writes (Claude's `synced`); sweeps must never remove
   * them. */
  ownedSkillDirs?: readonly string[];
  /** This agent's own cloud backend: `agents cloud run --agent` routes here without `--provider`
   * (--provider > this > cloud.default_provider > rush). Undefined means no native cloud. */
  cloudProvider?: CloudProviderId;
  /** Set when the vendor retired this CLI: warning-only stays manageable; hard stays parseable but
   * is excluded from install/import/sync. `replacement` names the successor. */
  deprecated?: {
    /** Vendor that retired it, e.g. "Google". */
    by: string;
    /** Human date it stopped working / was retired, e.g. "June 18, 2026". */
    date: string;
    /** One-line explanation shown under the warning header. */
    reason: string;
    /** Successor agent id to suggest instead (e.g. 'antigravity'). */
    replacement?: AgentId;
    /** Announcement URL for the deprecation. */
    url?: string;
    /** Hard-deprecated agents are retained only for legacy reads. */
    hard?: boolean;
  };
  capabilities: {
    hooks: Capability;
    mcp: Capability;
    /** Whether `mcp add --transport http` works; false for stdio-only agents (registration skips
     * with a reason). */
    mcpHttp: Capability;
    /** Whether HTTP-MCP registration accepts `--header`; only Claude's CLI does today. */
    mcpHeaders: Capability;
    allowlist: Capability;
    skills: Capability;
    commands: Capability;
    plugins: Capability;
    subagents: Capability;
    rules: RulesCapability;
    workflows: Capability;
    /** Portable knowledge-store memory (`agents memory`), distinct from `rules`; sync fans facts
     * into the home. */
    memory: Capability;
    /** Permission modes natively supported; others are gated by buildExecCommand (`auto` degrades to
     * `edit`, `skip` errors). */
    modes: Mode[];
    /** Whether `plan` works headless; kimi refuses `--prompt` with `--plan`, grok stalls at
     * ExitPlanMode. Absent means true; `false` downgrades headless `--mode plan` to `auto`. */
    headlessPlan?: boolean;
    /** Whether the agent natively resolves `@path` imports in its rules file; if not, sync
     * pre-compiles it. */
    rulesImports?: boolean;
    /** Whether a bare invocation opens a REPL; agents that exit without a prompt (cursor-agent) say
     * `false`. The `auto` picker uses it to avoid such harnesses (RUSH-2185, EXEC-23a). */
    interactiveRepl?: Capability;
  };
}

/** Capability flag: `true` on every version, `false` never; the object form gates by semver (`since`
 * minimum, `until` exclusive upper bound). */
export type Capability = boolean | { since?: string; until?: string };

/** Rules sync writes one composed instructions file per supported agent. */
export type RulesCapability = false | { file: string };

/** Names of every gateable capability on AgentConfig. */
export type CapabilityName = 'hooks' | 'mcp' | 'mcpHttp' | 'mcpHeaders' | 'allowlist' | 'skills' | 'commands' | 'plugins' | 'subagents' | 'rules' | 'workflows' | 'memory' | 'interactiveRepl';
/** Permission modes: plan (read-only), edit (prompts on risky shell), auto (classifier), skip
 * (bypass). `full` is a permanent silent alias of `skip` (normalizeMode); support is in
 * capabilities.modes. */
export type Mode = 'plan' | 'edit' | 'auto' | 'skip';

/** Every canonical mode in declaration order. Useful for iteration / validation. */
export const ALL_MODES: readonly Mode[] = ['plan', 'edit', 'auto', 'skip'] as const;

/** Reason a capability check failed. */
export type CapabilityFailReason = 'unsupported' | 'too_old' | 'too_new';

/** Result of `supports(agent, cap, version?)`. */
export type CapabilityResult =
  | { ok: true }
  | { ok: false; reason: CapabilityFailReason; need?: string };

/** Configuration for a single MCP server as stored in ~/.agents/mcp/. */
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

/** User-facing hook definition (name + script path). */
export interface HookConfig {
  name: string;
  script: string;
  dataFile?: string;
}

/** Predicates for when a hook fires within its event; all AND together; empty always fires. */
export interface HookMatches {
  prompt_contains?: string;          // substring of user prompt
  prompt_matches?: string;           // regex applied to user prompt
  tool_name?: string | string[];     // PreToolUse / PostToolUse only
  tool_args_match?: string;          // regex on serialized tool args
  git_dirty?: boolean;               // working tree has changes
  cwd_includes?: string | string[];  // cwd contains any of these substrings
  project_has?: string;              // project root contains this file
  /** Modes the hook fires in. Fail-open on absence: an input with no mode field passes, since only
   * some harnesses report the live mode. */
  permission_mode?: string | string[];
  /** Modes the hook must not fire in; the inverse of `permission_mode`, which would otherwise break
   * when a harness adds a mode. Same fail-open rule when no mode field is present. */
  permission_mode_not?: string | string[];
}

/** Cache scoping: `global` (one file per hook), `per-cwd`, `per-session` (session_id from stdin),
 * `per-project` (nearest git root). */
export type HookCacheKey = 'global' | 'per-cwd' | 'per-session' | 'per-project';

/** Prefetch strategy when the cache is stale. */
export type HookCachePrefetch = 'none' | 'background';

/** Full hook cache config; authors usually use the `HookCache` shorthand (`5m`, `5m-bg`). Fields:
 * ttl, key (global/per-cwd/...), prefetch (none/background). */
export interface HookCacheConfig {
  /** TTL in seconds or duration string ("30s", "5m", "1h"). */
  ttl: number | string;
  key?: HookCacheKey;
  prefetch?: HookCachePrefetch;
}

/** Cache shorthand: duration string, optionally suffixed `-bg` for background prefetch. */
export type HookCache = string | HookCacheConfig;

/** Hook entry as declared in a package manifest (agents.yaml). */
export interface ManifestHook {
  script: string;
  events: string[];
  /** Seconds before the hook is killed (default 600); a number or duration string (`5s`, `1h30m`)
   * that `parseHookManifest` normalizes to seconds. */
  timeout?: number;
  matcher?: string;
  /** @deprecated Use the agent capability table; field is ignored. */
  agents?: AgentId[];
  /** Set to false in user hooks.yaml to disable a system-shipped hook. */
  enabled?: boolean;
  /** Set true on user hooks that intentionally shadow system-shipped hooks. */
  override?: boolean;
  /** Optional pre-filter predicates evaluated before invoking the script. */
  matches?: HookMatches;
  /** Opt-in caching: the registrar registers a generated per-hook shim (cache lookup,
   * stale-while-revalidate, timing/logging) instead of the raw script, which is unchanged. */
  cache?: HookCache;
}

/** Lightweight hook descriptor used in resource listings. */
export interface HookResourceEntry {
  name: string;
  events: string[];
  timeout?: number;
  matcher?: string;
}

/** A hook that has been synced into a specific agent version's config. */
export interface InstalledHook {
  name: string;
  path: string;
  dataFile?: string;
  scope: 'user' | 'project';
  agent: AgentId;
}

/** Package manifest (agents.yaml) found inside a cloned config repo or package. */
export interface Manifest {
  agents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  /** Spend guardrails (issue #346). Project-local block overrides user. */
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

/** Record of how a slash command was installed into an agent version. */
export interface CommandInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

/** Metadata parsed from a SKILL.md frontmatter block. */
export interface SkillMetadata {
  name: string;
  description: string;
  author?: string;
  version?: string;
  license?: string;
  keywords?: string[];
  /** Alternate names this skill also resolves under (frontmatter `aliases:`). */
  aliases?: string[];
}

/** Record of how a skill was installed into an agent version. */
export interface SkillInstallation {
  path: string;
  method: 'symlink' | 'copy';
}

/** Tracked state for a skill across all agent versions it's been synced to. */
export interface SkillState {
  source: string;
  ruleCount: number;
  installations: Partial<Record<AgentId, SkillInstallation>>;
}

/** A skill that has been synced into a specific agent version's config. */
export interface InstalledSkill {
  name: string;
  path: string;
  metadata: SkillMetadata;
  ruleCount: number;
  scope: 'user' | 'project';
  agent: AgentId;
}

/** Git remote metadata for the ~/.agents/.system/ config repository. */
export interface RepoInfo {
  source: string;
  branch: string;
  commit: string;
  lastSync: string;
}

/** Canonical system repo cloned into ~/.agents/.system/. */
export const DEFAULT_SYSTEM_REPO = 'gh:phnx-labs/.agents-system';

/** Strip the `gh:` prefix and `.git` suffix to get a GitHub `owner/repo` slug. */
export function systemRepoSlug(repo: string = DEFAULT_SYSTEM_REPO): string {
  return repo.replace(/^gh:/, '').replace(/\.git$/, '');
}

/** Kind of package that can be searched and installed from a registry. */
export type RegistryType = 'mcp' | 'skill';

/** Connection details for a single package registry endpoint. */
export interface RegistryConfig {
  url: string;
  enabled: boolean;
  apiKey?: string;
}

/** Built-in registry endpoints shipped with agents-cli. */
export const DEFAULT_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {
    official: {
      url: 'https://registry.modelcontextprotocol.io/v0',
      enabled: true,
    },
  },
  skill: {},
};

/** Third-party registries pre-seeded once on first install; afterwards they behave like user-added
 * ones, and `agents registry remove <name>` opts out permanently. */
export const SEEDED_REGISTRIES: Record<RegistryType, Record<string, RegistryConfig>> = {
  mcp: {},
  skill: {
    // Hermes Agent (Nous Research) — flat JSON index of 1800+ skills aggregated
    // from official, github, lobehub, skills.sh, and claude-marketplace. No auth.
    hermes: {
      url: 'https://hermes-agent.nousresearch.com/docs/api/skills-index.json',
      enabled: true,
    },
  },
};

/** A single installable package within an MCP server entry. */
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

/** A server listing returned by the MCP registry API. */
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

/** Paginated response from the MCP registry search endpoint. */
export interface McpRegistryResponse {
  servers: Array<{ server: McpServerEntry }>;
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

/** A skill listing returned by a skill registry API. */
export interface SkillEntry {
  name: string;
  description?: string;
  /** Upstream catalog (e.g. 'official', 'github', 'lobehub', 'skills.sh'). */
  source: string;
  /** Stable unique id used by the registry (e.g. 'official/security/1password'). */
  identifier?: string;
  /** Origin repo in 'owner/repo' form. Empty for registry-hosted catalogs. */
  repo?: string;
  path?: string;
  author?: string;
  installs?: number;
  tags?: string[];
  /** Registry-specific trust signal (e.g. 'builtin', 'trusted', 'community'). */
  trustLevel?: string;
  /** Lowercase hex sha256 of the skill's SKILL.md from the registry index; install aborts on
   * mismatch. */
  sha256?: string;
}

/** Paginated response from a skill registry search endpoint. */
export interface SkillRegistryResponse {
  skills: SkillEntry[];
  metadata?: {
    count: number;
    next_cursor?: string;
  };
}

/** Provider-agnostic search result that merges MCP and skill registries. */
export interface RegistrySearchResult {
  name: string;
  description?: string;
  type: 'mcp' | 'skill';
  source: string;
  registry: string;
  version?: string;
  installs?: number;
}

/** A package that has been resolved from a registry and is ready to install. */
export interface ResolvedPackage {
  /** `plugin` is Phase 5 packaging: `agents install plugin:<spec>` → plugins install. */
  type: 'mcp' | 'skill' | 'git' | 'plugin';
  source: string;
  mcpEntry?: McpServerEntry;
  skillEntry?: SkillEntry;
  /** Plugin install spec (`name@url`, path, or bare source) when `type === 'plugin'`. */
  pluginSpec?: string;
}

/** Categories of resources that can be synced into an agent version home. */
export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins' | 'workflows';

/** Resource selection pattern in agents.yaml `versions`: `<repo>:*` (system, user, extra alias,
 * project), `<repo>:name` for one resource, and a leading `!` to exclude. */
export type ResourcePattern = string;

/** Sync specification for a specific agent@version, keyed by resource type. */
export interface VersionResources {
  /**
   * Active rule preset. Absent/null means "default".
   */
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

/** Resource-kind selectors controlled by top-level resource profiles. */
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
  /** Rule preset name to compose while this profile is active. */
  rules?: string;
  /** Alias for rules, accepted so YAML can mirror VersionResources naming. */
  rulesPreset?: string;
  /** Secrets bundle names, or "*" for every bundle. */
  secrets?: string[];
}

/** Top-level profiles/presets that switch the resolved resource view. */
export interface ResourceProfilesConfig {
  active?: string;
  presets?: Record<string, ResourceProfilePreset>;
}

/** A userConfig field declared in a plugin manifest. */
export interface PluginUserConfigField {
  key: string;
  description: string;
  required?: boolean;
  default?: string;
}

/** Manifest file (plugin.json) at the root of a plugin bundle. */
export interface PluginManifest {
  name: string;
  description: string;
  version: string;
  agents?: AgentId[];
  /** Who published the plugin, per the official format (string or object); previously untyped. */
  author?: string | { name: string; email?: string; url?: string };
  /** Interactive config fields prompted at install time. Values stored in .user-config.json. */
  userConfig?: PluginUserConfigField[];
  /** Other plugin names this plugin depends on. Missing deps produce a warning. */
  dependencies?: string[];
  /** Inline hook config (or a path to a hooks JSON file) in the manifest; an execution surface even
   * with no `hooks/` dir. Untyped: capability detection only checks it is non-empty. */
  hooks?: unknown;
  /** Inline MCP-server config (or path to an MCP JSON file) in the manifest; an execution surface
   * even with no `.mcp.json`. Untyped like `hooks`. */
  mcpServers?: unknown;
}

/** A plugin found on disk with its parsed manifest and resource inventory. */
export interface DiscoveredPlugin {
  name: string;
  root: string;
  manifest: PluginManifest;
  skills: string[];
  hooks: string[];
  scripts: string[];
  /** Slash-command .md files in the plugin's commands/ directory (names without extension). */
  commands: string[];
  /** Subagent .md files in the plugin's agents/ directory (names without extension). */
  agentDefs: string[];
  /** Workflow dir names under `workflows/` (each needs WORKFLOW.md); `agents run <name>` resolves
   * them project > user > plugin > extra > system. */
  workflows: string[];
  /** Memory fact basenames from the plugin's memory/ directory (without .md). */
  memory: string[];
  /** Executable files in the plugin's bin/ directory. */
  bin: string[];
  /** MCP server names parsed from .mcp.json. */
  mcpServers: string[];
  /** LSP server keys parsed from .lsp.json. */
  lspServers: string[];
  /** Monitor names parsed from monitors/monitors.json. */
  monitors: string[];
  /** Whether the plugin root contains a .mcp.json file. */
  hasMcp: boolean;
  /** Whether the plugin root contains a settings.json with non-permission keys to merge. */
  hasSettings: boolean;
  /** Marketplace the plugin was found in ("agents-cli", "agents-<alias>", "agents-project"); absent
   * on hand-built plugins, which default to the user marketplace on sync. */
  marketplace?: string;
  /** Absolute path to the DotAgents repo root containing this plugin (grandparent of `root`); the
   * repo is git-tracked, so this pairs with `snapshotSha`. */
  repoRoot: string;
  /** Short HEAD sha of `repoRoot`, lazily resolved and memoized (`git.ts` `resolveSnapshotSha`);
   * `undefined` when not a git repo. */
  readonly snapshotSha: string | undefined;
}

/** One DotAgents repo contributing a marketplace: user (`~/.agents/plugins/`, "agents-cli"), extra
 * ("agents-<alias>"), project ("agents-project"); `root` is the repo's plugins/ dir. */
export type MarketplaceSpec =
  | { kind: 'user' }
  | { kind: 'extra'; alias: string; root: string }
  | { kind: 'project'; root: string }
  | { kind: 'system'; root: string };

/** A marketplace found on the source side, before per-version sync. */
export interface DiscoveredMarketplace {
  spec: MarketplaceSpec;
  /** e.g. "agents-cli", "agents-extras", "agents-project". */
  name: string;
  /** Absolute path to the source plugins/ directory on disk. */
  pluginsRoot: string;
  /** Human description embedded in the synthesized catalog. */
  description: string;
}

/** Frontmatter fields parsed from a subagent's agent.md file. */
export interface SubagentFrontmatter {
  name: string;
  description: string;
  model?: string;
  color?: string;
}

/** A subagent definition found in ~/.agents/subagents/. */
export interface DiscoveredSubagent {
  name: string;
  path: string;
  files: string[];
  agentMd: string;
  frontmatter: SubagentFrontmatter;
}

/** A subagent that has been synced into a specific agent version's config. */
export interface InstalledSubagent {
  name: string;
  path: string;
  files: string[];
  frontmatter: SubagentFrontmatter;
}

/** Extra DotAgent repo as user-level config: managed clone at `~/.agents-<alias>/` or any `path`.
 * `~/.agents/` wins name collisions; extras are searched in insertion order. */
export interface ExtraRepoConfig {
  url: string;
  path?: string;
  enabled: boolean;
}

/** A white-label brand: a personally-named CLI that is agents-cli (`agents setup mine`); its shim
 * exports `AGENTS_BRAND=<name>`. Portable config, rides `agents repo push/pull`. See lib/brand.ts. */
export interface BrandConfig {
  /** The brand name; also the binary name on PATH. */
  name: string;
  /** Built-in top-level commands this brand hides/disables (e.g. `["teams"]`). */
  disabledCommands?: string[];
  /** Resource-profile preset this brand pins (a key in `profiles.presets`); defaults to
   * `mine-<name>`. */
  profile?: string;
  /** False to keep the config but stop minting/using the brand. */
  enabled: boolean;
}

/** An actor behind a run, keyed by slug; all fields enrich what `tailscale whois` resolves. `login`
 * is the tailnet login to match (defaults to the key). See lib/actor.ts. */
export interface ActorConfig {
  /** 'human' (default) or 'agent'. Only humans get personal git credit. */
  kind?: 'human' | 'agent';
  /** Display + git author name. Overrides the tailnet DisplayName. */
  name?: string;
  /** Git author email. Overrides the tailnet login email. */
  email?: string;
  /** GitHub handle, for PR attribution. */
  github?: string;
  /** Tailnet login-name this entry matches. Defaults to the map key. */
  login?: string;
  /** Phoenix (work) identity id, bridging a tailnet login to the stable work identity for
   * attribution. */
  phoenixId?: string;
}

/** Top-level structure of ~/.agents/.system/agents.yaml -- the CLI's persistent state. */
export interface Meta {
  /** Preferred provider account per harness. Explicit --account wins. */
  accounts?: {
    defaults?: Partial<Record<AgentId, string>>;
    /** Named harness-owned identities. Metadata only; OAuth credentials stay in the harness home. */
    native?: Record<string, NativeAccountRecord>;
    /** Exact installation/custom-harness target -> stable account id. */
    bindings?: Record<string, string>;
  };
  /** Device-scoped slice of `Meta.accounts`, in the device agents.yaml (PHNX-3315): this box's
   * `scope: 'device'` identities, so a per-box login no longer rewrites the shared file. Only this
   * machine writes it. */
  deviceAccounts?: {
    native?: Record<string, NativeAccountRecord>;
    bindings?: Record<string, string>;
    /** This box's leftover account-to-home map (PHNX-3940): `acct-*` labels from the retired
     * connect verb. Device-scoped (never the synced central row); `nativeAccountHome` reads it. */
    homes?: Record<string, string>;
    /** Leftover in-flight connect map from the retired verb (PHNX-3940); kept so older device docs
     * load. */
    pendingConnects?: Record<string, string>;
    /** This box's account slots (PHNX-3940): HOME-shaped dirs under `~/.agents/.history/accounts/`.
     * Device-local so native OAuth files never leave the box; replaces `homes` as spawn-time HOME. */
    slots?: Record<string, DeviceAccountSlot>;
  };
  agents?: Partial<Record<AgentId, string>>;
  /** Per-agent preferred isolated version for a bare `agents run <agent>` with no global default.
   * Kept apart from `agents`: a global default owns the launcher and shim, which an isolated copy
   * must not. */
  isolatedAgents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  /** Cost-tier overrides for `--model cheap|default|best|ultra`, keyed by `<agent>:<version>`,
   * written by `agents models tier set`. Exact version beats `<agent>:*` beats auto-ranking. */
  model?: {
    tiers?: Record<string, Partial<Record<'cheap' | 'default' | 'best' | 'ultra', string>>>;
  };
  /** Daemon watchdog config: `rotate` (default `on`) rotates a rate-limited session in place via
   * `agents run auto` (lib/watchdog/rotate.ts); `off` keeps nudge-only. */
  watchdog?: {
    rotate?: 'on' | 'off';
  };
  /** `agents run --lease` config: `secretsBundle` names the keychain bundle with the provider token
   * (e.g. `HCLOUD_TOKEN`); unset uses `AGENTS_LEASE_SECRETS_BUNDLE`, then auto-detect. */
  lease?: {
    secretsBundle?: string;
  };
  /** macOS secrets-agent: `policy` default `hold` asks once per `holdMs` window (7d, clamped 1
   * min-30 d), `always` every time; `auto` lets the first read populate the broker; `durable`
   * survives sleep/reboot. */
  secrets?: {
    /** Default storage backend used when `agents secrets create/import` create a
     * new bundle without `--backend` or `--synced`. */
    backend?: 'keychain' | 'file' | 'vault';
    /** Default prompt policy. `hold` (the default) holds a bundle for
     * `agent.holdMs`; `daily`/`session` are accepted aliases kept so an existing
     * agents.yaml keeps working. See SecretsPolicy in lib/secrets/bundles.ts. */
    policy?: 'always' | 'hold' | 'daily';
    agent?: {
      auto?: boolean;
      holdMs?: number;
      durable?: boolean;
    };
  };
  /** Spend guardrails (issue #346). User-global caps; project agents.yaml overrides. */
  budget?: BudgetConfig;
  /** `agents feed post` fan-out: `broadcast` maps a sink to an argv `command:` or a `channel:`
   * delivery; a missing `message:` placeholder skips that sink. Unset: important posts go to
   * `notify.owner` (RUSH-2123). */
  feed?: {
    broadcast?: FeedBroadcastConfig;
  };
  beta?: {
    enabled?: BetaFeatureName[];
  };
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  /** Top-level resource profiles: activating one filters commands, skills, hooks, rules, MCP,
   * permissions and secrets. Model-provider run profiles are separate YAML under profiles/. */
  profiles?: ResourceProfilesConfig;
  // Per-version resource tracking
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  // Git remote source URL (when ~/.agents/.system/ is a git repo)
  source?: string;
  /** Projects root for `agents run --project <slug>`; auto-inferred, cached home-relative (`~/...`)
   * so it resolves on remote hosts. */
  projectRoot?: string;
  /** Extra DotAgent repos merged after `~/.agents/`: managed clones at `~/.agents-<alias>/` or any
   * `path`. */
  extraRepos?: Record<string, ExtraRepoConfig>;
  /** White-label brands keyed by name, each a personally-named binary with its own disabled commands
   * and curated profile. See lib/brand.ts. */
  brands?: Record<string, BrandConfig>;
  /** Actors keyed by slug (who is behind a run); overrides what `tailscale whois` resolves. See
   * lib/actor.ts. */
  actors?: Record<string, ActorConfig>;
  /** Removal tombstones for SEEDED_REGISTRIES (key like `skill.hermes`). Seeds resolve in memory,
   * not into agents.yaml: persisting them dirtied the tracked file and deadlocked `agents repo
   * pull` (RUSH-1925). */
  seededPresets?: string[];
  /** Hook manifest entries keyed by hook name, folded into agents.yaml so there is one file to sync. */
  hooks?: Record<string, ManifestHook>;
  /** Browser profiles declared by this machine (`browser:` in the device agents.yaml); fleet view is
   * the union. */
  deviceBrowser?: Record<string, BrowserProfileConfig>;
  /** User-scope config block (`config:` in central agents.yaml), synced fleet-wide; device-scope
   * keys live in the per-device doc over `fleet.defaults.config`. Keys: lib/device-config.ts. */
  config?: Record<string, unknown>;
  /** Routine names enabled on this machine (top-level `routines:` in the device doc); absent means
   * disabled. */
  deviceRoutines?: string[];
  /** Machine-local operator config (device-scope keys with `visibility` `machine`), in the
   * gitignored device doc. Keeps them out of the shared file: 13 machines churned one path, and
   * syncing `browser.remote-control` opt-in was wrong. */
  deviceConfig?: Record<string, unknown>;
  /** Agent-host registry keyed by host name (the `--device` overlay), synced via `agents repo
   * push/pull`. `ssh-config` hosts are only an overlay (connection details stay in ~/.ssh/config);
   * `inline` carry their own. */
  hosts?: Record<string, HostEntry>;
  /** Device-scoped host registry (`hosts:` in the device doc, PHNX-3315), so one box's enrollment no
   * longer rewrites the shared `hosts:` map. The effective view is the union; only this machine
   * writes it. */
  deviceHosts?: Record<string, HostEntry>;
  /** Declarative fleet profile (`agents apply`): agents per device, config to sync, login
   * propagation. `fleet.defaults.config` is also the fleet-wide defaults layer of the device-config
   * store. */
  fleet?: import('./fleet/types.js').FleetManifest;
  /** Device-scoped slice of `Meta.fleet`: this box's discovery decisions and dismissals (PHNX-3315),
   * so N boxes stop rewriting one shared map. Unioned at read time; only this machine writes it. */
  deviceFleet?: {
    discovery?: Record<string, 'approved' | 'ignored'>;
    ignored?: import('./fleet/types.js').IgnoredDeviceEntry[];
  };
  /** Legacy artifact-share endpoint, fleet-synced; sharing moved to the `artifacts` CLI (PHNX-3992).
   * `shareRuntimeEnv` still reads `baseUrl` to decide whether to inject the `share` write token. */
  share?: {
    baseUrl?: string;
    accountId?: string;
    workerName?: string;
    bucketName?: string;
    domain?: string;
    /** Cloudflare Web Analytics token injected into published HTML pages. */
    analyticsToken?: string;
    /** sha256 of the Worker script deployed at the last provision/update
     * (legacy; a config from before this field existed has no hash). */
    templateHash?: string;
  };
  /** Owner/channel notification config for `agents send`: `owner` is what `--to owner` expands to;
   * `transports` maps a channel to its one provider (no fallback; omitted keys default to same
   * name). */
  notify?: {
    owner?: { channel: string; to: string };
    transports?: Record<string, string>;
  };
}

// ─── humans.yaml types ────────────────────────────────────────────────────────

/** A single delivery channel entry in humans.yaml. */
export interface HumanChannel {
  /** Canonical channel identifier (e.g. "imessage", "call"). */
  id: string;
  /** Provider transport (e.g. "rush", "twilio"). */
  transport: string;
  /** Provider-specific recipient (phone number, user id, address). */
  to?: string;
  /** If true the channel is watched for incoming messages. */
  watch?: boolean;
  /** Shell command to invoke (for call channels). */
  cmd?: string;
  /** Credentials bundle name (`agents secrets`). */
  creds?: string;
  /** Whether the channel is intrusive (e.g. voice call). */
  intrusive?: boolean;
}

/** Severity-to-channel-list escalation policy in humans.yaml. */
export interface HumanPolicy {
  low?: string[];
  normal?: string[];
  critical?: string[];
}

/** Owner identity and contact configuration in humans.yaml. */
export interface HumanOwner {
  /** Display name. */
  name?: string;
  /** IANA timezone string (e.g. "America/Los_Angeles"). */
  timezone?: string;
  /** Quiet hours as "HH:MM-HH:MM" in local time. */
  quiet_hours?: string;
  /** Default notification severity when unspecified. */
  default_severity?: 'low' | 'normal' | 'critical';
  /** Short-form channel config for `agents send --to owner` (channel + recipient). */
  notify?: { channel: string; to: string };
  /** Full delivery-channel definitions. */
  channels?: HumanChannel[];
  /** Severity-to-channel escalation policy. */
  policy?: HumanPolicy;
}

/** Versioned humans.yaml (owner identity, channels, notification policy), written by
 * `migrateHumans()`. */
export interface HumansConfig {
  /** Schema version. Always 1. */
  version: 1;
  owner?: HumanOwner;
}

/** Persisted agent-host entry in agents.yaml (overlay or inline). */
export interface HostEntry {
  /** `ssh-config`: reach via the bare name (ssh resolves). `inline`: use address/user below. */
  source: 'ssh-config' | 'inline';
  /** SSH-reachable target — inline hosts only (ssh-config hosts omit it). */
  address?: string;
  /** SSH user — inline hosts only. */
  user?: string;
  /** Explicit private key inherited from a fleet device profile. */
  identityFile?: string;
  /** Captured at enroll probe. */
  os?: string;
  /** Free-form capability tags for routing (e.g. ['gpu']). */
  caps?: string[];
  addedAt?: string;
}

/** Browser profile definition stored in agents.yaml. */
export interface BrowserProfileConfig {
  description?: string;
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'firefox' | 'custom';
  binary?: string;
  electron?: boolean;
  /** Selects the visible CDP page target (`url:<substring>` or `title:<substring>`); recommended for
   * Electron apps with hidden helper WebContents. Used only when `electron` is true. */
  targetFilter?: string;
  /** Endpoint presets: legacy `string[]` of CDP URLs (first is default), or `{ [presetName]: {
   * target, binary?, targetFilter? } }`. */
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
  /** Preset name to use when `--endpoint` is not passed to `start`. */
  defaultEndpoint?: string;
  /** How `agents browser` gets a browser (PHNX-3967): `launch` (default) spawns one under a managed
   * `--user-data-dir`; `attach-only` never spawns a rival window and fails loud if none is running. */
  launchPolicy?: 'attach-only' | 'launch';
  /** Absolute durable `--user-data-dir` (PHNX-3967); absent, attach-only uses a default outside
   * `~/.agents/.cache` so sign-in survives. Also what the guard compares to reject a port-squatter. */
  userDataDir?: string;
  /** Chromium profile dir inside `userDataDir` (`Default`, `Profile 1`) from the browser's own store
   * (PHNX-4042); passed as `--profile-directory`. */
  profileDirectory?: string;
  chrome?: {
    headless?: boolean;
    args?: string[];
  };
  secrets?: string;
  viewport?: { width: number; height: number };
  /** Directory holding source-side JSONL logs (e.g. ~/.rush/logs). */
  logDir?: string;
  /** Optional SSH host where logDir lives, e.g. "user@remote-host". */
  logHost?: string;
  /** Stable native identity for an Arc Space profile; display names are never addresses. */
  arc?: {
    profileId: string;
    profileName: string;
    spaceId: string;
    spaceTitle: string;
  };
  /** The `profiles.ini` entry a discovered Firefox profile is pinned to (PHNX-4043); the dir is `userDataDir`. */
  firefox?: {
    profileName: string;
    iniPath: string;
    isDefault: boolean;
  };
}

/** Options controlling which agents and resources are synced during `agents sync` / `agents use`. */
export interface SyncOptions {
  agents?: AgentId[];
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  skipClis?: boolean;
  skipMcp?: boolean;
}

/** Agent-agnostic permission set (canonical format matches Claude's syntax). */
export interface PermissionSet {
  name: string;
  description?: string;
  allow: string[];
  deny?: string[];
  additionalDirectories?: string[];
}

/** A permission set that has been applied to a specific agent version. */
export interface InstalledPermission {
  name: string;
  path: string;
  set: PermissionSet;
}

/** Claude's native settings.json permission format. */
export interface ClaudePermissions {
  permissions: {
    allow: string[];
    deny: string[];
    additionalDirectories?: string[];
  };
}

/** Cursor CLI native format in ~/.cursor/cli-config.json (Shell/Read/Write/WebFetch/Mcp). */
export interface CursorPermissions {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

/** OpenCode's native permission format (per-command allow/deny/ask). */
export interface OpenCodePermissions {
  permission: {
    bash: Record<string, 'allow' | 'deny' | 'ask'>;
  };
}

/** Codex's native permission format (approval policy + sandbox mode). */
export interface CodexPermissions {
  approval_policy?: 'on-request' | 'on-failure' | 'never';
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  sandbox_workspace_write?: {
    network_access?: boolean;
    writable_roots?: string[];
  };
}
