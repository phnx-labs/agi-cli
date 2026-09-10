/**
 * Core type definitions for agents-cli.
 *
 * Every data structure that flows between modules lives here: agent identity,
 * configuration schemas, resource tracking, registry types, and permission
 * formats for each supported agent.
 */

import type { CloudProviderId } from './cloud/types.js';
import type { FeedBroadcastConfig } from './feed-broadcast.js';

/** Unique identifier for a current or legacy AI coding agent. */
export const AGENT_IDS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'openclaw', 'copilot', 'amp', 'goose', 'antigravity', 'grok', 'kimi', 'droid', 'hermes', 'muse', 'warp'] as const;
export type AgentId = typeof AGENT_IDS[number];
export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/**
 * How THIS box authenticates one account slot (PHNX-3940). Native OAuth stays
 * on the headed device that minted it; a worker uses a durable credential;
 * per-device harnesses log in on each box.
 */
export type AccountAuthMode = 'native' | 'durable' | 'per-device';

/**
 * Live auth verdict vocabulary (mirrors lib/auth-health.ts AuthVerdict).
 * Duplicated here so Meta can name the field without importing the probe module.
 */
export type AuthVerdictName =
  | 'live'
  | 'revoked'
  | 'expired'
  | 'rate_limited'
  | 'unverified'
  | 'unconfigured'
  | 'error';

/**
 * Per-(account, device) materialization of an Account row. Lives in the device
 * doc (`deviceAccounts.slots`), never the fleet-synced central file — slot
 * paths are per box. Native OAuth files stay inside `slotDir` on this device.
 */
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

/**
 * Pointer to the durable worker credential in a reserved store. Never the
 * secret value itself — that stays in the secrets backend.
 */
export interface NativeAccountWorkerCredential {
  bundle: string;
  key: string;
  kind: 'setup-token' | 'api-key';
  mintedAt: string;
}

/**
 * Fleet-synced native-account row (central `accounts.native` or a device-scoped
 * copy). Additive fields from account-model v2 (PHNX-3940); existing rows
 * migrate in place with these absent.
 */
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

/**
 * Reserved `<agent>` keyword for `agents run auto` — full-auto dispatch:
 * host (14d launch affinity) → harness (best-account headroom, weighted) →
 * account (balanced). Lives in lib (not commands/) because both the run
 * command (exec.ts) and the host dispatch layer (hosts/dispatch.ts, which
 * arms the chain-hop guard for remote `run auto`) must agree on it.
 */
export const RUN_AUTO_KEYWORD = 'auto';

/**
 * Env var a host dispatcher exports into the remote SHELL when it dispatches
 * `agents run auto`: tells the remote CLI its host layer is already resolved,
 * so it must not re-run affinity and chain-hop to a third host. It rides the
 * shell-export prelude (hosts/dispatch.ts `remoteRunShellPrelude`) because
 * `--env` flags only reach the spawned AGENT's env — the remote CLI's own
 * process.env (which exec.ts `runAutoDefaultsToAffinity` reads) never sees them.
 */
export const RUN_AUTO_HOST_RESOLVED_ENV = 'AGENTS_RUN_AUTO_HOST_RESOLVED';

/**
 * Env var a host dispatcher exports into the remote SHELL when it opens an
 * INTERACTIVE `--device` run: tells the remote CLI that this agent's stdio is a
 * network link, so the run must be detached (tmux-wrapped) to outlive it.
 *
 * Rides the same shell-export prelude as {@link RUN_AUTO_HOST_RESOLVED_ENV},
 * and for the same reason — exec.ts `resolveTmuxWrap` reads the remote CLI's own
 * `process.env`, which `--env` flags (they reach only the spawned AGENT) never
 * touch.
 *
 * Set ONLY on the interactive path. A headless `--device` dispatch is already
 * detached with setsid by `launchDetached`, so it neither needs nor gets this.
 */
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

/**
 * What to do when a configured budget cap would be exceeded (issue #346).
 * `block` refuses to launch (or kills a running child) and exits non-zero so
 * CI/headless/teams/cloud all inherit the decision. `warn` prints the overrun
 * but proceeds — useful for soft rollout / observability-only.
 */
export type BudgetOnExceed = 'block' | 'warn';

