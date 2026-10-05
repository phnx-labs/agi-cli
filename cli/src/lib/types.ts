/** Core type definitions for agents-cli: every data structure flowing between modules. */

import type { CloudProviderId } from './cloud/types.js';
import type { FeedBroadcastConfig } from './feed-broadcast.js';

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
  slotDir: string;
  authMode: AccountAuthMode;
  verdict: AuthVerdictName;
  checkedAt?: string;
  pending?: boolean;
}

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
  createdOn?: string;
}

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

/** Action when a budget cap would be exceeded (#346): `block` refuses/kills and exits non-zero;
 * `warn` prints the overrun and proceeds. */
export type BudgetOnExceed = 'block' | 'warn';

/** `budget:` in agents.yaml: cross-vendor spend guardrails (#346), project > user, caps in USD. Only
 * set caps are enforced; `per_agent` is one agent, the rest aggregate across vendors. */
export interface BudgetConfig {
  currency?: string;
  per_run?: number;
  per_day?: number;
  per_agent?: Partial<Record<AgentId, number>>;
  per_project?: number;
  on_exceed?: BudgetOnExceed;
  /** Confirm threshold (USD): at or above this pre-flight estimate, prompt unless --yes. Never
   * relaxes a hard cap block. */
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

export type RulesCapability = false | { file: string };

export type CapabilityName = 'hooks' | 'mcp' | 'mcpHttp' | 'mcpHeaders' | 'allowlist' | 'skills' | 'commands' | 'plugins' | 'subagents' | 'rules' | 'workflows' | 'memory' | 'interactiveRepl';
/** Permission modes: plan (read-only), edit (prompts on risky shell), auto (classifier), skip
 * (bypass). `full` is a permanent silent alias of `skip` (normalizeMode); support is in
 * capabilities.modes. */
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

export type HookCachePrefetch = 'none' | 'background';

/** Full hook cache config; authors usually use the `HookCache` shorthand (`5m`, `5m-bg`). Fields:
 * ttl, key (global/per-cwd/...), prefetch (none/background). */
export interface HookCacheConfig {
  ttl: number | string;
  key?: HookCacheKey;
  prefetch?: HookCachePrefetch;
}

export type HookCache = string | HookCacheConfig;

export interface ManifestHook {
  script: string;
  events: string[];
  /** Seconds before the hook is killed (default 600); a number or duration string (`5s`, `1h30m`)
   * that `parseHookManifest` normalizes to seconds. */
  timeout?: number;
  matcher?: string;
  /** @deprecated Use the agent capability table; field is ignored. */
  agents?: AgentId[];
  enabled?: boolean;
  override?: boolean;
  matches?: HookMatches;
  /** Opt-in caching: the registrar registers a generated per-hook shim (cache lookup,
   * stale-while-revalidate, timing/logging) instead of the raw script, which is unchanged. */
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

/** Third-party registries pre-seeded once on first install; afterwards they behave like user-added
 * ones, and `agents registry remove <name>` opts out permanently. */
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
  /** Lowercase hex sha256 of the skill's SKILL.md from the registry index; install aborts on
   * mismatch. */
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
  /** Plugin install spec (`name@url`, path, or bare source) when `type === 'plugin'`. */
  pluginSpec?: string;
}

export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins' | 'workflows';

/** Resource selection pattern in agents.yaml `versions`: `<repo>:*` (system, user, extra alias,
 * project), `<repo>:name` for one resource, and a leading `!` to exclude. */
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
  /** Who published the plugin, per the official format (string or object); previously untyped. */
  author?: string | { name: string; email?: string; url?: string };
  userConfig?: PluginUserConfigField[];
  dependencies?: string[];
  /** Inline hook config (or a path to a hooks JSON file) in the manifest; an execution surface even
   * with no `hooks/` dir. Untyped: capability detection only checks it is non-empty. */
  hooks?: unknown;
  /** Inline MCP-server config (or path to an MCP JSON file) in the manifest; an execution surface
   * even with no `.mcp.json`. Untyped like `hooks`. */
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
  /** Workflow dir names under `workflows/` (each needs WORKFLOW.md); `agents run <name>` resolves
   * them project > user > plugin > extra > system. */
  workflows: string[];
  memory: string[];
  bin: string[];
  mcpServers: string[];
  lspServers: string[];
  monitors: string[];
  hasMcp: boolean;
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
  name: string;
  disabledCommands?: string[];
  /** Resource-profile preset this brand pins (a key in `profiles.presets`); defaults to
   * `mine-<name>`. */
  profile?: string;
  enabled: boolean;
}

/** An actor behind a run, keyed by slug; all fields enrich what `tailscale whois` resolves. `login`
 * is the tailnet login to match (defaults to the key). See lib/actor.ts. */
export interface ActorConfig {
  kind?: 'human' | 'agent';
  name?: string;
  email?: string;
  github?: string;
  login?: string;
  /** Phoenix (work) identity id, bridging a tailnet login to the stable work identity for
   * attribution. */
  phoenixId?: string;
}

export interface Meta {
  accounts?: {
    defaults?: Partial<Record<AgentId, string>>;
    /** Named harness-owned identities. Metadata only; OAuth credentials stay in the harness home. */
    native?: Record<string, NativeAccountRecord>;
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
    backend?: 'keychain' | 'file' | 'vault';
    policy?: 'always' | 'hold' | 'daily';
    agent?: {
      auto?: boolean;
      holdMs?: number;
      durable?: boolean;
    };
  };
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
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
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
    analyticsToken?: string;
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


export interface HumanChannel {
  id: string;
  transport: string;
  to?: string;
  watch?: boolean;
  cmd?: string;
  creds?: string;
  intrusive?: boolean;
}

export interface HumanPolicy {
  low?: string[];
  normal?: string[];
  critical?: string[];
}

export interface HumanOwner {
  name?: string;
  timezone?: string;
  quiet_hours?: string;
  default_severity?: 'low' | 'normal' | 'critical';
  notify?: { channel: string; to: string };
  channels?: HumanChannel[];
  policy?: HumanPolicy;
}

/** Versioned humans.yaml (owner identity, channels, notification policy), written by
 * `migrateHumans()`. */
export interface HumansConfig {
  version: 1;
  owner?: HumanOwner;
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
  /** Selects the visible CDP page target (`url:<substring>` or `title:<substring>`); recommended for
   * Electron apps with hidden helper WebContents. Used only when `electron` is true. */
  targetFilter?: string;
  /** Endpoint presets: legacy `string[]` of CDP URLs (first is default), or `{ [presetName]: {
   * target, binary?, targetFilter? } }`. */
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
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
