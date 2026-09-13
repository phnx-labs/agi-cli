/**
 * `agents inspect <target>` — detail view for one agent+version or one DotAgents repo.
 *
 * Agent targets (`claude`, `claude@2.1.170`) show the per-version header (paths,
 * shim, capabilities, resource counts, sessions). Repo targets (`user`, `system`,
 * `project`, a registered extra-repo alias, or a filesystem path to a repo with a
 * `.agents/` dir or to a DotAgents root itself) show the repo root, git state, and
 * per-kind resource counts. Drill-down flags (`--skills`, `--hooks`, `--mcp`, ...)
 * list one resource kind for either target form; passing a positional query to the
 * same flag fuzzy-searches for a single resource and prints its detail. Resource
 * names render as OSC-8 hyperlinks to the marker file (SKILL.md / WORKFLOW.md /
 * AGENT.md / the file itself) so users can click straight to the source.
 */

import { execFileSync } from 'child_process';
import { addHostOption } from '../lib/hosts/option.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { truncate, termLink, formatBytes } from '../lib/format.js';
import * as yaml from 'yaml';
import type { AgentId, CapabilityName, DiscoveredPlugin, ManifestHook, HookMatches, HookCache } from '../lib/types.js';
import { AGENTS, getCliState, resolveAgentName } from '../lib/agents.js';
import { supports } from '../lib/capabilities.js';
import { resolveConfiguredModel } from '../lib/models.js';
import { getAgentModesCatalog } from '../lib/agent-modes.js';
import { resolveSingleAgentTarget, AgentSpecError } from '../lib/agent-spec/index.js';
import {
  readMeta,
  getUserAgentsDir,
  getSystemAgentsDir,
  getProjectAgentsDir,
  getEnabledExtraRepos,
} from '../lib/state.js';
import { getVersionHomePath,
  isVersionIsolated,
  getIsolatedDefault,
} from '../lib/installations/versions.js';
import { getShimsDir, getVersionedAliasPath } from '../lib/installations/shims.js';
import {
  getAgentResources,
  isDirectoryDoc,
  listResources,
  type ResourceEntry,
  type SkillResourceEntry,
} from '../lib/resources.js';
import { listHookEntriesFromDir } from '../lib/hooks/install.js';
import { getResourceInventory, type ResourceInventory } from '../lib/resource-inventory.js';
import { listMcpServerConfigs, discoverMcpConfigsFromRepo, type McpYamlConfig } from '../lib/mcp.js';
import { discoverPlugins, discoverPluginsInDir, pluginResourceGroups, inspectPluginCapabilities, pluginCapabilityLabels, type PluginResourceGroup } from '../lib/plugins/plugins.js';
import { showResourceList } from './resource-view.js';
import { PLUGIN_GROUP_COLORS } from './plugins.js';
import { isInteractiveTerminal } from './utils.js';
import { countSessionsInScope } from '../lib/session/discover.js';
import { isSessionTrackedAgent } from '../lib/session/types.js';
import { damerauLevenshtein } from '../lib/fuzzy.js';
import { terminalWidth, truncateToWidth, stringWidth, stripAnsi } from '../lib/session/width.js';
import {
  readJobFileResult,
  getJobRunsDir,
  readRunMeta,
  isOneShotRoutine,
  isPastOneShotRoutine,
  listJobs,
  type JobConfig,
  type RunMeta,
} from '../lib/scheduling/routines.js';
import {
  routineDeviceIndex,
  currentRoutineDevice,
  routineEnabledOnThisDevice,
  type RoutineDeviceIndex,
} from '../lib/routine-activation.js';
import { humanizeCron } from '../lib/routines-format.js';

/** Resource kinds the inspect command can drill into. */
const DRILLABLE_KINDS = [
  'commands',
  'skills',
  'hooks',
  'mcp',
  'rules',
  'plugins',
  'workflows',
  'subagents',
  'routines',
] as const;
type DrillableKind = typeof DRILLABLE_KINDS[number];

/**
 * Summary-view partition. SIMPLE kinds render as a one-line count + name preview;
 * RICH kinds (hooks/plugins/mcp/routines) get their own expanded section showing
 * each item's key detail (events/predicates, bundle contents, transport/url,
 * schedule + where a routine actually fires). Together they cover every
 * DrillableKind — the type below makes that claim load-bearing.
 */
const SIMPLE_KINDS = ['commands', 'skills', 'rules', 'subagents', 'workflows'] as const;
const RICH_KINDS = ['hooks', 'plugins', 'mcp', 'routines'] as const;

/**
 * A kind added to DRILLABLE_KINDS but to neither list would silently vanish from
 * both summary views rather than failing the build. This makes it a type error.
 */
type _KindsPartitioned =
  Exclude<DrillableKind, typeof SIMPLE_KINDS[number] | typeof RICH_KINDS[number]> extends never
    ? true
    : never;
const _kindsPartitioned: _KindsPartitioned = true;
void _kindsPartitioned;

/**
 * Singular aliases for the plural drill-down flags. `--plugin code` reads as
 * "show the one plugin named code" — a required-value flag that always lands in
 * detail mode, the natural counterpart to `--plugins` (list). `mcp` has no
 * distinct singular, so it is intentionally absent.
 */
const SINGULAR_DRILL_ALIASES: Record<string, DrillableKind> = {
  command: 'commands',
  skill: 'skills',
  hook: 'hooks',
  rule: 'rules',
  plugin: 'plugins',
  workflow: 'workflows',
  subagent: 'subagents',
  routine: 'routines',
};

const CAPABILITY_NAMES: readonly CapabilityName[] = [
  'hooks', 'mcp', 'skills', 'commands', 'subagents', 'plugins', 'workflows', 'rules', 'allowlist',
];

/** Wrap a separator-joined value list under `prefix`, preserving a hanging indent. */
export function wrapJoined(prefix: string, items: string[], sep: string, width: number): string[] {
  if (items.length === 0) return [];
  const continuation = ' '.repeat(stringWidth(prefix));
  const fitItem = (item: string, linePrefix: string): string => {
    const room = Math.max(1, width - stringWidth(linePrefix));
    return stringWidth(item) > room ? truncateToWidth(item, room) : item;
  };

  const lines: string[] = [];
  let linePrefix = prefix;
  let line = prefix;
  let hasItem = false;
  for (const raw of items) {
    const item = fitItem(raw, linePrefix);
    const candidate = hasItem ? `${line}${sep}${item}` : `${line}${item}`;
    if (hasItem && stringWidth(candidate) > width) {
      lines.push(line);
      linePrefix = continuation;
      line = continuation + fitItem(raw, linePrefix);
      hasItem = true;
    } else {
      line = candidate;
      hasItem = true;
    }
  }
  if (hasItem) lines.push(line);
  return lines;
}

function printWrappedJoined(prefix: string, items: string[], sep: string): void {
  for (const line of wrapJoined(prefix, items, sep, terminalWidth())) console.log(line);
}

function truncateValueForPrefix(prefix: string, value: string): string {
  return truncateToWidth(stripAnsi(value), Math.max(1, terminalWidth() - stringWidth(prefix)));
}

interface ResourceItem {
  name: string;
  source: string;
  /** Absolute path to the resource entry (file or directory). */
  path: string;
  /** Path the OSC-8 link should point at — marker file inside bundles, else `path`. */
  linkTarget: string;
  /** One-line description (frontmatter `description:` or first non-frontmatter line). */
  description: string;
  /** Scalar detail rows surfaced in detail mode (e.g. a plugin's version). */
  extra?: Array<[string, string]>;
  /** For plugins: the resource categories (skills, commands, …) the bundle packages. */
  groups?: PluginResourceGroup[];
  /**
   * Machine-shaped fields for `--json`, when the display strings in `extra` would
   * lose information a script needs (a routine's raw cron, its device arrays).
   */
  json?: Record<string, unknown>;
}