/**
 * `budget:` block in agents.yaml — cross-vendor spend guardrails (issue #346).
 *
 * Resolution is project > user (same precedence as `run:`); see
 * `resolveBudgetConfig` in lib/budget/config.ts. Every cap is in USD. A cap is
 * "unset" when undefined — only set caps are enforced. `per_agent` caps apply
 * to one agent's spend; the top-level caps (`per_run`, `per_day`,
 * `per_project`) aggregate ACROSS every vendor the CLI dispatches, which is the
 * cross-vendor property no single-vendor control has.
 */
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
  /**
   * Interactive confirm threshold (USD). When a run's pre-flight estimate is at
   * or above this, prompt before launching (unless --yes). Does NOT gate a hard
   * block — a cap breach always blocks regardless of this value.
   */
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
  /**
   * Agent resolves slash-commands through its own runtime (e.g. openclaw's
   * Gateway), so agents-cli commands must NOT be converted into skills for it.
   * Skills-capable agents WITHOUT a native command-file dir convert commands to
   * skills by default; set this to opt such an agent out of that conversion.
   */
  nativeCommandRuntime?: boolean;
  hooksDir: string;
  /**
   * Directory (relative to a plugin's install dir) the agent reads its plugin
   * manifest from, when it differs from the canonical `.claude-plugin/`. Codex
   * uses `.codex-plugin`, Droid `.factory-plugin`. Set to `.` when the agent
   * reads the manifest from the plugin ROOT (Copilot). syncPluginToVersion
   * mirrors `.claude-plugin/plugin.json` into this dir.
   */
  pluginManifestDir?: string;
  instructionsFile: string;
  format: 'markdown' | 'toml';
  variableSyntax: string;
  supportsHooks: boolean;
  nativeAgentsSkillsDir?: boolean;
  /**
   * This agent's *own* cloud backend. `agents cloud run --agent <id>` routes
   * here when no `--provider` is given (precedence: --provider > this >
   * cloud.default_provider > rush). Undefined means the agent has no native
   * cloud and falls back to the configured default.
   */
  cloudProvider?: CloudProviderId;
  /**
   * Set when the upstream vendor has retired this agent's CLI. A warning-only
   * deprecation leaves the agent manageable; a hard deprecation keeps the id
   * parseable for legacy state but excludes it from install/import/sync targets.
   * Point `replacement` at the successor agent so messages can suggest a
   * migration path.
   */
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
    /**
     * Whether `mcp add --transport http` is supported. Only true for agents
     * whose CLI accepts an HTTP-transport MCP server registration; false for
     * agents that only accept stdio (registerMcp skips HTTP registration with
     * a clear reason).
     */
    mcpHttp: Capability;
    /**
     * Whether HTTP-MCP registration accepts `--header` args. Independent of
     * `mcpHttp`: only Claude's CLI takes headers today; Codex/Gemini accept
     * HTTP MCP but reject header args.
     */
    mcpHeaders: Capability;
    allowlist: Capability;
    skills: Capability;
    commands: Capability;
    plugins: Capability;
    subagents: Capability;
    rules: RulesCapability;
    workflows: Capability;
    /**
     * Portable knowledge-store memory (`agents memory` / ~/.agents/memory/).
     * Distinct from `rules` (instructions). When true, sync fans facts into
     * the agent version home (see memoryTargetDir).
     */
    memory: Capability;
    /**
     * Permission modes this agent natively supports. Modes outside this set
     * are gated by buildExecCommand: `auto` silently degrades to `edit`,
     * `skip` errors with a clear message naming the supported modes.
     */
    modes: Mode[];
    /**
     * Whether `plan` mode works in a HEADLESS run (`--prompt`/`-p`). Some CLIs
     * list a `plan` mode that only works interactively — kimi refuses `--prompt`
     * combined with `--plan`, and grok's `--permission-mode plan` silently stalls
     * a headless run at its ExitPlanMode gate. Absent (undefined) means true:
     * headless plan is assumed to work unless a agent opts out with `false`, in
     * which case a headless `--mode plan` request auto-downgrades to `auto`
     * (see resolveHeadlessMode). Interactive plan is unaffected.
     */
    headlessPlan?: boolean;
    /**
     * Whether the agent natively resolves `@path/to/file` imports inside its
     * rules file at session start. If false, agents-cli must pre-compile the
     * rules file (inline all @-imports) when syncing it into the version home.
     */
    rulesImports?: boolean;
    /**
     * Whether the agent can open an interactive REPL session when launched with
     * NO prompt (bare invocation). Agents whose CLI exits immediately without a
     * prompt (e.g. cursor-agent) must declare `false` here; agents that open a
     * TUI/REPL with no args declare `true`. Used by the `auto` harness picker
     * to avoid routing a prompt-less interactive run to a harness that would
     * exit silently (RUSH-2185, EXEC-23a).
     */
    interactiveRepl?: Capability;
  };
}

/**
 * A capability flag for an agent feature. `true` means supported on every
 * installed version; `false` means never supported. The object form gates by
 * semver: `since` is the minimum version that ships the feature, `until` is
 * exclusive upper bound (set when a feature is removed in a later release).
 */
export type Capability = boolean | { since?: string; until?: string };

/** Rules sync writes one composed instructions file per supported agent. */
export type RulesCapability = false | { file: string };

/** Names of every gateable capability on AgentConfig. */
export type CapabilityName = 'hooks' | 'mcp' | 'mcpHttp' | 'mcpHeaders' | 'allowlist' | 'skills' | 'commands' | 'plugins' | 'subagents' | 'rules' | 'workflows' | 'memory' | 'interactiveRepl';
/**
 * Permission modes controlling agent autonomy.
 *   plan  read-only investigation; no writes, no shell side-effects
 *   edit  may edit files; prompts for shell/risky operations
 *   auto  smart classifier auto-approves safe operations, prompts for risky ones
 *   skip  bypasses every permission prompt (dangerously-skip-permissions)
 *
 * `full` is accepted as a permanent silent alias for `skip` via normalizeMode().
 * Per-agent support is declared on AgentConfig.capabilities.modes.
 */
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

/**
 * Predicate set for declaring when a hook should fire within its declared event.
 * All predicates AND together. Empty/missing matches: hook always fires.
 */
export interface HookMatches {
  prompt_contains?: string;          // substring of user prompt
  prompt_matches?: string;           // regex applied to user prompt
  tool_name?: string | string[];     // PreToolUse / PostToolUse only
  tool_args_match?: string;          // regex on serialized tool args
  git_dirty?: boolean;               // working tree has changes
  cwd_includes?: string | string[];  // cwd contains any of these substrings
  project_has?: string;              // project root contains this file
  /**
   * Permission modes the hook fires in (e.g. `plan`). Unlike the other
   * predicates this one is fail-open on absence: an input that carries no
   * permission_mode/permissionMode field passes, because only some harnesses
   * (Claude Code) report the live mode — an explicit non-listed value skips.
   */
  permission_mode?: string | string[];
  /**
   * Permission modes the hook must NOT fire in (e.g. `plan`). The inverse of
   * `permission_mode`, and the correct predicate for gating a guard off in one
   * mode: expressing that with the allowlist means enumerating every other
   * mode, which silently stops firing when a harness adds or renames one. Same
   * fail-open-on-absence rule — an input with no mode field still fires — so an
   * unknown mode errs toward running the hook, never toward skipping it.
   */
  permission_mode_not?: string | string[];
}

/**
 * Cache scoping. Determines which cache file a hook invocation reads/writes:
 *  - `global`      one file per hook, shared across cwds/sessions. Right for
 *                  SessionStart hooks pulling org-wide context (Linear sprint).
 *  - `per-cwd`     keyed on the working directory the hook fires from.
 *  - `per-session` keyed on the agent's session_id (read from stdin JSON).
 *  - `per-project` keyed on the nearest git repo root above cwd.
 */
export type HookCacheKey = 'global' | 'per-cwd' | 'per-session' | 'per-project';

/** Prefetch strategy when the cache is stale. */
export type HookCachePrefetch = 'none' | 'background';

/**
 * Full hook cache config. Authors usually use the shorthand string form
 * (`HookCache`) below. Shorthand examples in hooks.yaml:
 *
 *   cache: 5m          # → { ttl: 300, key: 'global', prefetch: 'none' }
 *   cache: 5m-bg       # → { ttl: 300, key: 'global', prefetch: 'background' }
 *   cache:             # full form
 *     ttl: 1h
 *     key: per-cwd
 *     prefetch: background
 */
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
  /**
   * Seconds before the hook is killed (default 600). In agents.yaml this may be
   * written as a bare number (seconds) or a duration string (`5s`, `2m`,
   * `1h30m`); `parseHookManifest` normalizes it to a seconds number here, so
   * consumers always see a number.
   */
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
  /**
   * Opt-in caching. When set, the registrar generates a per-hook shim
   * under the hook shims dir that handles cache lookup, stale-while-revalidate,
   * and per-invocation timing/logging, then registers that shim with the agent
   * instead of the raw script. The underlying script is unchanged.
   */
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