export interface InspectOptions {
  brief?: boolean;
  json?: boolean;
  // Drill-down flags. commander treats `--skills [query]` so the value is
  // either undefined (flag absent), true (flag present, no query), or string.
  commands?: boolean | string;
  skills?: boolean | string;
  hooks?: boolean | string;
  mcp?: boolean | string;
  rules?: boolean | string;
  plugins?: boolean | string;
  workflows?: boolean | string;
  subagents?: boolean | string;
  routines?: boolean | string;
  // Singular aliases — required value, always detail mode (see SINGULAR_DRILL_ALIASES).
  command?: string;
  skill?: string;
  hook?: string;
  rule?: string;
  plugin?: string;
  workflow?: string;
  subagent?: string;
  routine?: string;
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerInspectCommand(program: Command): void {
  const cmd = addHostOption(program.command('inspect <target>'))
    .description('Inspect one installed agent harness at one version (not a model), or a DotAgents repo — paths, capabilities, resources, and hook capable/on-disk/wired state.')
    .option('--brief', 'header + capabilities only; skip resources/sessions')
    .option('--json', 'machine-readable JSON output');

  for (const kind of DRILLABLE_KINDS) {
    cmd.option(`--${kind} [query]`, `list ${kind}; pass a name (fuzzy) to show detail`);
  }
  for (const singular of Object.keys(SINGULAR_DRILL_ALIASES)) {
    cmd.option(`--${singular} <query>`, `show detail for one ${singular} by name (fuzzy)`);
  }

  cmd.action(async (target: string, options: InspectOptions) => {
    await inspectAction(target, options);
  });
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────

async function inspectAction(target: string, options: InspectOptions): Promise<void> {
  const agentKey = target.split('@')[0].toLowerCase();
  if (!(agentKey in AGENTS)) {
    const repo = resolveRepoTarget(target);
    if (repo) {
      await inspectRepo(repo, options);
      return;
    }
    // Repo targets take precedence over typo correction; only fall through to
    // parseTarget when the key resolves to an agent (alias or single-edit fix).
    if (!resolveAgentName(agentKey)) {
      const extras = getEnabledExtraRepos();
      console.error(chalk.red(`Unknown target: ${target}`));
      console.error(chalk.gray(`Agents: ${Object.keys(AGENTS).join(', ')}`));
      const aliases = extras.length > 0 ? `, ${extras.map(e => e.alias).join(', ')}` : '';
      console.error(chalk.gray(`Repos:  user, system, project${aliases} — or a path to a repo with a .agents/ dir`));
      process.exit(1);
    }
  }

  const { agent, version } = parseTarget(target);
  const versionHome = getVersionHomePath(agent, version);

  if (!fs.existsSync(versionHome)) {
    console.error(chalk.red(`${agent}@${version} is not installed.`));
    console.error(chalk.gray(`Run 'agents add ${agent}@${version}' first.`));
    process.exitCode = 1;
    return;
  }

  const drill = pickDrillKind(options);

  if (drill) {
    const { kind, query } = drill;
    if (query === true || query === undefined) {
      await renderList(agent, version, versionHome, kind, options);
    } else {
      await renderDetail(agent, version, versionHome, kind, String(query), options);
    }
    return;
  }

  await renderSummary(agent, version, versionHome, options);
}

function parseTarget(target: string): { agent: AgentId; version: string } {
  // Route through the agent-spec engine: bare resolves project pin → global
  // default → sole installed (the meta-only lookup here previously ignored
  // project pins); @default/@latest/@oldest/@x.y.z all handled uniformly.
  try {
    const { agent, version } = resolveSingleAgentTarget(target);
    return { agent, version };
  } catch (e) {
    if (e instanceof AgentSpecError) {
      console.error(chalk.red(e.message));
      process.exit(1);
    }
    throw e;
  }
}

function pickDrillKind(options: InspectOptions): { kind: DrillableKind; query: boolean | string } | null {
  const active: Array<{ flag: string; kind: DrillableKind; query: boolean | string }> = [];
  for (const kind of DRILLABLE_KINDS) {
    const value = options[kind];
    if (value !== undefined) active.push({ flag: `--${kind}`, kind, query: value });
  }
  // Singular aliases (`--plugin code`) always carry a name → detail mode.
  for (const [singular, plural] of Object.entries(SINGULAR_DRILL_ALIASES)) {
    const value = (options as Record<string, unknown>)[singular];
    if (typeof value === 'string') active.push({ flag: `--${singular}`, kind: plural, query: value });
  }
  if (active.length === 0) return null;
  if (active.length > 1) {
    console.error(chalk.red(`Pick at most one drill-down flag. Got: ${active.map(a => a.flag).join(', ')}`));
    process.exit(1);
  }
  return { kind: active[0].kind, query: active[0].query };
}

// ─── Repo targets ────────────────────────────────────────────────────────────

export interface RepoTarget {
  /** Display label: 'user' | 'system' | 'project', an extra-repo alias, or a path-derived name. */
  label: string;
  /** Absolute path to the DotAgents root (the dir holding commands/, skills/, ...). */
  root: string;
}

/** Files at a DotAgents root that mark it as one, beyond the per-kind dirs. */
const REPO_MARKER_FILES = ['agents.yaml', 'hooks.yaml'];

/**
 * Resolve a non-agent target as a DotAgents repo: the built-in layer names,
 * a registered extra-repo alias, or a filesystem path. Paths accept either a
 * DotAgents root itself or a repo whose `.agents/` dir should be inspected.
 * Returns null when the target is none of these.
 */
export function resolveRepoTarget(target: string, cwd?: string): RepoTarget | null {
  if (target === 'user') return { label: 'user', root: getUserAgentsDir() };
  if (target === 'system') return { label: 'system', root: getSystemAgentsDir() };
  if (target === 'project') {
    const dir = getProjectAgentsDir(cwd);
    if (!dir) {
      console.error(chalk.red('No project .agents/ directory found from the current directory.'));
      process.exit(1);
    }
    return { label: 'project', root: dir };
  }

  for (const extra of getEnabledExtraRepos()) {
    if (extra.alias === target) return { label: extra.alias, root: extra.dir };
  }

  const expanded = target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
  const abs = path.resolve(cwd ?? process.cwd(), expanded);
  const stat = safeStat(abs);
  if (!stat || !stat.isDirectory()) return null;

  // A dir literally named `.agents` is the root itself.
  if (path.basename(abs) === '.agents') {
    return { label: path.basename(path.dirname(abs)), root: abs };
  }
  // A nested `.agents/` that is a populated DotAgents root wins over `abs` — the
  // project case (`agents inspect .` from a repo root whose resources live under
  // `.agents/`, while the repo's own top-level `skills/`, `agents.yaml` pin, etc.
  // are unrelated source, not a DotAgents tree).
  const nested = path.join(abs, '.agents');
  if (isDotAgentsRoot(nested)) {
    return { label: path.basename(abs), root: nested };
  }
  // Otherwise treat `abs` itself as the root: standalone clones and extra repos
  // like ~/.agents-extras keep resources at the top level and use `.agents/`
  // only for worktrees (so their nested `.agents/` is not a DotAgents root).
  if (isDotAgentsRoot(abs)) {
    return { label: path.basename(abs), root: abs };
  }
  return null;
}

function isDotAgentsRoot(dir: string): boolean {
  for (const marker of REPO_MARKER_FILES) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  for (const kind of DRILLABLE_KINDS) {
    // `routines/` alone is NOT a marker. Shipping example routine YAML for
    // `agents routines add` is a documented pattern (this repo's own
    // cli/routines/), and that directory is the ONLY kind dir there — so
    // counting it would make `agents inspect cli` resolve a source tree as
    // a DotAgents repo. Same reasoning as the nested-`.agents/` case above.
    if (kind === 'routines') continue;
    if (safeStat(path.join(dir, kind))?.isDirectory()) return true;
  }
  return false;
}

export async function inspectRepo(repo: RepoTarget, options: InspectOptions): Promise<void> {
  const drill = pickDrillKind(options);
  const jsonHead = { repo: repo.label, root: repo.root };

  if (drill) {
    // Routines carry live state, and an unreadable device document silently
    // removes that device from every `devices` cell — say so on this path too,
    // not only in the overview.
    let items: ResourceItem[];
    if (drill.kind === 'routines') {
      const provider = defaultRoutineLive();
      items = collectRepoRoutines(repo, provider.live);
      if (!options.json) {
        for (const err of provider.errors) {
          console.error(chalk.yellow(`device config unreadable — ${err}`));
        }
      }
    } else {
      items = collectRepoKind(repo, drill.kind);
    }
    if (drill.query === true || drill.query === undefined) {
      // A repo's hooks are wired by its OWN agents.yaml, not by whatever this
      // machine has installed centrally — the same manifest the repo overview
      // reads at collectRepoKind.
      await renderItemList(repo.label, jsonHead, drill.kind, items, options,
        drill.kind === 'hooks'
          ? hookManifestByScript(hookManifestFromFile(path.join(repo.root, 'agents.yaml')))
          : undefined);
    } else {
      renderItemDetail(repo.label, jsonHead, drill.kind, String(drill.query), items, options);
    }
    return;
  }

  renderRepoSummary(repo, options);
}

/** List one resource kind from a single repo root — no layering, no overrides. */
export function collectRepoKind(repo: RepoTarget, kind: DrillableKind): ResourceItem[] {
  // Plugins are bundles with a manifest + nested skills/commands/hooks — read
  // them through the plugin discoverer so the manifest description and bundled
  // resources surface, rather than treating each as an opaque directory.
  if (kind === 'plugins') {
    return discoverPluginsInDir(path.join(repo.root, 'plugins'))
      .map(p => pluginToItem(p, repo.label))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Hooks live nested under event directories (`hooks/pre-tool-use/…`), and a
  // script pairs with its data sidecar. repoHookItems already reads them that
  // way for the summary view; a flat readdir here returned the event dirs
  // themselves plus README/test scaffolding, so `--hooks` and the summary
  // reported different counts for the same repo.
  if (kind === 'hooks') return repoHookItems(repo);

  // A repo's `rules/` holds the COMPOSED output (AGENTS.md plus its CLAUDE.md /
  // GEMINI.md symlinks) alongside a `subrules/` dir of the individually named
  // fragments. The fragments are what `--rule <name>` resolves and what a reader
  // means by "a rule"; the composed file is a build artifact. Without this,
  // `subrules` listed as a single opaque leaf and every real rule was unreachable.
  // Deliberately exclusive: once `subrules/` exists it is the sole home for
  // rules (composeRules only ever resolves names under it — lib/rules/compose.ts),
  // so loose top-level `.md` files are not listed. A repo mid-migration to the
  // subrules convention would see those legacy files disappear from `--rules`;
  // that is the correct signal, since composeRules would not load them either.
  if (kind === 'rules') {
    const subrulesDir = path.join(repo.root, kind, 'subrules');
    if (fs.existsSync(subrulesDir)) return readResourceDir(subrulesDir, kind, repo.label);
  }

  // Routines are YAML job definitions whose real state (does it fire, where, how
  // did it last run) lives outside the file. Their directory also holds
  // `<name>/home/` sandbox overlays, which a flat readdir would count as
  // routines — on this author's box that turned 24 routines into 49.
  if (kind === 'routines') return collectRepoRoutines(repo);

  return readResourceDir(path.join(repo.root, kind), kind, repo.label);
}

// ─── Routines ────────────────────────────────────────────────────────────────

/** The live answers about one routine — what the YAML alone cannot say. */
export interface RoutineLiveState {
  /** Devices whose `routines:` allowlist names it. Empty means it fires nowhere. */
  devices: string[];
  /** False until some device has materialized an allowlist at all. */
  materialized: boolean;
  /** This machine's name, for reporting whether the routine is enabled here. */
  thisDevice: string;
  /**
   * THIS machine's activation answer, from `routineEnabledOnThisDevice` — the
   * same call `applyDeviceActivation` makes. `null` means this device has not
   * materialized its own allowlist, so the file's `enabled:` still governs.
   *
   * Deliberately separate from `materialized`, which is fleet-wide: a box whose
   * own device doc has no `routines:` key while a synced peer's does is the
   * normal state of a freshly-joined machine, and conflating the two reported
   * `enabled: no` for routines the daemon was actively firing.
   */
  enabledHere: boolean | null;
  /** Last run's status, or null if it has never run on a device we can see. */
  lastStatus: RunMeta['status'] | null;
  /** ISO timestamp of that run's start. */
  lastAt: string | null;
}

const NO_LIVE_STATE: RoutineLiveState = {
  devices: [], materialized: false, thisDevice: '', enabledHere: null, lastStatus: null, lastAt: null,
};

/**
 * Whether the routine actually runs on this machine.
 *
 * Exactly `applyDeviceActivation` (`lib/routines.ts`): this device's own
 * allowlist answer wins when it exists, and the file's `enabled:` governs only
 * while that answer is `null`. Measured at the same scope as the daemon's, so
 * `agents inspect --routines` and `agents routines list` cannot disagree.
 */
function routineEnabledHere(config: JobConfig, live: RoutineLiveState): boolean {
  return live.enabledHere === null ? config.enabled : live.enabledHere;
}

/**
 * The last run we can read, without paying for the whole history.
 *
 * `getLatestRun` goes through `listRuns`, which parses EVERY meta.json under the
 * routine — one firing every 3 minutes accumulates hundreds. Run ids are ISO-ish
 * and sort lexicographically, so walking from the newest and stopping at the
 * first readable record gives the same answer for a bounded number of reads.
 */
function latestRunOf(name: string, maxProbes = 20): RunMeta | null {
  let runIds: string[];
  try {
    runIds = fs.readdirSync(getJobRunsDir(name), { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse();
  } catch { return null; }

  for (const runId of runIds.slice(0, maxProbes)) {
    const meta = readRunMeta(name, runId);
    if (meta) return meta;
  }
  return null;
}

/**
 * Default live provider: one fleet index per collect, one bounded run read per
 * routine, and this device's own activation answer per routine.
 *
 * Returns the collected `errors` alongside so the caller can surface an
 * unreadable device document instead of letting the affected device silently
 * vanish from every `devices` cell.
 */
function defaultRoutineLive(): { live: (name: string) => RoutineLiveState; errors: string[] } {
  let index: RoutineDeviceIndex;
  try {
    index = routineDeviceIndex();
  } catch (err) {
    return { live: () => NO_LIVE_STATE, errors: [(err as Error).message] };
  }
  const thisDevice = (() => { try { return currentRoutineDevice(); } catch { return ''; } })();
  const errors = [...index.errors];

  // This device's own doc is read through readMeta, which THROWS on a corrupt
  // one. Falling back to the file's `enabled:` silently would be the same
  // silent-failure class the index's error collection just removed, so record it
  // once — the answer is identical for every routine on this machine.
  let ownDocError: string | null = null;
  const enabledOnThisDevice = (name: string): boolean | null => {
    try {
      return routineEnabledOnThisDevice(name);
    } catch (err) {
      if (!ownDocError) {
        ownDocError = `this device's own config is unreadable — ${(err as Error).message}`;
        errors.push(ownDocError);
      }
      return null;
    }
  };

  const live = (name: string): RoutineLiveState => {
    const run = latestRunOf(name);
    return {
      devices: index.byRoutine.get(name) ?? [],
      materialized: index.materialized,
      thisDevice,
      // The same call applyDeviceActivation makes — per-machine, not fleet-wide.
      enabledHere: enabledOnThisDevice(name),
      lastStatus: run?.status ?? null,
      lastAt: run?.startedAt ?? null,
    };
  };
  return { live, errors };
}

/** `2h` / `3d` / `just now` — compact enough for a 10-column cell. */
export function compactAge(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((now.getTime() - then) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

/** What makes this routine fire: a humanized cron, an event trigger, or nothing. */
export function routineFireLabel(job: JobConfig, now: Date = new Date()): string {
  const parts: string[] = [];
  if (job.schedule) parts.push(humanizeCron(job.schedule, job.timezone));
  if (job.trigger) {
    const t = job.trigger as { type?: unknown; event?: unknown; action?: unknown; label?: unknown };
    const event = manifestText(t.event) || manifestText(t.type) || 'event';
    const qualifier = [manifestText(t.action), manifestText(t.label)].filter(Boolean).join(' ');
    parts.push(qualifier ? `on ${event} (${qualifier})` : `on ${event}`);
  }
  if (parts.length === 0) return 'no schedule or trigger';
  if (isOneShotRoutine(job)) {
    parts.push(isPastOneShotRoutine(job, now) ? '(one-shot, expired)' : '(one-shot)');
  }
  return parts.join(' · ');
}

/** What the routine actually executes. Exactly one of agent/workflow/command is set. */
export function routineTargetLabel(job: JobConfig): string {
  const agent = manifestText(job.agent);
  if (agent) return `agent ${agent}`;
  const workflow = manifestText(job.workflow);
  if (workflow) return `workflow ${workflow}`;
  if (manifestText(job.command)) return 'command (shell)';
  return 'nothing configured';
}

/**
 * A routine's one-line intent.
 *
 * Routine YAML has no `description:` key, so the generic first-prose-line reader
 * returns `name: growth-metrics` for one file and a real sentence for the next.
 * Prefer the prompt's first sentence, then the file's leading comment block, then
 * the first meaningful line of a shell command.
 */
export function routineDescription(job: JobConfig | null, raw: string): string {
  const prompt = job ? manifestText(job.prompt).trim() : '';
  if (prompt) return summaryLine(truncate(prompt.replace(/\s+/g, ' '), 400));

  const lines = raw.split('\n');
  for (const line of lines) {
    const comment = line.match(/^\s*#\s?(.+)$/);
    if (!comment) { if (line.trim()) break; else continue; }
    const text = comment[1].trim().replace(/^Routine:\s*/i, '');
    // Skip the shebang-ish and install-instruction noise that opens many files.
    if (!text || /^(yaml-language-server|Install:|Usage:)/i.test(text)) continue;
    return summaryLine(text);
  }

  const command = job ? manifestText(job.command) : '';
  for (const line of command.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#') || /^set\s+-/.test(text)) continue;
    return truncate(text, 120);
  }
  return '';
}

/**
 * Read every routine one DotAgents repo declares.
 *
 * Reads exactly `<root>/routines/`, never the layered `listJobs` — `collectRepoKind`
 * is a single-root view, and returning `~/.agents` routines while inspecting a
 * project repo would be a lie. `live` is injectable because `getUserAgentsDir()`
 * and `getRunsDir()` have no env override, so tests cannot otherwise keep this
 * off the developer's real fleet state.
 */
export function collectRepoRoutines(
  repo: RepoTarget,
  live: (name: string) => RoutineLiveState = defaultRoutineLive().live,
  now: Date = new Date(),
): ResourceItem[] {
  const dir = path.join(repo.root, 'routines');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }

  const items: ResourceItem[] = [];
  const seen = new Map<string, ResourceItem>();

  // Files only: `routines/<name>/home/` is a sandbox overlay HOME, not a routine.
  //
  // `.yml` before `.yaml` for the same basename, because that is the order
  // `readJobFromDir` tries — so when both exist we describe the file the daemon
  // actually loads. A plain alphabetical sort put `.yaml` first and reported the
  // wrong schedule and command for a routine that fires from its sibling.
  const files = entries
    .filter(e => e.isFile() && /\.ya?ml$/.test(e.name) && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => {
      const an = a.replace(/\.ya?ml$/, ''), bn = b.replace(/\.ya?ml$/, '');
      if (an !== bn) return an.localeCompare(bn);
      return (a.endsWith('.yml') ? 0 : 1) - (b.endsWith('.yml') ? 0 : 1);
    });

  for (const file of files) {
    const filePath = path.join(dir, file);
    const { config, problem } = readJobFileResult(filePath);
    const basename = file.replace(/\.ya?ml$/, '');
    const name = config?.name || basename;

    const existing = seen.get(name);
    if (existing) {
      // `writeJob` refuses to edit a routine with both extensions. Keep the item
      // built from the file that loads, and flag the ambiguity on it — in `extra`
      // for the panes AND in `json` so a --json consumer sees it too.
      const collision = `both .yml and .yaml exist — ${file} is ignored; resolve before editing`;
      existing.extra = [...(existing.extra ?? []), ['problem', collision]];
      if (existing.json) existing.json.problem = collision;
      continue;
    }

    const raw = (() => { try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; } })();
    const state = config ? live(name) : NO_LIVE_STATE;
    const extra: Array<[string, string]> = [];

    if (config) {
      extra.push(['fires', routineFireLabel(config, now)]);
      extra.push(['runs', routineTargetLabel(config)]);
      extra.push(['devices', state.devices.length > 0
        ? state.devices.join(', ')
        : state.materialized ? 'no device — will not fire' : 'no device allowlist yet']);
      extra.push(['last', state.lastStatus
        ? `${state.lastStatus}${state.lastAt ? ` · ${compactAge(state.lastAt, now)} ago` : ''}`
        : 'never run']);
      extra.push(['enabled', routineEnabledHere(config, state)
        ? `yes${state.thisDevice ? ` (on ${state.thisDevice})` : ''}`
        : `no${state.thisDevice ? ` (on ${state.thisDevice})` : ''}`]);
      const repoRef = manifestText(config.repo);
      if (repoRef) extra.push(['repo', repoRef]);
      const tz = manifestText(config.timezone);
      if (tz) extra.push(['timezone', tz]);
      if (config.catchup === false) extra.push(['catchup', 'off — a missed fire is lost']);
      const host = manifestText(config.host);
      if (host) extra.push(['host', host]);
      const pinned = manifestList(config.devices);
      if (pinned.length > 0) extra.push(['pinned', pinned.join(', ')]);
      if (name !== basename) extra.push(['file', file]);
    } else if (problem) {
      extra.push(['problem', problem]);
    }

    const item: ResourceItem = {
      name,
      source: repo.label,
      path: filePath,
      linkTarget: filePath,
      description: routineDescription(config, raw),
      extra,
      // Field names match `agents routines list --json` where they overlap, so
      // one script can consume both. `devices` is what the YAML pins;
      // `enabledDevices` is what the fleet actually allows — the diagnostic pair.
      json: {
        path: filePath,
        schedule: config?.schedule ?? null,
        scheduleHuman: config ? routineFireLabel(config, now) : null,
        trigger: config?.trigger ?? null,
        runs: config ? routineTargetLabel(config) : null,
        agent: config?.agent ?? null,
        workflow: config?.workflow ?? null,
        command: config?.command ?? null,
        timezone: config?.timezone ?? null,
        repo: config?.repo ?? null,
        // Effective on THIS machine, matching `agents routines list`.
        enabled: config ? routineEnabledHere(config, state) : false,
        // What the file itself declares, before device activation overrides it.
        enabledInFile: config?.enabled ?? false,
        catchup: config ? config.catchup !== false : null,
        devices: config ? manifestList(config.devices) : [],
        enabledDevices: state.devices,
        activationMaterialized: state.materialized,
        oneShot: config ? isOneShotRoutine(config) : false,
        expired: config ? isPastOneShotRoutine(config, now) : false,
        lastStatus: state.lastStatus,
        lastRunAt: state.lastAt,
        problem,
      },
    };
    seen.set(name, item);
    items.push(item);
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one `extra` row back out — the renderers' only accessor. */
function extraOf(item: ResourceItem, key: string): string {
  return item.extra?.find(([k]) => k === key)?.[1] ?? '';
}

/**
 * Enumerate one directory of resources of `kind`, skipping dotfiles, build caches,
 * and directory docs. Shared so the rules `subrules/` branch and the default
 * `<repo>/<kind>/` branch cannot drift apart.
 */
function readResourceDir(dir: string, kind: Exclude<DrillableKind, 'plugins' | 'routines'>, source: string): ResourceItem[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }

  const items: ResourceItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    // Build/tooling caches are never resources — they only inflate counts.
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const name = entry.name.replace(/\.(md|yaml|yml|toml|json)$/, '');
    // README/AGENTS/CLAUDE/GEMINI describe the directory, not resources of this
    // kind. CLAUDE.md/GEMINI.md are symlinks to AGENTS.md, so a Dirent reports
    // isFile() === false — use !isDirectory() to catch them (mirrors resources.ts).
    if (!entry.isDirectory() && isDirectoryDoc(kind, name)) continue;
    const p = path.join(dir, entry.name);
    items.push({
      name,
      source,
      path: p,
      linkTarget: linkTarget(p),
      description: readDescription(p),
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

/** A few resource names for the at-a-glance preview, with a `…(+N)` tail. */
function previewNames(items: ResourceItem[], n: number): string {
  if (items.length === 0) return '';
  const shown = items.slice(0, n).map(i => i.name);
  const extra = items.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` …(+${extra})` : '');
}

/** Recursive size + file count of a path; symlinks are not followed. */
export function pathSize(p: string): { bytes: number; files: number } {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(p); } catch { return { bytes: 0, files: 0 }; }
  if (stat.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (stat.isFile()) return { bytes: stat.size, files: 1 };
  if (!stat.isDirectory()) return { bytes: 0, files: 0 };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return { bytes: 0, files: 0 }; }
  let bytes = 0, files = 0;
  for (const e of entries) {
    const sub = pathSize(path.join(p, e.name));
    bytes += sub.bytes; files += sub.files;
  }
  return { bytes, files };
}

/**
 * Weigh only the entries actually listed, for a kind whose directory holds more
 * than its resources (routines share theirs with sandbox overlay HOMEs).
 */
function itemsSize(items: ResourceItem[]): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  for (const item of items) {
    const sub = pathSize(item.path);
    bytes += sub.bytes; files += sub.files;
  }
  return { bytes, files };
}

/** Human byte size: "84 KB", "3.1 MB". */
interface ManifestSummary {
  /** `run.<agent>.strategy` pairs from agents.yaml. */
  strategies: Array<{ agent: string; strategy: string }>;
  /** `agents.<agent>` version pins from agents.yaml, when present. */
  versions: Array<{ agent: string; version: string }>;
}

/** Parse the repo's own agents.yaml into the version pins + run strategies it declares. */
export function repoManifestSummary(root: string): ManifestSummary | null {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fs.readFileSync(path.join(root, 'agents.yaml'), 'utf-8'));
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const strategies: ManifestSummary['strategies'] = [];
  if (obj.run && typeof obj.run === 'object') {
    for (const [agent, cfg] of Object.entries(obj.run as Record<string, unknown>)) {
      const strategy = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).strategy : undefined;
      if (typeof strategy === 'string') strategies.push({ agent, strategy });
    }
  }

  const versions: ManifestSummary['versions'] = [];
  if (obj.agents && typeof obj.agents === 'object') {
    for (const [agent, ver] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (typeof ver === 'string') versions.push({ agent, version: ver });
    }
  }

  if (strategies.length === 0 && versions.length === 0) return null;
  return { strategies, versions };
}

function renderRepoSummary(repo: RepoTarget, options: InspectOptions): void {
  const git = repoGitInfo(repo.root);
  const manifests = REPO_MARKER_FILES.filter(m => fs.existsSync(path.join(repo.root, m)));
  const manifest = repoManifestSummary(repo.root);

  const kindData = {} as Record<DrillableKind, { items: ResourceItem[]; size: { bytes: number; files: number } }>;
  let totalBytes = 0, totalFiles = 0;
  let repoHookByScript: Map<string, ManifestHook> = new Map();
  let repoMcpConfigs: Map<string, McpYamlConfig> = new Map();
  let routineActivationErrors: string[] = [];
  if (!options.brief) {
    for (const kind of DRILLABLE_KINDS) {
      // Routines share one live provider across the collect so the fleet index is
      // read once, and so its errors survive to be reported below.
      let items: ResourceItem[];
      if (kind === 'routines') {
        const provider = defaultRoutineLive();
        routineActivationErrors = provider.errors;
        items = collectRepoRoutines(repo, provider.live);
      } else {
        items = collectRepoKind(repo, kind);
      }
      // `routines/` also holds `<name>/home/` sandbox overlays — often far larger
      // than the definitions and not resources at all, so weigh the files listed
      // rather than the directory tree.
      const size = kind === 'routines' ? itemsSize(items) : pathSize(path.join(repo.root, kind));
      kindData[kind] = { items, size };
      totalBytes += size.bytes; totalFiles += size.files;
    }
    repoHookByScript = hookManifestByScript(hookManifestFromFile(path.join(repo.root, 'agents.yaml')));
    repoMcpConfigs = new Map(discoverMcpConfigsFromRepo(repo.root).map(s => [s.name, s.config]));
  }

  if (options.json) {
    console.log(JSON.stringify({
      repo: repo.label,
      root: repo.root,
      git,
      manifests,
      manifest,
      size: options.brief ? null : { bytes: totalBytes, files: totalFiles },
      resources: options.brief ? null : Object.fromEntries(
        DRILLABLE_KINDS.map(kind => {
          const size = kindData[kind].size;
          const items = kindData[kind].items;
          const base = {
            count: items.length,
            bytes: size.bytes,
            files: size.files,
            names: items.map(i => i.name),
          };
          if (kind === 'hooks') return [kind, { ...base, items: items.map(i => {
            const h = repoHookByScript.get(i.name);
            return { name: i.name, events: h?.events ?? [], matcher: h?.matcher, matches: h?.matches, cache: h?.cache };
          }) }];
          if (kind === 'mcp') return [kind, { ...base, items: items.map(i => {
            const c = repoMcpConfigs.get(i.name);
            return { name: i.name, transport: c?.transport, url: c?.url, command: c?.command, args: c?.args };
          }) }];
          if (kind === 'plugins') return [kind, { ...base, items: items.map(i => ({
            name: i.name,
            version: i.extra?.find(([k]) => k === 'version')?.[1],
            groups: Object.fromEntries((i.groups ?? []).map(g => [g.label, g.items.length])),
          })) }];
          if (kind === 'routines') return [kind, { ...base, items: items.map(i => ({
            name: i.name,
            description: i.description,
            ...(i.json ?? {}),
          })) }];
          return [kind, base];
        }),
      ),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(repo.label) + '  ' + chalk.gray('[dotagents repo]') + '\n');

  // Indent for continuation sub-rows: 2 leading + 10 key column + 1 space.
  const sub = (label: string, value: string) => console.log(`  ${''.padEnd(10)} ${chalk.gray(label.padEnd(8))} ${value}`);

  console.log(`  ${'root'.padEnd(10)} ${termLink(repo.root, repo.root)}`);

  if (git) {
    const dirty = git.dirty > 0 ? ` ${chalk.gray('·')} ${chalk.yellow(`${git.dirty} dirty`)}` : '';
    const url = git.url ? ` ${chalk.gray('·')} ${chalk.gray(git.url)}` : '';
    console.log(`  ${'git'.padEnd(10)} ${git.branch}${dirty}${url}`);
    if (git.lastCommit) {
      const rel = git.lastCommit.relative ? `  ${chalk.gray(`(${git.lastCommit.relative})`)}` : '';
      const prefix = `  ${''.padEnd(10)} ${chalk.gray('last'.padEnd(8))} `;
      const sha = chalk.cyan(git.lastCommit.sha);
      const subjectWidth = Math.max(8, terminalWidth() - stringWidth(prefix) - stringWidth(sha) - 2 - stringWidth(rel));
      console.log(`${prefix}${sha}  ${truncateToWidth(git.lastCommit.subject, subjectWidth)}${rel}`);
    }
    if (git.ahead !== null && git.behind !== null && (git.ahead > 0 || git.behind > 0)) {
      sub('sync', `ahead ${git.ahead} ${chalk.gray('·')} behind ${git.behind}`);
    }
    if (git.dirtyFiles.length > 0) {
      const shown = git.dirtyFiles.slice(0, 4).join(', ');
      const extra = git.dirtyFiles.length - Math.min(4, git.dirtyFiles.length);
      sub('dirty', chalk.yellow(shown + (extra > 0 ? ` …(+${extra})` : '')));
    }
  }

  if (manifests.length > 0) {
    console.log(`  ${'manifests'.padEnd(10)} ${manifests.join(', ')}`);
    if (manifest) {
      if (manifest.versions.length > 0) {
        const prefix = `  ${''.padEnd(10)} ${chalk.gray('versions'.padEnd(8))} `;
        printWrappedJoined(prefix, manifest.versions.map(v => `${v.agent} ${chalk.cyan(v.version)}`), chalk.gray(' · '));
      }
      if (manifest.strategies.length > 0) {
        const prefix = `  ${''.padEnd(10)} ${chalk.gray('run'.padEnd(8))} `;
        printWrappedJoined(prefix, manifest.strategies.map(s => `${s.agent}:${s.strategy}`), chalk.gray(' · '));
      }
    }
  }

  if (!options.brief) {
    console.log(`  ${'size'.padEnd(10)} ${formatBytes(totalBytes)} ${chalk.gray('·')} ${totalFiles} ${totalFiles === 1 ? 'file' : 'files'}`);

    console.log('\n' + chalk.bold('Resources'));
    for (const kind of SIMPLE_KINDS) {
      const { items, size } = kindData[kind];
      const count = String(items.length).padStart(4);
      const sz = items.length > 0 ? formatBytes(size.bytes).padStart(8) : ''.padEnd(8);
      // Width-aware, not a fixed 60: the old cap cut its own "…(+16)" tail off
      // the rules row identically at 80, 100 and 160 columns.
      const prefix = `  ${kind.padEnd(10)} ${count}  ${sz}  `;
      const preview = items.length > 0
        ? chalk.gray(truncateToWidth(previewNames(items, 4), Math.max(12, terminalWidth() - stringWidth(prefix))))
        : '';
      console.log(`${prefix}${preview}`.trimEnd());
    }

    printExpandedSection('Hooks', hookRows(kindData.hooks.items, repoHookByScript));
    printExpandedSection('Plugins', pluginRows(kindData.plugins.items));
    printExpandedSection('MCP', mcpRows(kindData.mcp.items, repoMcpConfigs));
    printExpandedSection('Routines', routineRows(kindData.routines.items));
    const dark = routineDarkWarning(kindData.routines.items);
    if (dark) {
      console.log('');
      console.log(`  ${chalk.yellow('⚠')}  ${dark}`);
      console.log(chalk.gray(`     Fix:  agents routines devices <name> --set <device>`));
    }
    // An unreadable device document silently removes that device from every
    // `devices` cell, which reads as "not enabled there" — say so instead.
    for (const err of routineActivationErrors) {
      console.log(chalk.gray(`  device config unreadable — ${err}`));
    }
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${repo.label} --skills <query>`));
  console.log('');
}

interface RepoGitInfo {
  branch: string;
  dirty: number;
  dirtyFiles: string[];
  url: string | null;
  lastCommit: { sha: string; subject: string; relative: string } | null;
  ahead: number | null;
  behind: number | null;
}

export function repoGitInfo(root: string): RepoGitInfo | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    } catch { return null; }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return null;

  // Read status WITHOUT trimming — trimming would strip the leading
  // space of the first porcelain line (`XY path`), corrupting the path slice.
  let statusRaw: string | null;
  try {
    statusRaw = execFileSync('git', ['-C', root, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  } catch { statusRaw = null; }
  const dirtyFiles = statusRaw ? statusRaw.split('\n').filter(Boolean).map(l => l.slice(3)) : [];

  let lastCommit: RepoGitInfo['lastCommit'] = null;
  const log = git(['log', '-1', '--format=%h%x1f%s%x1f%cr']);
  if (log) {
    const [sha, subject, relative] = log.split('\x1f');
    if (sha) lastCommit = { sha, subject: subject ?? '', relative: relative ?? '' };
  }

  let ahead: number | null = null, behind: number | null = null;
  const counts = git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  if (counts) {
    const [b, a] = counts.split(/\s+/).map(n => parseInt(n, 10));
    if (Number.isFinite(b) && Number.isFinite(a)) { behind = b; ahead = a; }
  }

  return { branch, dirty: dirtyFiles.length, dirtyFiles, url: git(['remote', 'get-url', 'origin']), lastCommit, ahead, behind };
}

// ─── Summary mode ────────────────────────────────────────────────────────────

async function renderSummary(agent: AgentId, version: string, versionHome: string, options: InspectOptions): Promise<void> {
  const meta = readMeta();
  const isDefault = meta.agents?.[agent] === version;
  const strategy = meta.run?.[agent]?.strategy ?? 'pinned';
  const cliState = await getCliState(agent).catch(() => null);

  const configSymlink = path.join(os.homedir(), `.${agent}`);
  const configTarget = readSymlinkSafe(configSymlink);

  // Report the bare shim only when it is actually there. An isolated install
  // deliberately has none — that is the promise — so printing the path
  // unconditionally told the user this copy sits on their PATH when it does not.
  // Same failure mode as `agents view` claiming an isolated copy was `(global)`.
  const shimPathIfPresent = fs.existsSync(path.join(getShimsDir(), AGENTS[agent].cliCommand))
    ? path.join(getShimsDir(), AGENTS[agent].cliCommand)
    : null;
  const aliasPath = getVersionedAliasPath(agent, version);
  const isolated = isVersionIsolated(agent, version);
  // `default` means the GLOBAL default, which an isolated copy can never be. Report
  // the isolated pointer separately rather than leaving it invisible: it is what a
  // bare `agents run <agent>` resolves to, so "default: false" alone is misleading.
  const isIsolatedDefault = isolated && getIsolatedDefault(agent) === version;

  const capabilities = collectCapabilities(agent, version);

  const itemsByKind = options.brief ? null : collectItemsByKind(agent, versionHome);
  const hookInventory = options.brief ? null : getResourceInventory(agent, version, 'hooks');
  const hookByScript = options.brief ? null : hookManifestByScript(loadCentralHookManifest());
  const mcpConfigs = options.brief ? null : new Map(listMcpServerConfigs().map(s => [s.name, s.config]));

  const sessions = options.brief ? null : {
    total: safeCountSessions(agent),
  };

  if (options.json) {
    const modeCat = getAgentModesCatalog(agent, version);
    const json = {
      agent,
      version,
      default: isDefault,
      isolated,
      isolatedDefault: isIsolatedDefault,
      home: versionHome,
      configSymlink: configTarget ? { from: configSymlink, to: configTarget } : null,
      shim: shimPathIfPresent,
      alias: aliasPath,
      strategy,
      installedShim: cliState?.installed === true ? cliState.path : null,
      capabilities,
      modes: {
        supported: modeCat.modes.map((m) => m.mode),
        defaultMode: modeCat.defaultMode,
        configuredMode: modeCat.configuredMode,
        headlessPlan: modeCat.headlessPlan,
        unsupported: modeCat.unsupported,
      },
      resources: itemsByKind ? summaryResourcesJson(itemsByKind, hookByScript!, mcpConfigs!, hookInventory!) : null,
      sessions,
    };
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  // Plain text — model sits right beside the version, same priority (no label).
  const configuredModel = resolveConfiguredModel(agent, version)?.model;
  const modelPart = configuredModel ? '  ' + chalk.yellow(configuredModel) : '';
  const head = `${chalk.bold(agent)} ${chalk.gray('@')} ${chalk.cyan(version)}${modelPart}${isDefault ? '  ' + chalk.green('[default]') : ''}${isolated ? '  ' + chalk.gray(isIsolatedDefault ? '[isolated default]' : '[isolated]') : ''}`;
  console.log('\n' + head + '\n');

  const rows: Array<[string, string]> = [
    ['install', versionHome],
    ['config', configTarget ? `${configSymlink}  ${chalk.gray('→')}  ${configTarget}` : chalk.gray('(no symlink)')],
    ['shim', shimPathIfPresent ?? chalk.gray(isolated ? '(none — isolated installs stay off PATH)' : '(none)')],
    ['alias', aliasPath],
    ['strategy', strategy],
  ];
  for (const [k, v] of rows) {
    const prefix = `  ${k.padEnd(10)} `;
    console.log(prefix + truncateValueForPrefix(prefix, v));
  }

  console.log('\n' + chalk.bold('Capabilities'));
  for (const cap of CAPABILITY_NAMES) {
    const res = capabilities[cap];
    const mark = res.ok ? chalk.green('✓') : chalk.red('✗');
    const reason = res.ok ? '' : chalk.gray(`(${res.reason}${res.need ? ' ' + res.need : ''})`);
    console.log(`  ${cap.padEnd(10)} ${mark} ${reason}`);
  }
  // Permission modes are a separate axis from the capability booleans above —
  // same data as `agents modes <agent>`, kept next to the rest of the inspect
  // surface so a human/agent does not have to leave this view.
  {
    const modeCat = getAgentModesCatalog(agent, version);
    const modeList = modeCat.modes.map((m) => (m.isDefault ? `${m.mode}*` : m.mode)).join('/');
    const cfg = modeCat.configuredMode ? chalk.gray(`  run default: ${modeCat.configuredMode}`) : '';
    console.log(`  ${'modes'.padEnd(10)} ${chalk.cyan(modeList)}${cfg}`);
    console.log(chalk.gray(`             agents modes ${agent}  ·  agents models ${agent}@${version}`));
  }

  if (itemsByKind) {
    console.log('\n' + chalk.bold('Resources'));
    for (const kind of SIMPLE_KINDS) {
      printSimpleResourceRow(kind, itemsByKind[kind]);
    }
    console.log(`  ${chalk.bold('Hooks')}  ${chalk.gray(formatHookInventoryCounts(hookInventory!))}`);
    printExpandedSection('Hook files', hookRows(itemsByKind.hooks, hookByScript!));
    printExpandedSection('Plugins', pluginRows(itemsByKind.plugins));
    printExpandedSection('MCP', mcpRows(itemsByKind.mcp, mcpConfigs!));
    printExpandedSection('Routines', agentRoutineRows(itemsByKind.routines));
  }

  if (sessions) {
    console.log('\n' + chalk.bold('Sessions'));
    console.log(`  ${'total'.padEnd(10)} ${sessions.total}   ${chalk.gray('(across all versions)')}`);
  }

  console.log('');
  console.log(chalk.gray(`Drill in:   agents inspect ${agent}@${version} --skills <query>`));
  console.log(chalk.gray(`Diagnose:   agents doctor ${agent}@${version}`));
  console.log('');
}

// ─── List mode ───────────────────────────────────────────────────────────────

async function renderList(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  await renderItemList(`${agent}@${version}`, { agent, version }, kind, items, options);
}

async function renderItemList(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, items: ResourceItem[], options: InspectOptions, hookManifest?: Map<string, ManifestHook>): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      count: items.length,
      items: items.map(i => ({
        name: i.name,
        source: i.source,
        path: i.path,
        description: i.description,
        ...(i.groups ? { groups: i.groups } : {}),
        ...(i.json ?? {}),
      })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} (${items.length})`) + '\n');

  if (items.length === 0) {
    console.log(chalk.gray(`  (none installed)`));
    console.log('');
    return;
  }

  // Route through the shared resource view: an interactive picker with a live
  // preview in a TTY, a plain aligned table when piped. This is the same
  // renderer `agents skills list`, `agents commands` and four others already
  // use — inspect was the last drill-down printing its own two-line-per-entry
  // dump with a `[source]` tag repeated on every row.
  //
  // Sync targets are deliberately off: for a repo the resources ARE the source,
  // so the column would read "no installed versions" for every row.
  const sources = new Set(items.map(i => i.source));
  // A hook has no prose description — it is a script. Leaving the column blank
  // is honest but useless, so it carries what the Hooks view is actually for:
  // the events that fire it. Same string the overview prints.
  const hookEvents = kind !== 'hooks' ? null : (hookManifest ?? hookManifestByScript(loadCentralHookManifest()));
  // A routine's byte size says nothing; whether it last ran, and where it is
  // allowed to run, is the whole question. Devices needs the room, so it only
  // takes a column on a wide terminal — below that it folds into the description
  // rather than being dropped.
  const isRoutines = kind === 'routines';
  const routineDevicesColumn = isRoutines && terminalWidth() >= 100;
  await showResourceList({
    resourcePlural: kind,
    resourceSingular: kind.replace(/s$/, ''),
    extraLabel: isRoutines ? 'Last' : 'Size',
    // Only carry a source column when the rows actually differ; a uniform
    // `[.system]` on every row is 13 columns spent on one bit of information.
    extra2Label: routineDevicesColumn ? 'Devices' : (isRoutines ? undefined : (sources.size > 1 ? 'Source' : undefined)),
    showSync: false,
    // inspect's names run long — hook scripts (`00-agent-verify-work-complete`
    // and its `_test` sibling) and namespaced plugin entries (`/swarm:orchestrate`)
    // both blow past the 22-char default and truncate to the same string.
    //
    // Gate on terminal width, NOT on "do any rows have a description": that
    // proxy depended on which path built the items — the repo path hardcodes an
    // empty description so it widened, while the agent path filled one from the
    // script's shebang so it never did. Same command, two behaviours.
    nameCap: terminalWidth() >= 120 ? 40 : undefined,
    // Keep names clickable — the pre-picker list wrapped every name in an OSC-8
    // link to its file, and losing that would be a silent capability regression.
    linkFor: row => items.find(i => i.name === row.name)?.linkTarget,
    emptyMessage: `  (none installed)`,
    rows: items.map(item => ({
      name: item.name,
      description: (() => {
        const hook = hookEvents?.get(item.name);
        if (hook) return summarizeHook(hook);
        if (isRoutines) {
          const problem = extraOf(item, 'problem');
          if (problem) return problem;
          // Compose at the row, leaving item.description pure prose for JSON.
          // Also makes "daily" and "zion" searchable in the picker's filter.
          return [
            extraOf(item, 'fires'),
            routineDevicesColumn ? '' : compactDeviceCell(extraOf(item, 'devices')),
            summaryLine(item.description),
          ].filter(Boolean).join(' · ');
        }
        return summaryLine(item.description);
      })(),
      extra: isRoutines ? routineLastCell(item) : itemSizeLabel(item.path),
      extra2: routineDevicesColumn
        ? compactDeviceCell(extraOf(item, 'devices')) || 'none'
        : (isRoutines ? undefined : (sources.size > 1 ? item.source : undefined)),
      targets: [],
      // Pass the resolved manifest: the picker rebuilds this on every arrow
      // key, so re-reading ~11 KB of YAML per keystroke is wasted work on top
      // of being the wrong manifest for a repo target.
      buildDetail: () => previewFor(kind, item, hookEvents ?? new Map()),
    })),
  });

  // On a TTY the picker's preview pane carries each plugin's bundled skills and
  // commands. Piped, there is no pane — and the pre-picker output printed those
  // lines under every row, so a table alone would silently drop what a plugin
  // actually ships from `agents inspect . --plugins | grep`.
  if (!isInteractiveTerminal() && items.some(i => i.groups?.length)) {
    for (const item of items) {
      if (!item.groups?.length) continue;
      console.log('\n' + chalk.cyan(item.name));
      const width = Math.max(...item.groups.map(g => g.label.length));
      for (const g of item.groups) {
        const colorFn = PLUGIN_GROUP_COLORS[g.label] ?? chalk.white;
        // Wrapped, not truncated: routing these through a truncating helper is
        // what once showed 4 of a 10-command plugin at 80 columns.
        printWrappedJoined(`  ${chalk.gray(g.label.padEnd(width))}  `, g.items.map(s => colorFn(s)), ', ');
      }
    }
    console.log('');
  }
}

/**
 * The scannable half of a description: everything before the trigger clause, and
 * only the first sentence of that. 15 of 20 skills in .system lead with their
 * purpose and then append "Triggers on: …" — in a one-line row that boilerplate
 * is what survives truncation, so the row says nothing. The full text still
 * renders in the preview pane.
 */
export function summaryLine(description: string): string {
  if (!description) return '';
  const cutAtTrigger = description.split(/\s*(?:Triggers on|Use this skill when|Invoke when)\b/i)[0];
  // A description that OPENS with the trigger clause splits to an empty head.
  // Returning that would blank the row while --json still carried the text —
  // showing less than we have is worse than showing boilerplate.
  const trimmed = cutAtTrigger.trim() || description.trim();
  // First sentence, but only when the split leaves something substantial —
  // "e.g." and friends would otherwise chop a description to a fragment.
  const firstSentence = trimmed.match(/^.*?[.!?](?=\s+[A-Z(`])/)?.[0];
  const candidate = firstSentence && firstSentence.length >= 40 ? firstSentence : trimmed;
  return candidate.replace(/\s+/g, ' ').trim();
}

/** Compact size for a list row: `18 KB` for a bundle, `413 B` for a single file. */
function itemSizeLabel(p: string): string {
  if (!p) return '';
  const stat = safeStat(p);
  if (!stat) return '';
  if (!stat.isDirectory()) return formatBytes(stat.size);
  const { bytes } = pathSize(p);
  return formatBytes(bytes);
}

// ─── Detail mode (fuzzy) ─────────────────────────────────────────────────────

async function renderDetail(agent: AgentId, version: string, versionHome: string, kind: DrillableKind, query: string, options: InspectOptions): Promise<void> {
  const items = collectKind(agent, versionHome, kind);
  renderItemDetail(`${agent}@${version}`, { agent, version }, kind, query, items, options);
}

function renderItemDetail(header: string, jsonHead: Record<string, unknown>, kind: DrillableKind, query: string, items: ResourceItem[], options: InspectOptions): void {
  const matches = findMatches(items, query);

  if (matches.length === 0) {
    const suggestions = suggestClosest(items, query, 3);
    if (options.json) {
      console.log(JSON.stringify({ ...jsonHead, kind, query, match: null, suggestions: suggestions.map(s => s.name) }, null, 2));
    } else {
      console.error(chalk.red(`No ${kind} matching '${query}'.`));
      if (suggestions.length > 0) {
        console.error(chalk.gray(`Closest: ${suggestions.map(s => s.name).join(', ')}`));
      }
    }
    process.exit(1);
  }

  const best = matches[0];
  const others = matches.slice(1, 4);

  if (options.json) {
    const detail = buildDetail(best.item, kind);
    console.log(JSON.stringify({
      ...jsonHead,
      kind,
      query,
      match: { ...detail, matchKind: best.matchKind },
      others: others.map(o => ({ name: o.item.name, source: o.item.source, path: o.item.path, matchKind: o.matchKind })),
    }, null, 2));
    return;
  }

  console.log('\n' + chalk.bold(header) + '  ' + chalk.gray(`${kind} matching "${query}"`) + '\n');
  const matchTag = best.matchKind === 'exact' ? 'exact' : best.matchKind === 'substring' ? 'substring' : `~${best.distance}`;
  console.log(`  ${chalk.green('✓')}  ${termLink(chalk.bold.cyan(best.item.name), best.item.linkTarget)}  ${chalk.gray(`[${matchTag}, ${best.item.source}]`)}`);
  if (best.item.description) {
    // Wrap to the real terminal width. This used to be truncate(desc, 100): a
    // character count blind to the window, so a long description lost its
    // sentence at 80 columns AND wasted the space at 200.
    for (const line of wrapJoined('     ', best.item.description.split(/\s+/), ' ', terminalWidth())) {
      console.log(chalk.gray(line));
    }
  }
  for (const [k, v] of buildDetailRows(best.item, kind)) {
    // Wrap, never truncate. These values are `, `-joined lists (commands,
    // skills, triggers, tools) and cutting them hides real entries — a 9-command
    // plugin would show 4. Before the detail view wrapped at all, the terminal
    // soft-wrapped these in full, so truncating here would lose information the
    // old output had.
    // String(v) is belt-and-braces: pluginToItem now coerces every manifest field
    // through manifestText, so nothing non-string should reach here. Kept because
    // this is the choke point every future row kind flows through.
    printWrappedJoined(`     ${chalk.gray(k.padEnd(10))} `, String(v).split(', '), ', ');
  }

  if (others.length > 0) {
    console.log('\n' + chalk.gray('Other matches:'));
    for (const m of others) {
      const tag = m.matchKind === 'substring' ? 'substring' : `~${m.distance}`;
      console.log(`  ${termLink(chalk.cyan(m.item.name), m.item.linkTarget)}  ${chalk.gray(`(${tag}) [${m.item.source}]`)}`);
    }
  }
  console.log('');
}

// ─── Data collection ─────────────────────────────────────────────────────────

function collectCapabilities(agent: AgentId, version: string): Record<CapabilityName, { ok: boolean; reason?: string; need?: string }> {
  const out = {} as Record<CapabilityName, { ok: boolean; reason?: string; need?: string }>;
  for (const cap of CAPABILITY_NAMES) {
    const res = supports(agent, cap, version);
    if (res.ok) {
      out[cap] = { ok: true };
    } else {
      out[cap] = { ok: false, reason: res.reason, need: res.need };
    }
  }
  return out;
}

function collectItemsByKind(agent: AgentId, versionHome: string): Record<DrillableKind, ResourceItem[]> {
  const out = {} as Record<DrillableKind, ResourceItem[]>;
  for (const kind of DRILLABLE_KINDS) out[kind] = collectKind(agent, versionHome, kind);
  return out;
}

/** A simple-kind count row: `kind  N   user:30 system:12   name, name …(+K)`. */
function printSimpleResourceRow(kind: string, items: ResourceItem[]): void {
  const count = String(items.length).padStart(4);
  const breakdown = chalk.gray(scopeBreakdownPlain(countBySource(items.map(i => i.source))).padEnd(18));
  const preview = items.length > 0 ? chalk.gray(truncate(previewNames(items, 3), 48)) : '';
  console.log(`  ${kind.padEnd(10)} ${count}   ${breakdown}  ${preview}`.trimEnd());
}

/**
 * Build the `resources` JSON: every kind keeps `total` + `bySource` (back-compat),
 * simple kinds add `names`, and the rich kinds add structured `items` (hook
 * events/predicates, mcp transport/url/command, plugin version + group counts).
 */
function summaryResourcesJson(
  itemsByKind: Record<DrillableKind, ResourceItem[]>,
  hookByScript: Map<string, ManifestHook>,
  mcpConfigs: Map<string, McpYamlConfig>,
  hookInventory: ResourceInventory,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kind of DRILLABLE_KINDS) {
    const items = itemsByKind[kind];
    const base = { total: items.length, bySource: countBySource(items.map(i => i.source)) };
    if (kind === 'hooks') {
      out[kind] = { ...base,
        capable: hookInventory.capable,
        declared: hookInventory.declared,
        onDisk: hookInventory.onDisk,
        wired: hookInventory.wired,
        unmanaged: hookInventory.unmanaged,
        wiringSupported: hookInventory.wiringSupported,
        items: items.map(i => {
        const h = hookByScript.get(i.name);
        return { name: i.name, source: i.source, events: h?.events ?? [], matcher: h?.matcher, matches: h?.matches, cache: h?.cache };
      }) };
    } else if (kind === 'mcp') {
      out[kind] = { ...base, items: items.map(i => {
        const c = mcpConfigs.get(i.name);
        return { name: i.name, source: i.source, transport: c?.transport, url: c?.url, command: c?.command, args: c?.args };
      }) };
    } else if (kind === 'plugins') {
      out[kind] = { ...base, items: items.map(i => ({
        name: i.name,
        source: i.source,
        version: i.extra?.find(([k]) => k === 'version')?.[1],
        groups: Object.fromEntries((i.groups ?? []).map(g => [g.label, g.items.length])),
      })) };
    } else if (kind === 'routines') {
      out[kind] = { ...base, items: items.map(i => ({
        name: i.name,
        source: i.source,
        ...Object.fromEntries(i.extra ?? []),
      })) };
    } else {
      out[kind] = { ...base, names: items.map(i => i.name) };
    }
  }
  return out;
}

function formatHookInventoryCounts(inventory: ResourceInventory): string {
  const wired = inventory.wiringSupported ? String(inventory.wired.length) : 'unknown';
  const unmanaged = inventory.unmanaged.length > 0 ? ` · unmanaged ${inventory.unmanaged.length}` : '';
  return `capable ${inventory.capable ? 'yes' : 'no'} · on-disk ${inventory.onDisk.length} · wired ${wired}${unmanaged}`;
}

function collectKind(agent: AgentId, versionHome: string, kind: DrillableKind): ResourceItem[] {
  switch (kind) {
    case 'commands':
    case 'hooks':
    case 'workflows':
      return entriesFromAgentResources(agent, versionHome, kind);
    case 'skills':
      return skillsFromAgentResources(agent, versionHome);
    case 'mcp':
      return mcpItems(agent, versionHome);
    case 'rules':
    case 'subagents':
      return listResources(kind).map(r => ({
        name: r.name,
        source: r.source,
        path: r.path,
        linkTarget: linkTarget(r.path),
        description: readDescription(r.path),
      }));
    case 'plugins':
      return pluginItems();
    case 'routines':
      return agentRoutineItems(agent);
  }
}

/**
 * The routines that dispatch this agent.
 *
 * Version-invariant, like the `rules`/`subagents` cases above which also ignore
 * `versionHome`: a routine names an agent, never an agent@version. `listJobs()`
 * with no cwd is deliberate — it is the daemon's own view (user + system), so an
 * unsynced project routine that can never fire is not listed as if it could.
 */
function agentRoutineItems(agent: AgentId): ResourceItem[] {
  const { live } = defaultRoutineLive();
  const now = new Date();
  let jobs: JobConfig[];
  try { jobs = listJobs(); } catch { return []; }

  return jobs
    .filter(job => job.agent === agent)
    .map(job => {
      const state = live(job.name);
      return {
        name: job.name,
        source: 'user',
        path: '',
        linkTarget: '',
        description: routineDescription(job, ''),
        extra: [
          ['fires', routineFireLabel(job, now)],
          // listJobs already applied device activation, so job.enabled is the
          // effective answer here — no need to re-derive it.
          ['enabled', job.enabled ? 'yes' : 'no'],
          ['devices', state.devices.length > 0
            ? state.devices.join(', ')
            : state.materialized ? 'no device — will not fire' : 'no device allowlist yet'],
          ['last', state.lastStatus
            ? `${state.lastStatus}${state.lastAt ? ` · ${compactAge(state.lastAt, now)} ago` : ''}`
            : 'never run'],
        ] as Array<[string, string]>,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pluginItems(): ResourceItem[] {
  return discoverPlugins().map(p => pluginToItem(p, 'user'));
}

/**
 * Map a discovered plugin to a resource item, surfacing the manifest description
 * and the bundle's nested resources (skills, commands, hooks, ...) as detail rows.
 *
 * EVERY field read here comes from an uncontrolled `plugin.json`:
 * `loadPluginManifest` casts parsed JSON straight to `PluginManifest` and
 * validates only name/version (`lib/plugins.ts`), so the declared types are a
 * hope, not a guarantee. A non-string reaching a renderer throws on `.split` /
 * `.replace`, and `pluginToItem` runs while BUILDING THE LIST — so one malformed
 * manifest anywhere takes down `inspect .`, `--plugins`, `--json`, and even a
 * query for a different, valid plugin. Coerce every field through `manifestText`;
 * never trust the annotation.
 */
function pluginToItem(plugin: DiscoveredPlugin, source: string): ResourceItem {
  const extra: Array<[string, string]> = [];
  const version = manifestText(plugin.manifest.version);
  if (version) extra.push(['version', version]);
  // Which execution surfaces the bundle actually carries. Detection already
  // exists for the plugin picker; the detail view simply never asked for it.
  const surfaces = pluginCapabilityLabels(inspectPluginCapabilities(plugin.root));
  if (surfaces.length > 0) extra.push(['surfaces', surfaces.join(', ')]);
  const author = plugin.manifest.author;
  const authorLabel = manifestText(typeof author === 'object' && author !== null ? author.name : author);
  if (authorLabel) extra.push(['author', authorLabel]);
  // `.length` is truthy for a bare string too, and a string has no `.join`.
  const deps = plugin.manifest.dependencies;
  const depsLabel = Array.isArray(deps)
    ? deps.map(manifestText).filter(Boolean).join(', ')
    : manifestText(deps);
  if (depsLabel) extra.push(['depends on', depsLabel]);
  return {
    name: plugin.name,
    source,
    path: plugin.root,
    linkTarget: linkTarget(plugin.root),
    // `?? ''` catches only null/undefined — a numeric or array description used
    // to reach truncateToWidth/`.split` and kill the render for every plugin.
    description: manifestText(plugin.manifest.description),
    extra,
    groups: pluginResourceGroups(plugin),
  };
}

/**
 * Render one uncontrolled manifest value as display text. Objects and arrays
 * carry no sensible one-line form, so they become '' (the row is then dropped)
 * rather than `[object Object]`; everything else stringifies.
 */
function manifestText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v);
}

/**
 * Render one uncontrolled value as a list of display strings. A scalar becomes a
 * one-element list — the case `?? []` and `Array.isArray` both miss, and the one
 * that threw on `.join`. Object entries drop out rather than becoming
 * `[object Object]`.
 */
function manifestList(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map(manifestText).filter(Boolean);
  const single = manifestText(v);
  return single ? [single] : [];
}

function entriesFromAgentResources(agent: AgentId, versionHome: string, kind: 'commands' | 'hooks' | 'workflows'): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  const list = res[kind] as ResourceEntry[];
  return list.map(e => ({
    name: e.name,
    source: e.scope,
    path: e.path,
    linkTarget: linkTarget(e.path),
    // A hook is a shell/Python script with no human description, so the prose
    // fallback returned code: all 53 under an agent home read "!/usr/bin/env
    // bash" (the `#` strip eating the shebang), and skipping that line only
    // promoted `set -euo pipefail`. repoHookItems already hardcodes '' for the
    // repo path; this makes the agent path agree instead of guessing. The
    // Hooks view shows firing events in that column.
    description: kind === 'hooks' ? '' : readDescription(e.path),
  }));
}

function skillsFromAgentResources(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return (res.skills as SkillResourceEntry[]).map(s => ({
    name: s.name,
    source: s.scope,
    path: s.path,
    linkTarget: linkTarget(s.path),
    description: readDescription(s.path),
  }));
}

function mcpItems(agent: AgentId, versionHome: string): ResourceItem[] {
  const res = getAgentResources(agent, { home: versionHome });
  return res.mcp.map(m => ({
    name: m.name,
    source: m.scope,
    path: '',
    linkTarget: '',
    description: m.version ? `version ${m.version}` : '',
  }));
}

// ─── Detail field builders ───────────────────────────────────────────────────

function buildDetail(item: ResourceItem, kind: DrillableKind): Record<string, unknown> {
  const rows = buildDetailRows(item, kind);
  const out: Record<string, unknown> = {
    name: item.name,
    source: item.source,
    path: item.path,
    description: item.description,
  };
  for (const [k, v] of rows) out[k] = v;
  return out;
}

/**
 * The preview pane for one row, refreshed as the selection moves.
 *
 * Adaptive on purpose — the sessions picker sets the precedent: a Cursor
 * session shows Dirs/Repos/Artifacts, a Codex one shows a different set, and
 * empty fields simply do not render. A hook's useful metadata (what fires it,
 * whether it is wired) has nothing in common with a skill's (what invokes it,
 * where it is synced), so each kind contributes its own rows and blanks drop out.
 */
export function previewFor(kind: DrillableKind, item: ResourceItem, hookManifest: Map<string, ManifestHook>): string {
  const out: string[] = [];
  const label = (k: string, v: string) => `  ${chalk.gray(k.padEnd(11))}${v}`;

  out.push(chalk.bold.cyan(item.name) + '  ' + chalk.gray(`${kind.replace(/s$/, '')} · ${item.source}`));

  if (item.description) {
    out.push('');
    for (const line of wrapJoined('  ', item.description.split(/\s+/), ' ', terminalWidth())) {
      out.push(chalk.white(line));
    }
  }

  const rows: Array<[string, string]> = [];

  // A hook's identity is when it fires — the summary view has always shown this
  // while the drill-down showed only a size.
  if (kind === 'hooks') {
    // Use the manifest the caller already resolved. Re-resolving the CENTRAL
    // one here made the preview contradict its own row: a repo hook wired by
    // that repo's agents.yaml showed `PreToolUse(Bash)` in the table and
    // "not registered" in the pane below it, and the mirror case credited a
    // central registration to the repo. No `?? loadCentralHookManifest()`
    // fallback: it would be dead in production and would silently reinstate
    // exactly that bug the next time a caller forgot the argument.
    const hook = hookManifest.get(item.name);
    if (hook) {
      rows.push(['fires', chalk.yellow(summarizeHook(hook))]);
      rows.push(['wired', chalk.green('yes') + chalk.gray(' · agents.yaml')]);
    } else {
      rows.push(['wired', chalk.gray('no — on disk but not registered')]);
    }
  }

  if (kind === 'skills' || kind === 'commands' || kind === 'subagents') {
    const fm = readFrontmatter(item.path);
    if (fm) {
      const triggers = manifestList(fm.triggers).join(', ');
      if (triggers) rows.push(['triggers', triggers]);
      const model = manifestText(fm.model);
      if (model) rows.push(['model', model]);
      const tools = manifestList(fm.tools).join(', ');
      if (tools) rows.push(['tools', tools]);
    }
  }

  if (item.extra) rows.push(...item.extra);

  const size = itemSizeDetail(item.path);
  if (size) rows.push(['size', size]);
  if (item.path) rows.push(['path', chalk.blue(item.path)]);

  if (rows.length > 0) {
    out.push('');
    for (const [k, v] of rows) out.push(label(k, v));
  }

  // A plugin's bundled resources, each on its own line rather than a comma run.
  if (item.groups?.length) {
    for (const g of item.groups) {
      out.push('');
      out.push('  ' + chalk.bold(`${g.label} (${g.items.length})`));
      for (const entry of g.items.slice(0, 8)) out.push('    ' + chalk.green(entry));
      if (g.items.length > 8) out.push('    ' + chalk.gray(`…${g.items.length - 8} more`));
    }
  }

  return out.join('\n');
}

/** `18 KB · 3 files` for a bundle, `413 B` for a single file. */
function itemSizeDetail(p: string): string {
  if (!p) return '';
  const stat = safeStat(p);
  if (!stat) return '';
  if (!stat.isDirectory()) return formatBytes(stat.size);
  const { bytes, files } = pathSize(p);
  return `${formatBytes(bytes)} · ${files} ${files === 1 ? 'file' : 'files'}`;
}

function buildDetailRows(item: ResourceItem, kind: DrillableKind): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  if (item.path && kind !== 'mcp') {
    const stat = safeStat(item.path);
    // A bundle reports its real recursive weight. `(bundle)` carried no
    // information, and pathSize/formatBytes already back the summary view.
    if (stat) {
      if (stat.isDirectory()) {
        const { bytes, files } = pathSize(item.path);
        rows.push(['size', `${formatBytes(bytes)} · ${files} ${files === 1 ? 'file' : 'files'}`]);
      } else {
        rows.push(['size', formatBytes(stat.size)]);
      }
    }
  }
  // Kind-specific fields
  if (kind === 'skills' || kind === 'commands' || kind === 'subagents') {
    const fm = readFrontmatter(item.path);
    if (fm) {
      // description was already printed by caller; skip if redundant
      if (typeof fm.description === 'string' && fm.description.trim() !== item.description.trim()) {
        rows.push(['description', truncate(fm.description, 120)]);
      }
      // Frontmatter is uncontrolled YAML too. These were type-guarded against a
      // crash but still rendered `[object Object]` for an entry that is a map,
      // and dropped a scalar `triggers: foo` entirely.
      const triggers = manifestList(fm.triggers).join(', ');
      if (triggers) rows.push(['triggers', triggers]);
      const model = manifestText(fm.model);
      if (model) rows.push(['model', model]);
      const tools = manifestList(fm.tools).join(', ');
      if (tools) rows.push(['tools', tools]);
    }
  }
  // Plugin bundles surface their nested resources (skills, commands, …) plus
  // scalar rows (version).
  if (kind === 'plugins') {
    if (item.groups) for (const g of item.groups) rows.push([g.label, g.items.join(', ')]);
  }
  // Every kind's scalar rows. previewFor already renders `extra` unconditionally,
  // so gating it on plugins here made the detail view and its own preview pane
  // disagree about the same item — and dropped a routine's schedule/status from
  // `--routine <name> --json` entirely.
  if (item.extra) rows.push(...item.extra);
  return rows;
}

// ─── Rich expanded sections (summary view) ───────────────────────────────────

/** One row in an expanded section: a source tag, a clickable name, and a detail string. */
interface RichRow {
  source: string;
  name: string;
  detail: string;
  linkTarget?: string;
}

/** `system` → `sys`; everything else unchanged. Keeps the tag column narrow. */
function abbrevSource(s: string): string {
  return s === 'system' ? 'sys' : s;
}

/**
 * Compact one-liner for a hook from its manifest entry: the firing events (with
 * the matcher/tool-name in parens), then a `·`-separated predicate summary, then
 * an optional cache tail. Plain text — the caller applies color.
 */
export function summarizeHook(hook: ManifestHook): string {
  // `hook` is an unvalidated YAML cast from agents.yaml, so `??` is not enough:
  // a scalar `events: PreToolUse` is neither null nor an array, and `.join` threw
  // — taking down bare `agents inspect <repo>`, and via the central manifest
  // `agents inspect <agent>` on every box. Same shape as the plugin.json bug.
  const events = manifestList(hook.events).join('/') || '(no event)';
  let matcher = manifestText(hook.matcher);
  if (!matcher && hook.matches?.tool_name) {
    matcher = manifestList(hook.matches.tool_name).join('|');
  }
  const head = matcher ? `${events}(${matcher})` : events;

  const parts = [head];
  const preds = summarizeMatches(hook.matches);
  if (preds) parts.push(preds);
  let line = parts.join(' · ');

  const ttl = hookCacheTtl(hook.cache);
  if (ttl) line += ` (${ttl} cache)`;
  return line;
}

/** `·`-separated predicate summary from a hook's `matches:` block (tool_name omitted — shown in the matcher parens). */
function summarizeMatches(m?: HookMatches): string {
  if (!m) return '';
  // Every predicate is raw YAML. `truncate` calls `.slice`, so a numeric
  // `prompt_contains: 12345` threw here just like the events case above.
  const bits: string[] = [];
  if (m.git_dirty) bits.push('git_dirty');
  const promptContains = manifestText(m.prompt_contains);
  if (promptContains) bits.push(`prompt~"${truncate(promptContains, 24)}"`);
  const promptMatches = manifestText(m.prompt_matches);
  if (promptMatches) bits.push(`prompt=/${truncate(promptMatches, 24)}/`);
  const argsMatch = manifestText(m.tool_args_match);
  if (argsMatch) bits.push(`args=/${truncate(argsMatch, 20)}/`);
  const cwd = manifestList(m.cwd_includes).join('|');
  if (cwd) bits.push(`cwd~${truncate(cwd, 24)}`);
  const projectHas = manifestText(m.project_has);
  if (projectHas) bits.push(`has ${projectHas}`);
  return bits.join(' · ');
}

/** Normalize a hook cache shorthand/object to a display ttl ("5m", "1h"); null when uncached. */
function hookCacheTtl(cache?: HookCache): string | null {
  if (cache === undefined || cache === null) return null;
  if (typeof cache === 'string') return cache.replace(/-bg$/, '');
  // A bare `cache: 5` has no `.ttl`, and `cache: {ttl: {…}}` has a non-scalar
  // one — String() on either rendered `(undefined cache)` / `([object Object]
  // cache)`. No ttl to show means no cache tail.
  return manifestText((cache as { ttl?: unknown }).ttl) || null;
}

/** Compact one-liner for an MCP server: padded transport + the url (http) or command line (stdio). */
export function summarizeMcp(cfg: McpYamlConfig): string {
  const target = cfg.transport === 'http'
    ? (cfg.url ?? '')
    : [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' ');
  return `${cfg.transport.padEnd(5)}  ${truncate(target, 60)}`.trimEnd();
}

/** Print `Title (N)` then up to `max` aligned `[source] name  detail` rows with a `…(+K)` tail. */
function printExpandedSection(title: string, rows: RichRow[], max = 6): void {
  console.log('\n' + chalk.bold(title) + chalk.gray(` (${rows.length})`));
  if (rows.length === 0) {
    console.log(chalk.gray('  (none)'));
    return;
  }
  const shown = rows.slice(0, max);
  const nameW = Math.max(...shown.map(r => r.name.length));
  for (const r of shown) {
    const tag = chalk.gray(`[${abbrevSource(r.source)}]`.padEnd(8));
    const padded = r.name.padEnd(nameW);
    const name = r.linkTarget ? termLink(chalk.cyan(padded), r.linkTarget) : chalk.cyan(padded);
    const detail = r.detail ? '  ' + chalk.gray(r.detail) : '';
    console.log(`  ${tag} ${name}${detail}`);
  }
  if (rows.length > max) console.log(chalk.gray(`  …(+${rows.length - max})`));
}

/** Tally a source list into `{user: n, system: m}`. */
function countBySource(sources: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) out[s] = (out[s] || 0) + 1;
  return out;
}

/** Unbracketed scope breakdown for the simple count rows: `user:30 system:12`. */
function scopeBreakdownPlain(bySource: Record<string, number>): string {
  return Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(' ');
}

/**
 * Index a hook manifest by script basename (no extension). Installed hooks are
 * named after their script file (`04-capture-…`), while the manifest is keyed by
 * logical name (`capture-…`) with the filename in `script:` — so we join on the
 * script basename, not the manifest key.
 */
export function hookManifestByScript(manifest: Record<string, ManifestHook>): Map<string, ManifestHook> {
  const out = new Map<string, ManifestHook>();
  for (const hook of Object.values(manifest)) {
    if (hook && typeof hook.script === 'string') {
      out.set(path.basename(hook.script).replace(/\.[^.]+$/, ''), hook);
    }
  }
  return out;
}

/** Build hook rows by enriching the installed hook items with manifest events/predicates. */
function hookRows(items: ResourceItem[], byScript: Map<string, ManifestHook>): RichRow[] {
  // The section shows only the first handful before a `…(+N)` tail, so order
  // matters: wired hooks first. Alphabetically `00-…_test` sorts next to the
  // hook it tests, so half the visible rows were test scaffolding with a blank
  // event column while real registered hooks hid behind the tail.
  const ordered = [...items].sort((a, b) => {
    const aw = byScript.has(a.name) ? 0 : 1;
    const bw = byScript.has(b.name) ? 0 : 1;
    return aw !== bw ? aw - bw : a.name.localeCompare(b.name);
  });
  return ordered.map(item => {
    const hook = byScript.get(item.name);
    return {
      source: item.source,
      name: item.name,
      linkTarget: item.linkTarget,
      // Hooks are shell scripts with no human description — show events/predicates
      // from the manifest, or nothing rather than a meaningless shebang line.
      detail: hook ? summarizeHook(hook) : '',
    };
  });
}

/** Build plugin rows: `vVERSION  skills:6 commands:5 …` from the bundle's groups. */
function pluginRows(items: ResourceItem[]): RichRow[] {
  return items.map(item => {
    const version = item.extra?.find(([k]) => k === 'version')?.[1];
    const counts = (item.groups ?? []).map(g => `${g.label}:${g.items.length}`).join(' ');
    const detail = [version ? `v${version}` : '', counts].filter(Boolean).join('  ');
    return { source: item.source, name: item.name, detail, linkTarget: item.linkTarget };
  });
}

/** Statuses that mean the last run did not do its job. */
const UNHEALTHY_RUN = new Set(['failed', 'timeout', 'missed', 'blocked']);

/**
 * Health tier for the section ordering. Lower sorts first.
 *
 * `printExpandedSection` shows only the first handful before a `…(+N)` tail, so
 * for a repo with 24 routines the sort IS the section. Same reasoning as
 * `hookRows` putting wired hooks first: a routine that fires nowhere is exactly
 * what the reader opened this for, and must never hide behind the tail.
 */
export function routineHealthTier(item: ResourceItem): number {
  if (extraOf(item, 'problem')) return 0;
  const fires = extraOf(item, 'fires');
  if (fires.includes('expired')) return 5;
  const devices = extraOf(item, 'devices');
  if (devices.startsWith('no device —')) return 1;
  if (extraOf(item, 'enabled').startsWith('no')) return 2;
  const last = extraOf(item, 'last').split(' ')[0];
  if (UNHEALTHY_RUN.has(last)) return 3;
  return 4;
}

/** Build routine rows: `daily at 9:00 AM   zion   completed · 2h ago`. Broken first. */
function routineRows(items: ResourceItem[]): RichRow[] {
  const ordered = [...items].sort((a, b) => {
    const at = routineHealthTier(a), bt = routineHealthTier(b);
    return at !== bt ? at - bt : a.name.localeCompare(b.name);
  });
  const nameW = ordered.length > 0 ? Math.max(...ordered.slice(0, 6).map(r => r.name.length)) : 0;
  // Budget the three cells against what printExpandedSection leaves after the
  // `[source]` tag and the name column, so the status never truncates to `fai…`.
  const budget = Math.max(30, terminalWidth() - nameW - 14);
  const firesW = Math.min(21, Math.max(12, Math.floor(budget * 0.42)));
  const devicesW = Math.min(14, Math.max(7, Math.floor(budget * 0.22)));

  return ordered.map(item => {
    const problem = extraOf(item, 'problem');
    const fires = extraOf(item, 'fires');
    // A routine with no `fires` never parsed — the problem IS the whole row. One
    // that parsed but carries a problem (a duplicate-extension sibling) keeps its
    // schedule and status, with the problem appended rather than replacing them.
    if (problem && !fires) {
      return { source: item.source, name: item.name, linkTarget: item.linkTarget, detail: chalk.red(problem) };
    }
    const devices = compactDeviceCell(extraOf(item, 'devices'));
    const last = extraOf(item, 'last');
    // Pad the PLAIN strings, then colour. Padding a chalk-wrapped string counts
    // the escape codes as width and silently steals columns from the next cell.
    // The trailing problem gets what the three sized cells leave, or it would
    // blow the row past the terminal and break the alignment this budget exists
    // to hold — a 147-column row at COLUMNS=100 in testing.
    const problemW = Math.max(12, budget - firesW - devicesW - stringWidth(last) - 8);
    const detail = [
      chalk.gray(truncateToWidth(fires, firesW).padEnd(firesW)),
      (devices === 'none ⚠' ? chalk.yellow : chalk.gray)(truncateToWidth(devices, devicesW).padEnd(devicesW)),
      colorLast(last),
      problem ? chalk.red(truncateToWidth(`  ⚠ ${problem}`, problemW)) : '',
    ].join('  ').trimEnd();
    return {
      source: item.source,
      name: item.name,
      linkTarget: item.linkTarget,
      detail,
    };
  });
}

/**
 * Routine rows for an agent target: `daily at 9:00 AM   completed · 2h ago`.
 * No devices column — an agent view is inherently about this machine.
 */
function agentRoutineRows(items: ResourceItem[]): RichRow[] {
  const ordered = [...items].sort((a, b) => {
    const at = routineHealthTier(a), bt = routineHealthTier(b);
    return at !== bt ? at - bt : a.name.localeCompare(b.name);
  });
  return ordered.map(item => ({
    source: item.source,
    name: item.name,
    detail: `${extraOf(item, 'fires').padEnd(20)}  ${colorLast(extraOf(item, 'last'))}`,
  }));
}

/**
 * `ok 2h` / `fail 3d` / `never` — the Last column, clamped to the 10-wide cell.
 *
 * The picker path pads without truncating, so an 11-char `blocked 3d` would push
 * the next column; the abbreviations cover only the two commonest statuses, so
 * the clamp is what actually holds the invariant.
 */
function routineLastCell(item: ResourceItem, width = 10): string {
  const last = extraOf(item, 'last');
  if (!last || last === 'never run') return 'never';
  const [status, , age] = last.split(' ');
  const word = status === 'completed' ? 'ok' : status === 'failed' ? 'fail' : status;
  return truncateToWidth(age ? `${word} ${age}` : word, width);
}

/**
 * Trim the long-form `devices` phrasing down to a cell.
 *
 * The extra row is written for the detail pane ("no device — will not fire");
 * a 16-column cell needs the same fact in two words.
 */
function compactDeviceCell(devices: string): string {
  if (devices.startsWith('no device —')) return 'none ⚠';
  if (devices.startsWith('no device allowlist yet')) return 'unset';
  const list = devices.split(', ').filter(Boolean);
  return list.length > 1 ? `${list[0]} +${list.length - 1}` : (list[0] ?? '');
}

function colorLast(last: string): string {
  if (!last || last === 'never run') return chalk.gray('never run');
  const word = last.split(' ')[0];
  if (word === 'completed') return chalk.green(last);
  if (UNHEALTHY_RUN.has(word)) return chalk.red(last);
  return chalk.gray(last);
}

/**
 * The one-line warning under the Routines section, or null when it would mislead.
 *
 * Silent until some device has materialized a `routines:` list — before that,
 * every routine is legitimately unpinned and "will not fire" would be noise.
 */
export function routineDarkWarning(items: ResourceItem[]): string | null {
  const materialized = items.some(i => {
    const d = extraOf(i, 'devices');
    return d !== '' && !d.startsWith('no device allowlist yet');
  });
  if (!materialized) return null;
  const dark = items.filter(i => extraOf(i, 'devices').startsWith('no device —')).length;
  if (dark === 0) return null;
  // The noun pluralizes on the total ("1 of 2 routines"), the verb on the count
  // that is actually dark ("... is on no device's allowlist").
  const noun = items.length === 1 ? 'routine' : 'routines';
  const verb = dark === 1 ? 'is' : 'are';
  const pronoun = dark === 1 ? 'it' : 'they';
  return `${dark} of ${items.length} ${noun} ${verb} on no device's allowlist — ${pronoun} will not fire.`;
}

/** Build MCP rows by joining the installed mcp items with their full configs (transport/url/command). */
function mcpRows(items: ResourceItem[], configs: Map<string, McpYamlConfig>): RichRow[] {
  return items.map(item => {
    const cfg = configs.get(item.name);
    return { source: item.source, name: item.name, detail: cfg ? summarizeMcp(cfg) : item.description };
  });
}

/** Read a repo/agents.yaml `hooks:` section into a name→ManifestHook map (best-effort). */
export function hookManifestFromFile(agentsYamlPath: string): Record<string, ManifestHook> {
  try {
    const meta = yaml.parse(fs.readFileSync(agentsYamlPath, 'utf-8')) as { hooks?: Record<string, ManifestHook> } | null;
    return meta?.hooks ?? {};
  } catch { return {}; }
}

/**
 * Merge the system + user `agents.yaml` hook manifests (user wins on key
 * collision). Built directly from the two layer files rather than via
 * `parseHookManifest()` so inspecting never emits the shadow/override warnings
 * that the registrar path prints.
 */
function loadCentralHookManifest(): Record<string, ManifestHook> {
  return {
    ...hookManifestFromFile(path.join(getSystemAgentsDir(), 'agents.yaml')),
    ...hookManifestFromFile(path.join(getUserAgentsDir(), 'agents.yaml')),
  };
}

/**
 * Hook items for a repo's Hooks section. Uses the grouped hook reader (script +
 * data file collapsed into one entry, non-hook files like promptcuts.yaml or
 * README.md filtered out) rather than a naive readdir, so names are clean and
 * join cleanly against the manifest by script basename.
 *
 * `description` is intentionally blank: a hook is a script, and the only text a
 * readdir-based reader could scrape from one is its shebang (the old flat path
 * surfaced `!/usr/bin/env bash` as a description). The Hooks section shows firing
 * events via summarizeHook instead, which is the useful signal.
 */
function repoHookItems(repo: RepoTarget): ResourceItem[] {
  return listHookEntriesFromDir(path.join(repo.root, 'hooks')).map(h => ({
    name: h.name,
    source: repo.label,
    path: h.scriptPath,
    linkTarget: h.scriptPath,
    description: '',
  }));
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────────

interface ScoredMatch {
  item: ResourceItem;
  matchKind: 'exact' | 'substring' | 'fuzzy';
  distance: number;
}

function findMatches(items: ResourceItem[], query: string): ScoredMatch[] {
  const q = query.toLowerCase();
  const out: ScoredMatch[] = [];

  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === q) {
      out.push({ item, matchKind: 'exact', distance: 0 });
    } else if (name.includes(q)) {
      out.push({ item, matchKind: 'substring', distance: name.length - q.length });
    }
  }

  if (out.length > 0) {
    out.sort((a, b) => rankMatch(a) - rankMatch(b));
    return out;
  }

  // No substring hits — fall back to edit distance.
  const threshold = Math.max(2, Math.floor(q.length * 0.3));
  for (const item of items) {
    const d = damerauLevenshtein(q, item.name.toLowerCase());
    if (d <= threshold) out.push({ item, matchKind: 'fuzzy', distance: d });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out;
}

function rankMatch(m: ScoredMatch): number {
  if (m.matchKind === 'exact') return 0;
  if (m.matchKind === 'substring') return 100 + m.distance;
  return 1000 + m.distance;
}

function suggestClosest(items: ResourceItem[], query: string, n: number): ResourceItem[] {
  const q = query.toLowerCase();
  const scored = items.map(item => ({ item, d: damerauLevenshtein(q, item.name.toLowerCase()) }));
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, n).map(s => s.item);
}

// ─── Frontmatter + description helpers ───────────────────────────────────────

function readDescription(p: string): string {
  if (!p) return '';
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      // `rule.md` is the directory form of a subrule (SUBRULE_RULE_FILE in
      // lib/rules/compose.ts); without it the four dir-form subrules on disk
      // drill in with a blank preview.
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md', 'rule.md', 'README.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return ''; }

  const fm = readFrontmatter(filePath);
  if (fm && typeof fm.description === 'string' && fm.description.trim().length > 0) {
    return fm.description.trim();
  }
  return readFirstProseLine(filePath);
}

function readFrontmatter(p: string): Record<string, unknown> | null {
  if (!p) return null;
  let filePath = p;
  try {
    if (fs.statSync(p).isDirectory()) {
      for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
        const c = path.join(p, marker);
        if (fs.existsSync(c)) { filePath = c; break; }
      }
    }
  } catch { return null; }

  if (!filePath.endsWith('.md')) return null;
  let head = '';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf-8');
  } catch { return null; }

  if (!head.startsWith('---')) return null;
  const end = head.indexOf('\n---', 3);
  if (end === -1) return null;
  const body = head.slice(3, end).trim();
  try {
    const parsed = yaml.parse(body);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function readFirstProseLine(p: string): string {
  try {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) return '';
    if (stat.size > 64 * 1024) return '';
    const text = fs.readFileSync(p, 'utf-8');
    // Skip frontmatter
    let body = text;
    if (body.startsWith('---')) {
      const end = body.indexOf('\n---', 3);
      if (end !== -1) body = body.slice(end + 4);
    }
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#')) return line.replace(/^#+\s*/, '');
      return line;
    }
  } catch { /* ignore */ }
  return '';
}

// ─── OSC-8 + path helpers ────────────────────────────────────────────────────

function linkTarget(p: string): string {
  if (!p) return '';
  try {
    if (!fs.statSync(p).isDirectory()) return p;
  } catch { return p; }
  for (const marker of ['SKILL.md', 'WORKFLOW.md', 'AGENT.md']) {
    const c = path.join(p, marker);
    if (fs.existsSync(c)) return c;
  }
  return p;
}

function readSymlinkSafe(p: string): string | null {
  try {
    const stat = fs.lstatSync(p);
    if (!stat.isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch { return null; }
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function safeCountSessions(agent: AgentId): number {
  if (!isSessionTrackedAgent(agent)) return 0;
  try { return countSessionsInScope({ agent }); } catch { return 0; }
}