/**
 * Third-party registries pre-seeded on first install for discoverability.
 *
 * These ship into new users' agents.yaml once, but are not "defaults" — after
 * seeding they behave like any user-added registry (listable, disable-able,
 * removable). Removed users can `agents registry remove <name>` to opt out;
 * once removed they don't come back.
 */
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
  /**
   * Lowercase hex sha256 of the skill's SKILL.md, as recorded by the registry
   * index. When present, install verifies the cloned SKILL.md against it and
   * aborts on mismatch.
   */
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
  /**
   * Plugin install spec (`name@url`, path, or bare source) when `type === 'plugin'`.
   * Same grammar as `agents plugins install <spec>`.
   */
  pluginSpec?: string;
}

/** Categories of resources that can be synced into an agent version home. */
export type ResourceType = 'commands' | 'skills' | 'hooks' | 'memory' | 'mcp' | 'permissions' | 'subagents' | 'plugins' | 'workflows';

/**
 * A resource selection pattern stored in agents.yaml versions:
 *   "system:*"      — all resources from ~/.agents/.system/
 *   "user:*"        — all resources from ~/.agents/
 *   "rush:*"        — all resources from ~/.agents-rush/  (extra repo alias)
 *   "project:*"     — all resources from .agents/ in the project root
 *   "user:foo"      — specifically "foo" from ~/.agents/
 *   "!user:temp"    — exclude "temp" from the user repo
 */
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
  /**
   * Who published the plugin, per the official plugin format. Every plugin.json
   * in this repo already carries one; it was missing from this interface, so
   * `loadPluginManifest`'s cast passed it through un-typed and no surface read it.
   * Accepts the shorthand string form as well as the object form.
   */
  author?: string | { name: string; email?: string; url?: string };
  /** Interactive config fields prompted at install time. Values stored in .user-config.json. */
  userConfig?: PluginUserConfigField[];
  /** Other plugin names this plugin depends on. Missing deps produce a warning. */
  dependencies?: string[];
  /**
   * Inline hook configuration (or a path to a hooks JSON file) declared directly
   * in the manifest, per the official plugin format — an execution surface even
   * when the plugin ships no `hooks/` directory. Untyped because the shape is a
   * path string or an inline event map; capability detection only needs to know
   * whether it is present and non-empty.
   */
  hooks?: unknown;
  /**
   * Inline MCP-server configuration (or a path to an MCP JSON file) declared
   * directly in the manifest — an execution surface even when the plugin ships
   * no `.mcp.json`. Untyped for the same reason as `hooks`.
   */
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
  /**
   * Workflow directory names under the plugin's `workflows/` (each must contain
   * WORKFLOW.md). Phase 5 packaging: plugins may package workflows as entrypoints;
   * `agents run <name>` resolves them via project > user > plugin > extra > system.
   */
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
  /**
   * Marketplace this plugin was discovered in (from marketplaceNameFor() of the
   * owning MarketplaceSpec): "agents-cli" (user repo), "agents-<alias>" (extra
   * repo), or "agents-project" (project repo). Absent on hand-built plugins
   * (e.g. workflow-scoped) — those default to the user marketplace on sync.
   */
  marketplace?: string;
  /**
   * Absolute path to the DotAgents repo root containing this plugin — the
   * grandparent of `root` (`<repo>/plugins/<name>` → `<repo>`), true for every
   * marketplace kind (user/system/extra/project). DotAgents repos are
   * git-tracked (plugins.ts), so this pairs with {@link snapshotSha}.
   */
  repoRoot: string;
  /**
   * Short HEAD sha of `repoRoot`'s git checkout, lazily resolved (a getter,
   * not computed at discovery time) and memoized per repoRoot
   * (`git.ts` `resolveSnapshotSha`) — see `ResolvedResource.snapshotSha` for
   * the identical rationale. `undefined` when `repoRoot` isn't a git repo.
   */
  readonly snapshotSha: string | undefined;
}

/**
 * Identifies one DotAgents repo that contributes a plugin marketplace. Each
 * repo synthesizes its own catalog and registers under its own name:
 *   user    — ~/.agents/plugins/         → "agents-cli"   (the canonical name)
 *   extra   — ~/.agents-<alias>/plugins/ → "agents-<alias>" (e.g. "agents-extras")
 *   project — <cwd>/.agents/plugins/     → "agents-project"
 *
 * `root` on the extra/project variants is the absolute path to that repo's
 * plugins/ directory (the source side). The user variant needs no path — it is
 * always ~/.agents/plugins/ via getPluginsDir().
 */
export type MarketplaceSpec =
  | { kind: 'user' }
  | { kind: 'extra'; alias: string; root: string }
  | { kind: 'project'; root: string }
  | { kind: 'system'; root: string };

/**
 * A marketplace found on the source side (before any per-version sync), with
 * its resolved name, source plugins directory, and catalog description.
 */
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

/**
 * Extra DotAgent repo registered as user-level config alongside ~/.agents/.
 * Managed clones default to ~/.agents-<alias>/ as peer dirs; user-owned repos
 * may live anywhere on disk via the `path` field. ~/.agents/ wins on name
 * collisions; extras are searched in insertion order after the user repo.
 */
export interface ExtraRepoConfig {
  url: string;
  path?: string;
  enabled: boolean;
}

/**
 * A white-label brand — a personally-named CLI (e.g. `jack`) that IS agents-cli,
 * minted by `agents setup mine` / `agents mine`. The brand's shim exports
 * `AGENTS_BRAND=<name>`; the entrypoint reads it to present under this name and
 * apply the customization below. Portable user config — rides `agents repo
 * push/pull`. See lib/brand.ts.
 */
export interface BrandConfig {
  /** The brand name; also the binary name on PATH. */
  name: string;
  /** Built-in top-level commands this brand hides/disables (e.g. `["teams"]`). */
  disabledCommands?: string[];
  /**
   * Resource-profile preset this brand pins (a key in `profiles.presets`). When
   * the CLI runs under this brand, that preset becomes the active profile, so
   * skills/plugins/mcp/hooks/etc. filter to the brand's curated set. Defaults to
   * `mine-<name>`.
   */
  profile?: string;
  /** False to keep the config but stop minting/using the brand. */
  enabled: boolean;
}

/**
 * An actor -- a responsible entity behind a run (a human today, a top-level
 * agent later). Keyed in the `actors:` map by a short slug. Every field is
 * optional enrichment over what `tailscale whois` already resolves: pin a
 * preferred git email, add a github handle, or override the display name.
 * `login` is the tailnet login-name to match against (defaults to the map key).
 * See lib/actor.ts.
 */
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
  /**
   * Phoenix (work) identity id — bridges this person's tailnet login (often a
   * personal email) to their stable internal work identity, so session/commit
   * attribution survives whichever email they are signed into tailscale with.
   */
  phoenixId?: string;
}

/** Top-level structure of ~/.agents/.system/agents.yaml -- the CLI's persistent state. */
export interface Meta {
  /** Preferred provider account per harness. Explicit --account wins. */
  accounts?: {
    defaults?: Partial<Record<AgentId, string>>;
    /**
     * Named harness-owned identities. Metadata only; OAuth credentials stay in
     * the harness home. Central-synced via agents.yaml; labels bind to
     * `(agent, identityKey)`.
     */
    native?: Record<string, NativeAccountRecord>;
    /** Exact installation/custom-harness target -> stable account id. */
    bindings?: Record<string, string>;
  };
  /**
   * Device-scoped slice of {@link Meta.accounts}, written as `accounts:` in
   * `~/.agents/devices/<machine>/agents.yaml` (PHNX-3315). Holds this box's own
   * `scope: 'device'` native identities and the bindings that target them, so a
   * per-box login no longer rewrites the fleet-shared central `agents.yaml` (and
   * its identity PII no longer lands on that one file). The effective account
   * view is the union of central (fleet-shared `defaults` + `scope:'version'`
   * natives) and every device doc's block; only this machine writes this key.
   */
  deviceAccounts?: {
    native?: Record<string, NativeAccountRecord>;
    bindings?: Record<string, string>;
    /**
     * THIS box's leftover account⇄home map (PHNX-3940): stable account id → a
     * local installation label (`acct-*` from the retired connect verb). Device-
     * scoped: a label minted here is not assumed to exist on another box, so it
     * lives in the device doc, never the fleet-synced central `accounts.native`
     * identity row. `nativeAccountHome` still reads it so T5/T7 can resolve a
     * legacy home; spawn-time HOME is {@link DeviceAccountSlot slots}.
     */
    homes?: Record<string, string>;
    /**
     * Leftover in-flight connect map from the retired verb
     * (PHNX-3940). No writer remains; state still round-trips the field so an
     * older device doc does not fail to load.
     */
    pendingConnects?: Record<string, string>;
    /**
     * THIS box's account slots (PHNX-3940): stable account id → HOME-shaped
     * dir under `~/.agents/.history/accounts/<harness>/<accountId>/`. Device-
     * scoped: a slot path is local and a native OAuth file never leaves this
     * box. Replaces `homes` as the spawn-time HOME; `homes` remains the
     * installation-label map so leftover `acct-*` labels still resolve.
     */
    slots?: Record<string, DeviceAccountSlot>;
  };
  agents?: Partial<Record<AgentId, string>>;
  /**
   * Per-agent preferred ISOLATED version — which copy a bare `agents run <agent>`
   * resolves to when the agent has no global default.
   *
   * Kept separate from `agents` on purpose. An entry there is the global default,
   * which owns the launcher, the bare shim and the real `~/.<agent>` config
   * symlink, and arms the self-heal `shadowing` check. An isolated copy must never
   * acquire any of that, so it cannot be recorded in the same place — the
   * separation is what keeps `getGlobalDefault` incapable of returning one.
   */
  isolatedAgents?: Partial<Record<AgentId, string>>;
  run?: RunConfig;
  /**
   * Cost-tier overrides for `--model cheap|default|best|ultra`. Keyed by the same
   * `<agent>:<version>` selector run.defaults uses (`kimi:*`, `kimi:0.19.2`); each
   * value maps a tier to a concrete model id. Written by `agents models tier set`,
   * never hand-edited. Resolution: exact version selector wins over `<agent>:*`,
   * which wins over the auto-ranking. See lib/model-tier-overrides.ts.
   */
  model?: {
    tiers?: Record<string, Partial<Record<'cheap' | 'default' | 'best' | 'ultra', string>>>;
  };
  /**
   * Daemon watchdog config. `rotate` (default `on`) lets the watchdog rotate a
   * rate-limited session IN PLACE onto a healthy account/harness via
   * `agents run auto` — see lib/watchdog/rotate.ts. Set `off` to keep the
   * nudge-only behavior (the Factory `agents.watchdog.autoRotate: false`
   * migration writes `off` here).
   */
  watchdog?: {
    rotate?: 'on' | 'off';
  };
  /**
   * `agents run --lease` config. `secretsBundle` names the keychain secrets bundle
   * whose provider token (e.g. `HCLOUD_TOKEN`) crabbox uses to reach the cloud API.
   * When unset, the bundle is resolved by env (`AGENTS_LEASE_SECRETS_BUNDLE`) then
   * auto-detected (the first bundle that declares a provider token key).
   */
  lease?: {
    secretsBundle?: string;
  };
  /** macOS secrets-agent config. `policy` is the default prompt policy for
   * bundles without an explicit per-bundle policy: `hold` (the default) asks
   * once per hold window (7 days out of the box), `always` asks every time.
   * `auto` (default on) lets the
   * first real keychain read of a `hold` bundle populate the broker so
   * concurrent runs read silently — set it `false` to force a prompt on every read.
   * `holdMs` caps how long an unlocked/auto-cached bundle is held before the next
   * read re-prompts (default 7 days; e.g. 86400000 for a 24h cap). Clamped to
   * [1 minute, 30 days]. `durable` (default off) makes every `agents secrets
   * unlock` survive sleep + reboot as well as upgrade/restart — the same effect as
   * passing `--durable` per unlock; off means the secure split default (survive
   * upgrade/restart, re-lock on sleep). */
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
  /**
   * `agents feed post` fan-out. `broadcast` maps a sink name to either an argv
   * template (`command:`, run for each post) or an in-process channel delivery
   * (`channel:`, the same registry `agents send`/`agents notify` use). Channel
   * sinks may set `message:` with feed placeholders; a missing placeholder
   * skips that sink, so `{ticket}` cleanly gates a tracker-specific channel. Thus
   * mirroring to a tracker, a messaging CLI, or a channel provider is the
   * operator's config rather than an integration compiled into this CLI. When
   * this is unset/empty, an important-level post falls back to `notify.owner`
   * implicitly (RUSH-2123) — see lib/feed-broadcast.ts and
   * docs/observability.md.
   */
  feed?: {
    broadcast?: FeedBroadcastConfig;
  };
  beta?: {
    enabled?: BetaFeatureName[];
  };
  registries?: Record<RegistryType, Record<string, RegistryConfig>>;
  /**
   * Top-level resource profiles. Activating one filters the resolved resource
   * set across commands, skills, hooks, rules, MCP, permissions, and secrets.
   * Model-provider run profiles are separate YAML files under profiles/.
   */
  profiles?: ResourceProfilesConfig;
  // Per-version resource tracking
  versions?: Partial<Record<AgentId, Record<string, VersionResources>>>;
  // Git remote source URL (when ~/.agents/.system/ is a git repo)
  source?: string;
  /**
   * Projects root for the `agents run --project <slug>` shorthand, e.g.
   * `~/src/github.com/<user>`. Auto-inferred from the repo you launch inside and
   * cached here; stored home-relative (`~/…`) so it resolves on remote hosts too.
   */
  projectRoot?: string;
  /**
   * Extra DotAgent repos merged after ~/.agents/. Managed clones live as peer
   * dirs at ~/.agents-<alias>/; user-owned repos can point at arbitrary paths
   * via the `path` field.
   */
  extraRepos?: Record<string, ExtraRepoConfig>;
  /**
   * White-label brands keyed by name. Each mints a personally-named binary
   * (e.g. `jack`) that runs agents-cli under that name with its own disabled
   * commands + curated resource profile. See lib/brand.ts.
   */
  brands?: Record<string, BrandConfig>;
  /**
   * Actors keyed by slug -- who is behind a run. Enriches or overrides the
   * identity `tailscale whois` resolves (git email, github handle, display
   * name, human vs agent). See lib/actor.ts.
   */
  actors?: Record<string, ActorConfig>;
  /**
   * Removal tombstones for SEEDED_REGISTRIES presets, keyed like `skill.hermes`.
   *
   * Seeded presets are resolved in memory by `getRegistries` (see
   * `offeredSeeds`) rather than written into agents.yaml — persisting them from
   * the read path dirtied this git-tracked file and deadlocked
   * `agents repo pull` (RUSH-1925). A key listed here means the user ran
   * `registry remove` on that preset, so it is no longer offered.
   *
   * Entries written by the pre-RUSH-1925 seeding also appear here; those files
   * carry the registry in their own `registries:` block too, which takes
   * precedence, so the preset stays exactly as configured.
   */
  seededPresets?: string[];
  /**
   * Hook manifest entries keyed by hook name. Folded into agents.yaml so the
   * user has a single file to sync. Each entry shape matches ManifestHook
   * (script, events, timeout, matches, enabled).
   */
  hooks?: Record<string, ManifestHook>;
  /**
   * Browser profiles declared by this machine. Written as `browser:` in
   * `~/.agents/devices/<machine>/agents.yaml`. The fleet registry is the union
   * of every device file; central `agents.yaml` is not a browser-profile store.
   */
  deviceBrowser?: Record<string, BrowserProfileConfig>;
  /**
   * User-scope config block (`config:` in central agents.yaml). Holds the
   * user-scope keys from the device-config registry (`lib/device-config.ts`) —
   * currently `interactiveHost`. Syncs fleet-wide via `agents repo push/pull`.
   * Device-scope keys live in the per-device doc
   * `devices/<name>/agents.yaml` `config:` block, layered over the fleet-wide
   * defaults in {@link Meta.fleet} (`fleet.defaults.config`).
   */
  config?: Record<string, unknown>;
  /**
   * Routine names enabled on this machine. In memory this stays distinct from
   * portable user config; state.ts writes it as top-level `routines:` in
   * `~/.agents/devices/<machine>/agents.yaml`. Presence in the list is the whole
   * activation state: absent means disabled on this device.
   */
  deviceRoutines?: string[];
  /**
   * Machine-local operator config — the device-scope keys whose `visibility` is
   * `machine` (see lib/device-config.ts). state.ts writes it as `config:` inside
   * `~/.agents/devices/<machine>/agents.yaml`, which is gitignored, so it never
   * reaches the fleet-shared agents.yaml.
   *
   * These are the keys nothing off-box reads. Keeping them out of the shared file
   * is both a churn fix (13 machines were writing one tracked path) and a
   * security one: `browser.remote-control` gates whether OTHER machines may drive
   * this box's browser, so syncing one box's opt-in to the rest was wrong.
   */
  deviceConfig?: Record<string, unknown>;
  /**
   * Agent-host registry keyed by host name (the `--device` dispatch overlay). Portable user
   * config synced with `agents repo push/pull`. For `ssh-config` hosts this is
   * just an overlay (caps/os) — the connection details stay in ~/.ssh/config and
   * are never copied. `inline` hosts carry their own address/user.
   */
  hosts?: Record<string, HostEntry>;
  /**
   * Device-scoped agent-host registry, written as `hosts:` in
   * `~/.agents/devices/<machine>/agents.yaml` (PHNX-3315). Locally-discovered
   * SSH hosts and inline registrations land here so one box's enrollment no
   * longer rewrites the fleet-shared `hosts:` map (the source of pull conflicts).
   * The effective host view is the union across every device doc (plus any
   * lingering central legacy entries); only this machine writes this key.
   */
  deviceHosts?: Record<string, HostEntry>;
  /**
   * Declarative fleet profile (`agents apply` / `ag apply`). Additive to the
   * schema — project `agents:` version-pins are untouched. Declares which agents
   * every device should have, which config to sync, and how login propagates.
   * `fleet.defaults.config` is also the fleet-wide DEFAULTS layer of the
   * device-config store (`agents devices config --fleet <key> <value>`) — read
   * between the built-in default and the per-device doc's `config:` block.
   * Full shape in `lib/fleet/types.ts` (FleetManifest).
   */
  fleet?: import('./fleet/types.js').FleetManifest;
  /**
   * Device-scoped slice of {@link Meta.fleet}: THIS box's own discovery
   * decisions and dismissals, written as `fleet:` in
   * `~/.agents/devices/<machine>/agents.yaml` (PHNX-3315). Each box records only
   * its own choices here, so N boxes no longer rewrite one shared
   * `fleet.discovery`/`fleet.ignored` map (the guaranteed pull conflict). The
   * effective fleet view is computed as a UNION across every device doc (plus
   * lingering central legacy) at read time; only this machine writes this key.
   */
  deviceFleet?: {
    discovery?: Record<string, 'approved' | 'ignored'>;
    ignored?: import('./fleet/types.js').IgnoredDeviceEntry[];
  };
  /** Artifact share endpoint (Cloudflare R2 + Worker). Set by `agents artifacts
   * setup`/`join`; syncs fleet-wide via `agents repo push/pull`. The write token
   * lives in the `share` secrets bundle, not here. */
  share?: {
    baseUrl?: string;
    accountId?: string;
    workerName?: string;
    bucketName?: string;
    domain?: string;
    /** Cloudflare Web Analytics token injected into published HTML pages. */
    analyticsToken?: string;
    /** sha256 of the Worker script deployed at the last provision/update, so
     * `agents artifacts share status` can tell current vs outdated vs unknown (a config
     * from before this field existed has no hash — always "unknown"). */
    templateHash?: string;
  };
  /**
   * Owner/channel notification config for `agents send` / `agents notify`.
   * `owner` is the address expanded by `--to owner` and by `agents notify`
   * (channel + target). `transports` maps a user-facing channel name to the
   * provider that actually delivers it — explicit, one provider per channel,
   * no fallback. Omitted keys default to name-identity (channel `slack` ->
   * provider `slack`).
   */
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

/**
 * Versioned humans.yaml config — owner identity, channels, and notification
 * policy. Written to ~/.agents/humans.yaml by `migrateHumans()`.
 */
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
  browser: 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'custom';
  binary?: string;
  electron?: boolean;
  /**
   * Selects which CDP page target represents the visible UI when the
   * browser/app exposes more than one. Format: `url:<substring>` or
   * `title:<substring>`. Recommended for Electron apps that ship hidden
   * helper WebContents (background services, OAuth windows, file://
   * shells); without an explicit filter the connector falls back to a
   * skip-invisible heuristic before picking the first page target.
   * Only consulted when `electron` is true.
   */
  targetFilter?: string;
  /**
   * Endpoint presets. Accepts two shapes for backward compatibility:
   *   - Legacy: `string[]` of CDP URLs; first entry is the default.
   *   - New:    `{ [presetName]: { target, binary?, targetFilter? } }`.
   */
  endpoints: string[] | Record<string, { target: string; binary?: string; targetFilter?: string }>;
  /** Preset name to use when `--endpoint` is not passed to `start`. */
  defaultEndpoint?: string;
  /**
   * How `agents browser` obtains a live browser for this profile (PHNX-3967):
   *   - `launch` (default when absent): agents-cli spawns the browser itself
   *     under a managed `--user-data-dir` when nothing is serving CDP on the port.
   *   - `attach-only`: agents-cli NEVER spawns a rival window. It attaches to a
   *     browser the user (or a one-time command) already started with remote
   *     debugging, and fails loud with a relaunch hint when none is there. This
   *     is how "enforce one window" is expressed — Arc is inherently attach-only,
   *     and a canonical signed-in Comet uses it so agents can't spawn a second,
   *     logged-out instance. Pairs with a durable {@link userDataDir}.
   */
  launchPolicy?: 'attach-only' | 'launch';
  /**
   * Absolute durable `--user-data-dir` for this profile's browser (PHNX-3967).
   * When absent, an attach-only profile resolves a default durable dir outside
   * `~/.agents/.cache` (`getBrowserDurableDir()`), so a one-time sign-in survives
   * quit+relaunch and `profiles remove`'s cache sweep. Also the value the
   * ownership guard compares a running instance against to reject a port-squatter.
   */
  userDataDir?: string;
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
