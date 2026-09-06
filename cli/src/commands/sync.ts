/**
 * `agents sync` — synchronize central resources into an installed agent version.
 *
 * Forms:
 *   agents sync                                         # umbrella: fetch config repos -> reconcile all (secrets opt-in)
 *   agents sync status                                  # report fleet drift (former top-level `agents status`)
 *   agents sync --repos|--secrets                       # umbrella: fetch only those, then reconcile
 *   agents sync --cloud                                 # umbrella: fetch all, skip reconcile
 *   agents sync --local                                 # umbrella: reconcile all, no fetch
 *   agents sync system                                  # one repo: git pull --rebase (pull-only mirror)
 *   agents sync user                                    # one repo: git pull --rebase + push
 *   agents sync claude                                  # one agent: uses default/sole installed version
 *   agents sync claude@2.1.142                          # one agent: explicit version
 *   agents sync claude@latest                           # one agent: newest installed
 *   agents sync claude@oldest                           # one agent: oldest installed
 *   agents sync claude@pinned   (= claude@default)      # one agent: the pinned default version
 *   agents sync --agent claude --agent-version 2.1.142  # legacy form, still supported
 *
 * The umbrella stages live in lib/sync-umbrella.ts; this file dispatches to them
 * when no agent is given.
 *
 * In a TTY the command previews available/new resources and lets the user
 * select what to sync (same prompts shown after `agents add`). Pass
 * --yes for non-interactive auto-sync, --force to re-sync when nothing
 * has changed, --quiet for total silence.
 *
 * Hot path:
 *   --launch is the shim entry point. It skips version-home reconciliation
 *   and runs only the cheap project-scoped work (rules compile, workspace
 *   resource mirror, per-scope plugin marketplaces). Filesystem-only,
 *   sub-50ms steady state. Keep changes here surgical.
 */

import * as path from 'path';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { resolveSyncPassphraseFromEnv } from '../lib/sync-passphrase.js';
import { agentLabel, resolveAgentName, MANAGED_AGENT_IDS, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { autoEvictCentralBrowserProfiles } from '../lib/browser/registry.js';
import { shouldAutoClaimCentralProfile } from '../lib/browser/profiles.js';
import {
  isVersionInstalled,
  syncResourcesToVersion,
  parseAgentSpec,
  resolveVersion,
  resolveVersionAlias,
  listInstalledVersions,
  healDanglingVersionPointers,
  getAvailableResources,
  getActuallySyncedResources,
  getProjectOnlyResources,
  getNewResources,
  hasNewResources,
  promptResourceSelection,
  promptNewResourceSelection,
  buildSelection,
  buildRepoScopedSelection,
  mergeRepoScopedSelections,
  listRepoNames,
  getVersionHomePath,
  type ResourceSelection,
  type SyncResult,
  type HealedVersionPointers,
  type AvailableResources,
} from '../lib/installations/versions.js';
import { capableAgents } from '../lib/capabilities.js';
import { parseHookManifest, registerHooksToSettings } from '../lib/hooks/install.js';
import { repairAfterSync, renderRepairAfterSync, repairHadFailures, repairChangedAnything, repairAfterSyncJson } from '../lib/reconcile-and-repair.js';
import { compileRulesForProject } from '../lib/rules/compile.js';
import { runLaunchSync } from '../lib/project-launch.js';
import { formatKeptProjectResources } from '../lib/project-resources.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { runUmbrellaSync, type UmbrellaFlags } from '../lib/sync-umbrella.js';
import { verifyVersionConverged, formatResidualDrift, type ResidualDrift } from '../lib/sync-status.js';
import { addHostOption } from '../lib/hosts/option.js';
import { syncRepoGit, adoptUserRepoIfNeeded, recordUserRepoRemote, resolveUserRepoRemoteUrl } from '../lib/git.js';
import { getSystemAgentsDir, getUserAgentsDir, getEnabledExtraRepos } from '../lib/state.js';
import { registerStatusCommand } from './status.js';

interface SyncOpts {
  agent?: string;
  agentVersion?: string;
  /** Version selector from --version flag: @all, @latest, @oldest, @pinned, or x.y.z. */
  version?: string;
  repo?: string;
  projectDir?: string;
  cwd?: string;
  launch?: boolean;
  yes?: boolean;
  force?: boolean;
  quiet?: boolean;
  dryRun?: boolean;
  allowExecSurfaces?: boolean;
  /**
   * Machine-readable output. Also required by the fleet fan-out path
   * (`agents sync --device all`), which injects `--json` on every peer so the
   * roster can parse per-device results. Without this option registered,
   * remotes reject the flag with `unknown option '--json'` (RUSH-2216).
   */
  json?: boolean;
  // Umbrella-verb flags (only meaningful when no agent is given).
  repos?: boolean;
  secrets?: boolean;
  cloud?: boolean;
  local?: boolean;
  /** Umbrella-only, opt-in: run the DESTRUCTIVE stale-CLI purge (deletes other
   *  agents-cli installs when a fixed peer exists). Off by default — the purge
   *  never runs on a routine sync. */
  pruneClis?: boolean;
  // Per-kind selector flags (singular = primary, plural = hidden alias).
  // Value is string[] when names were given, true when the flag was bare,
  // undefined when the flag was not used at all.
  plugin?: string[] | true;
  plugins?: string[] | true;
  command?: string[] | true;
  commands?: string[] | true;
  skill?: string[] | true;
  skills?: string[] | true;
  hook?: string[] | true;
  hooks?: string[] | true;
  subagent?: string[] | true;
  subagents?: string[] | true;
  permission?: string[] | true;
  permissions?: string[] | true;
  mcp?: string[] | true;
  mcps?: string[] | true;
  workflow?: string[] | true;
  workflows?: string[] | true;
  rule?: string[] | true;
  rules?: string[] | true;
  memory?: boolean;
}

/** Emit one JSON object to stdout for `--json` callers / fleet fan-out. */
function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

/**
 * Post-reconcile verification (PHNX-3186): after a sync writes into a set of
 * version homes, re-read each home and confirm it now matches its resolved
 * sources. The `agents sync` success line MUST NOT read "reconciled" while the
 * drift it was asked to fix stays put. Any residual drifted/missing resource
 * sets a non-zero exit code and — outside `--json` — names the exact unfixed
 * drift so the operator sees what did not converge instead of a false ✓. Orphans
 * are excluded (sync never removes them). Returns the residual for `--json`.
 */
function verifyReconciled(
  pairs: Array<{ agent: AgentId; version: string }>,
  cwd: string,
): ResidualDrift[] {
  const residual: ResidualDrift[] = [];
  const seen = new Set<string>();
  for (const { agent, version } of pairs) {
    const key = `${agent}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = verifyVersionConverged(agent, version, cwd);
    if (r) residual.push(r);
  }
  // Residual drift is reported loudly via `ok:false` + the printed ⚠ block, but
  // does NOT change the exit code — matching the declined-write precedent
  // (RUSH-2700). The fleet fan-out (`agents sync --device all`) THROWS on a
  // non-zero peer exit (`hosts/passthrough.ts`), discarding that box's JSON, so a
  // non-zero exit here would hide the very `residualDrift` payload it emitted.
  // Callers that must treat an incomplete sync as failure read `ok`/`residualDrift`
  // from `--json`, exactly as they already do for declines.
  return residual;
}

/** Print the residual-drift block naming exactly what did not converge. */
function printResidual(residual: ResidualDrift[], errLog: (msg: string) => void): void {
  if (residual.length === 0) return;
  const lines = formatResidualDrift(residual);
  errLog(chalk.yellow(`⚠ sync did not fully reconcile — ${lines.length} resource(s) still drift after writing:`));
  for (const line of lines) errLog(chalk.yellow(`  ${line}`));
  errLog(chalk.gray('  Re-run the sync; a gap that survives a re-run is a real unreconcilable drift — report it.'));
}

/**
 * Translate per-kind CLI flags into a `ResourceSelection` for `buildSelection`.
 * Returns `undefined` when no kind flag was given (caller should use full sync).
 *
 * Each kind has a singular primary flag and a hidden plural alias; both carry
 * the same value. `true` = bare flag (all names for that kind), `string[]` =
 * explicit name filter, `undefined` = flag not used.
 *
 * --rule / --rules / --memory all map to the `memory` key (always `'all'` —
 * the composed file is recompiled from every layer, individual names ignored).
 */
function parseKindSelection(opts: SyncOpts): ResourceSelection | undefined {
  function resolve(singular: string[] | true | undefined, plural: string[] | true | undefined): string[] | 'all' | undefined {
    const val = singular ?? plural;
    if (val === undefined) return undefined;
    return val === true ? 'all' : val;
  }

  const plugins     = resolve(opts.plugin,      opts.plugins);
  const commands    = resolve(opts.command,     opts.commands);
  const skills      = resolve(opts.skill,       opts.skills);
  const hooks       = resolve(opts.hook,        opts.hooks);
  const subagents   = resolve(opts.subagent,    opts.subagents);
  const permissions = resolve(opts.permission,  opts.permissions);
  const mcp         = resolve(opts.mcp,         opts.mcps);
  const workflows   = resolve(opts.workflow,    opts.workflows);
  // --rule/--rules/--memory all enable a full memory recompile (no name filter).
  const memory: 'all' | undefined = (opts.rule || opts.rules || opts.memory) ? 'all' : undefined;

  const anySet = [plugins, commands, skills, hooks, subagents, permissions, mcp, workflows, memory]
    .some(v => v !== undefined);
  if (!anySet) return undefined;

  const sel: ResourceSelection = {};
  if (plugins)     sel.plugins     = plugins;
  if (commands)    sel.commands    = commands;
  if (skills)      sel.skills      = skills;
  if (hooks)       sel.hooks       = hooks;
  if (subagents)   sel.subagents   = subagents;
  if (permissions) sel.permissions = permissions;
  if (mcp)         sel.mcp         = mcp;
  if (workflows)   sel.workflows   = workflows;
  if (memory)      sel.memory      = memory;
  return sel;
}

/**
 * Attach the resource-selector flag family to the sync command.
 * Exported for testing flag registration in sync.test.ts.
 */
export function addSelectorOptions(cmd: Command): Command {
  const kindCollector = (val: string, prev: string[] | undefined): string[] => {
    const names = val.split(',').map((s) => s.trim()).filter(Boolean);
    const base = Array.isArray(prev) ? prev : [];
    return [...base, ...names];
  };

  function addKindPair(singular: string, plural: string, desc: string): void {
    cmd.addOption(new Option(`--${singular} [names]`, desc).argParser(kindCollector));
    cmd.addOption(new Option(`--${plural} [names]`, `Alias of --${singular}`).argParser(kindCollector).hideHelp());
  }

  addKindPair('plugin', 'plugins', 'Sync only plugins (bare = all; comma-separated names to filter)');
  addKindPair('command', 'commands', 'Sync only commands (bare = all; comma-separated names to filter)');
  addKindPair('skill', 'skills', 'Sync only skills (bare = all; comma-separated names to filter)');
  addKindPair('hook', 'hooks', 'Sync only hooks (bare = all; comma-separated names to filter)');
  addKindPair('subagent', 'subagents', 'Sync only subagents (bare = all; comma-separated names to filter)');
  addKindPair('permission', 'permissions', 'Sync only permissions (bare = all; comma-separated names to filter)');
  addKindPair('mcp', 'mcps', 'Sync only MCP servers (bare = all; comma-separated names to filter)');
  addKindPair('workflow', 'workflows', 'Sync only workflows (bare = all; comma-separated names to filter)');
  cmd.addOption(
    new Option(
      '--rule [names]',
      'Sync only the rules/memory file (maps to the "memory" key — the whole file is always recompiled, individual names are not filtered)',
    ).argParser(kindCollector),
  );
  cmd.addOption(new Option('--rules [names]', 'Alias of --rule').argParser(kindCollector).hideHelp());
  cmd.addOption(new Option('--memory', 'Sync only the rules/memory file (alias of --rule with no name filter)'));
  cmd.addOption(
    new Option(
      '--version <spec>',
      'Agent version or selector: @latest, @oldest, @pinned (= @default), @all, or a concrete x.y.z. "all" targets every installed version non-interactively.',
    ),
  );
  return cmd;
}

/** Register the `agents sync` command. */
export function registerSyncCommand(program: Command): void {
  const cmd = addHostOption(program.command('sync [agentSpec] [repo]'))
    .summary('Make this machine current, or sync resources into one agent')
    .description('With an [agentSpec], syncs resources (commands, skills, hooks, rules, MCPs, plugins, etc.) into that installed agent version — previews changes and lets you pick. e.g. "claude", "claude@2.1.142", a selector: @latest / @oldest / @pinned (= @default), or @all for every installed version.\n\nAppend a [repo] (or pass --repo) to scope the sync to a single DotAgent repo — system / user / project / <alias>. e.g. "agents sync claude@all system" reconciles only the system repo\'s resources into every installed Claude.\n\nGive a DotAgent repo name ALONE — "agents sync system" / "agents sync user" / "agents sync <alias>" — to git-sync that one repo: git pull --rebase against origin when the tree is clean; when it is dirty, fast-forward anyway if no incoming path is uncommitted, else refuse and name what collided. The user repo and extra aliases also push local commits up; the system repo is a pull-only mirror.\n\nWith NO agent, runs the umbrella verb: fetch the config repos then reconcile them into every installed agent. Secrets are opt-in — add --secrets to pull secret bundles. Session transcripts are queryable live via "agents sessions --device <machine>", or moved with "agents sessions export/import". Also: --cloud (fetch only), --local (reconcile only).\n\n`agents sync status` reports fleet drift (what is drifted, missing, or behind) and can reconcile it — the former top-level `agents status`.')
    .option('--agent <agent>', 'Agent identifier (legacy form; prefer the positional spec)')
    .option('--agent-version <version>', 'Version to sync into (legacy form; prefer "agent@version" or --version)')
    .option('--repo <name>', 'Scope the sync to a single DotAgent repo: system / user / project / <alias> (also accepted as a positional)')
    .option('--project-dir <path>', 'Path to project-level .agents/ directory containing project-scoped resources')
    .option('--cwd <path>', 'Working directory for discovering project manifest and resources')
    .option('--launch', 'Hot-path mode (shim only): skip version-home reconciliation, run project-scoped compile + workspace mirror + plugin marketplaces', false)
    .option('-y, --yes', 'Skip the interactive preview and auto-sync all detected resources', false)
    .option('--force', 'Re-sync even if no changes are detected since the last sync', false)
    .option('--quiet', 'Suppress all output (exit code indicates success)', false)
    .option('--dry-run', 'Show what would be synced without making any changes — requires an agent scope (e.g. agents sync claude --dry-run); the umbrella verb refuses it', false)
    .option('--allow-exec-surfaces', 'Allow syncing plugin exec surfaces (scripts, binaries) — off by default for safety', false)
    .option('--json', 'Emit machine-readable JSON (also accepted so fleet fan-out via --device all can parse each peer)', false)
    // Umbrella verb (no agent given): make this machine current.
    .option('--repos', 'Umbrella: git-pull ~/.agents + enabled ~/.agents-* extras', false)
    .option('--secrets', 'Umbrella: pull encrypted secret bundles from the remote', false)
    .option('--cloud', 'Umbrella: fetch all remote state but skip the local reconcile', false)
    .option('--local', "Umbrella: reconcile resources into installed agents only (no fetch)", false)
    .option('--prune-clis', 'Umbrella: also purge stale/legacy agents-cli installs (npx-cache, pre-1.22.30, unsafe helper) when a fixed peer exists. DESTRUCTIVE and off by default — the purge never runs on a routine sync.', false)
    .action(async (agentSpec: string | undefined, repo: string | undefined, opts: SyncOpts) => {
      await runSync(agentSpec, repo, opts);
    });

  // Per-kind resource selectors + --version. Registered after the main flags so
  // help output groups the positional/repo/agent flags first.
  addSelectorOptions(cmd);
  // `status` is a reserved subcommand (not an agentSpec/repo positional).
  registerStatusCommand(cmd);
}

/**
 * Resolve a DotAgent repo name to its git working directory + whether local
 * commits should be pushed. `system` is a pull-only mirror of the npm-shipped
 * upstream; `user` and enabled extra aliases are user-owned and push. `project`
 * (and unknown names) return null — the project `.agents/` lives inside the
 * user's own project repo and is not independently git-synced here.
 */
function resolveRepoGitTarget(repo: string): { dir: string; push: boolean } | null {
  if (repo === 'system') return { dir: getSystemAgentsDir(), push: false };
  if (repo === 'user') return { dir: getUserAgentsDir(), push: true };
  const extra = getEnabledExtraRepos().find((e) => e.alias === repo);
  if (extra) return { dir: extra.dir, push: true };
  return null;
}

/**
 * `agents sync <repo>` — git-sync a single DotAgent repo: pull --rebase against
 * origin on a clean tree; on a dirty one, fast-forward anyway when no incoming
 * path is uncommitted, else refuse naming the collision. Pushes local commits
 * for user-owned repos. Delegates the git work to `syncRepoGit`.
 */
async function runRepoGitSync(
  repo: string,
  quiet: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
  json = false,
): Promise<void> {
  const target = resolveRepoGitTarget(repo);
  if (!target) {
    if (json) {
      emitJson({
        ok: false,
        mode: 'repo-git',
        repo,
        error: `The '${repo}' repo isn't independently git-synced.`,
      });
    } else {
      errLog(chalk.red(`The '${repo}' repo isn't independently git-synced.`));
      errLog(chalk.gray('Syncable repos: system (pull-only), user, and enabled extra-repo aliases.'));
    }
    process.exitCode = 1;
    return;
  }

  if (!quiet && !json) outLog(chalk.bold(`Syncing ${repo} repo…`) + chalk.gray(` (${target.dir})`));

  // Self-heal a non-git / partial user checkout in place before the git sync
  // (PHNX-3301) — otherwise syncRepoGit hard-fails with "Not a git repo" and the
  // only fix is a destructive re-clone. Only the user repo adopts: system is
  // cloned by setup, extras by `repo add`.
  if (repo === 'user') {
    const adopted = await adoptUserRepoIfNeeded(target.dir);
    if (adopted && !adopted.success) {
      const hint = adopted.needsUrl
        ? ' — git-back it: agents repo pull user <git-url>'
        : '';
      if (json) {
        emitJson({ ok: false, mode: 'repo-git', repo, error: `${adopted.error}${hint}` });
      } else {
        errLog(chalk.red(`sync ${repo} failed: ${adopted.error}`));
        if (adopted.needsUrl) errLog(chalk.gray('  git-back it: agents repo pull user <git-url>'));
      }
      process.exitCode = 1;
      return;
    }
    if (adopted?.success && !quiet && !json) {
      outLog(chalk.green(`  adopted ${repo} in place → ${adopted.commit} (${adopted.materialized} file(s) materialized${adopted.reconciledAgentsYaml ? ', agents.yaml reconciled' : ''})`));
      if (adopted.localEdits.length > 0) {
        outLog(chalk.yellow(`  kept ${adopted.localEdits.length} local edit(s): ${adopted.localEdits.slice(0, 5).join(', ')}${adopted.localEdits.length > 5 ? ', …' : ''}`));
      }
      if (adopted.agentsYamlBackup) {
        outLog(chalk.gray(`  saved the previous agents.yaml to ${adopted.agentsYamlBackup}`));
      }
    }
  }

  const result = await syncRepoGit(target.dir, { push: target.push });

  if (!result.success) {
    if (json) {
      emitJson({ ok: false, mode: 'repo-git', repo, error: result.error ?? 'sync failed' });
    } else {
      errLog(chalk.red(`sync ${repo} failed: ${result.error}`));
    }
    process.exitCode = 1;
    return;
  }

  // Record the resolved remote so a future partial box (lost .git) can adopt in
  // place without the operator re-typing the URL (PHNX-3301). Before the --json
  // early-return so the record is refreshed on every healthy sync, JSON or not.
  if (repo === 'user') {
    const u = resolveUserRepoRemoteUrl(target.dir);
    if (u) recordUserRepoRemote(target.dir, u);
  }

  if (json) {
    emitJson({
      ok: true,
      mode: 'repo-git',
      repo,
      commit: result.commit,
      pushed: !!result.pushed,
    });
    return;
  }

  if (!quiet) {
    const note = result.pushed ? ' · pushed' : ' · pull-only';
    outLog(chalk.green(`✓ ${repo} → ${result.commit}${note}`));
  }
}

/** Human label for a repo choice in the interactive picker. */
function repoChoiceLabel(repo: string): string {
  switch (repo) {
    case 'system': return 'system  — shared, npm-shipped defaults';
    case 'user': return 'user    — your ~/.agents config';
    case 'project': return "project — this repo's .agents";
    default: return `${repo}  — extra repo`;
  }
}

/**
 * Interactive bare `agents sync` (TTY, no flags): two checklists — which
 * DotAgent repos to sync FROM, and which installed agents to sync INTO. Then
 * freshen the selected git-syncable repos (pull-only) and reconcile the chosen
 * repos' resources into each selected agent's default version, registering
 * hooks so synced hook scripts actually fire.
 */
async function runInteractiveReconcile(
  opts: SyncOpts,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
): Promise<void> {
  const { checkbox } = await import('@inquirer/prompts');
  const cwd = opts.cwd || process.cwd();

  const installedAgents = MANAGED_AGENT_IDS.filter((a) => listInstalledVersions(a).length > 0);
  if (installedAgents.length === 0) {
    errLog(chalk.red('No agents installed. Install one: agents add claude@latest'));
    process.exitCode = 1;
    return;
  }

  let repos: string[];
  let agents: AgentId[];
  try {
    repos = await checkbox<string>({
      message: 'Sync resources FROM which repos?',
      choices: listRepoNames().map((r) => ({ value: r, name: repoChoiceLabel(r), checked: true })),
    });
    if (repos.length === 0) {
      outLog(chalk.gray('No repos selected. Nothing to do.'));
      return;
    }
    agents = await checkbox<AgentId>({
      message: 'Sync INTO which agents?',
      choices: installedAgents.map((a) => ({ value: a, name: agentLabel(a), checked: true })),
    });
    if (agents.length === 0) {
      outLog(chalk.gray('No agents selected. Nothing to do.'));
      return;
    }
  } catch (e) {
    if (isPromptCancelled(e)) {
      outLog(chalk.gray('Cancelled. No changes made.'));
      return;
    }
    throw e;
  }

  // 1. Freshen the selected git-syncable repos (pull-only; `project` has no
  //    independent remote). Failures are non-fatal — reconcile still runs.
  for (const repo of repos) {
    const target = resolveRepoGitTarget(repo);
    if (!target) continue;
    // Adopt a non-git / partial user checkout in place before pulling (PHNX-3301).
    if (repo === 'user') {
      const adopted = await adoptUserRepoIfNeeded(target.dir);
      if (adopted?.success) {
        outLog(chalk.gray(`  adopted user in place → ${adopted.commit} (${adopted.materialized} file(s) materialized)`));
      } else if (adopted && !adopted.success) {
        outLog(chalk.yellow(`  ! user: ${adopted.error}${adopted.needsUrl ? ' — agents repo pull user <git-url>' : ''}`));
        continue;
      }
    }
    const res = await syncRepoGit(target.dir, { push: false });
    if (res.success) {
      outLog(chalk.gray(`  pulled ${repo} → ${res.commit}`));
      if (repo === 'user') {
        const u = resolveUserRepoRemoteUrl(target.dir);
        if (u) recordUserRepoRemote(target.dir, u);
      }
    } else outLog(chalk.yellow(`  ! ${repo}: ${(res.error ?? 'pull failed').split('\n')[0]}`));
  }

  // Drain the legacy central `browser:` tombstone now that the repos are pulled.
  // Running AFTER the pull is load-bearing: it acts on a view of central that
  // already reflects peers' drains, so it never re-claims a profile another box
  // already migrated (which would flip that profile's kind identity->fungible).
  // The interactive path is always non-quiet, non-json.
  evictCentralBrowserProfilesForSync(false, false, outLog, errLog);

  // 2. One selection spanning the chosen repos.
  const selection = mergeRepoScopedSelections(repos, cwd);
  const hasResources = selection.memory === 'all' || Object.entries(selection).some(
    ([kind, v]) => kind !== 'memory' && Array.isArray(v) && v.length > 0,
  );
  if (!hasResources) {
    outLog(chalk.gray(`Nothing from ${repos.join(', ')} to sync.`));
    return;
  }

  // 3. Reconcile into each selected agent's default (or sole) version, then
  //    register hooks so synced hook scripts fire.
  const hookManifest = parseHookManifest();
  const hookCapable = new Set(capableAgents('hooks'));
  const touched: Array<{ agent: AgentId; version: string }> = [];
  for (const agentId of agents) {
    const version = resolveVersion(agentId, cwd) || listInstalledVersions(agentId).slice(-1)[0];
    if (!version) continue;
    const result = syncResourcesToVersion(agentId, version, selection, { cwd, prune: true });
    printSyncDetail(result, agentId, version, cwd);
    if (result.hooks && hookCapable.has(agentId) && Object.keys(hookManifest).length > 0) {
      registerHooksToSettings(agentId, getVersionHomePath(agentId, version), hookManifest);
    }
    touched.push({ agent: agentId, version });
  }

  // Post-reconcile repair (the superset of the old `doctor --fix`): heal live-home
  // gaps, re-wire hooks the diff left behind, and repair managed hook runtime
  // shims for exactly the versions this reconcile touched. Always interactive
  // here, so render its detail freely.
  for (const t of touched) {
    const repair = await repairAfterSync({ agent: t.agent, versions: [t.version], cwd });
    renderRepairAfterSync(repair, outLog);
  }

  // Bare `agents sync` at a TTY is the umbrella verb — after per-agent repair,
  // run one no-agent pass. This purges stale/legacy agents-cli copies ONLY when
  // the user passed `--prune-clis` (the purge is never automatic); otherwise it is
  // a cheap re-diff no-op over the just-reconciled homes.
  const umbrellaRepair = await repairAfterSync({ cwd, pruneClis: !!opts.pruneClis });
  renderRepairAfterSync(umbrellaRepair, outLog);
  if (repairHadFailures(umbrellaRepair)) process.exitCode = 1;
}

/**
 * Drain the legacy central `browser:` tombstone during `agents sync` (PHNX-3315).
 * New profiles write the per-device doc, but profiles created before the
 * device-scoped store lingered in the shared top-level `agents.yaml` and churned
 * every fleet pull until someone ran `agents browser profiles claim` by hand.
 * Fold the ones THIS box can host into its device doc — host-gated, and the
 * selection is computed under the meta lock (see autoEvictCentralBrowserProfiles)
 * so it never races itself. Callers MUST invoke this AFTER the repo pull: acting
 * on a pre-pull view of central risks re-claiming a profile a peer already
 * drained, which would flip its kind identity->fungible. Non-fatal so a hiccup
 * can never wedge the sync.
 */
function evictCentralBrowserProfilesForSync(
  quiet: boolean,
  json: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
): void {
  try {
    // Auto-claim ONLY remote (ssh://) tombstones — they are fungible by design,
    // so a concurrent cross-machine double-claim is harmless. Local/cdp profiles
    // have no per-machine ownership signal and are left central for an explicit
    // `agents browser profiles claim` (PHNX-3315 review). See
    // shouldAutoClaimCentralProfile.
    const result = autoEvictCentralBrowserProfiles(shouldAutoClaimCentralProfile);
    if (!quiet && !json && result.claimed.length > 0) {
      outLog(
        chalk.gray(
          `  Claimed ${result.claimed.length} central browser profile(s) into this device: ${result.claimed.join(', ')}`,
        ),
      );
    }
  } catch (err) {
    if (!quiet && !json) {
      errLog(chalk.yellow(`  ! browser profile eviction skipped: ${(err as Error).message}`));
    }
  }
}

/**
 * The umbrella verb: bare `agents sync` (no agent) makes this machine current.
 * Resolves the flags + a secrets passphrase (env-only for now; tokenized auth
 * arrives with `agents secrets vault unlock`) and runs the fetch+reconcile stages, then prints
 * a one-line summary. Stage failures are non-fatal and surfaced as warnings.
 */
async function runUmbrella(
  opts: SyncOpts,
  quiet: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
  json = false,
): Promise<void> {
  // `--dry-run` on the umbrella verb is NOT supported and must fail LOUD before
  // touching anything (PHNX-3923). The umbrella composes stages that only exist
  // as mutating operations — repo `git pull`, a full `refresh()` reconcile into
  // every installed version home, central browser-profile eviction, device sync,
  // and `repairAfterSync` — none of which carry a non-mutating preview mode. The
  // old code ignored `opts.dryRun` entirely, ran `runUmbrellaSync` + evict +
  // repair, and so MUTATED every native home despite `--dry-run`. Rather than
  // ship a partial preview that silently skips the stages it cannot model (a
  // lying "would sync" that contradicts the flag's promise), refuse here and
  // point at the scoped path, which DOES honor `--dry-run` non-destructively.
  if (opts.dryRun) {
    const installed = MANAGED_AGENT_IDS.filter((id) => listInstalledVersions(id).length > 0);
    const example = installed[0] ?? 'claude';
    const error =
      '`agents sync --dry-run` has no umbrella preview: the machine-wide sync pulls repos, ' +
      'reconciles every installed version, syncs devices, and repairs homes — stages that ' +
      'cannot be previewed without making changes.';
    const hint = `Preview one agent instead (this is non-destructive): agents sync ${example} --dry-run [--repo <repo>]`;
    if (json) {
      emitJson({ ok: false, mode: 'umbrella', dryRun: true, error, hint, installedAgents: installed });
    } else {
      errLog(chalk.red(error));
      errLog(chalk.gray(hint));
      if (installed.length > 0) errLog(chalk.gray(`Installed agents: ${installed.join(', ')}`));
    }
    process.exitCode = 1;
    return;
  }

  // Interactive bare `agents sync` (a TTY, no --yes, no scope flag) drops into
  // the two-checklist picker: which repos to sync from, which agents to sync
  // into. Any explicit flag, --yes, or --json keeps the non-interactive path.
  // --json is a machine consumer (and the fleet fan-out injects it), so never
  // open a picker under it.
  const anyExplicitFlag = !!(opts.repos || opts.secrets || opts.cloud || opts.local);
  if (!quiet && !json && !opts.yes && !anyExplicitFlag && isInteractiveTerminal()) {
    await runInteractiveReconcile(opts, outLog, errLog);
    return;
  }

  const cwd = opts.cwd || process.cwd();
  const flags: UmbrellaFlags = {
    repos: opts.repos,
    secrets: opts.secrets,
    cloud: opts.cloud,
    local: opts.local,
  };
  // Same chokepoint as `agents secrets push/pull` — prefers AGENTS_SYNC_PASSPHRASE,
  // falls back to the deprecated master-key name with a single warning.
  const passphrase = resolveSyncPassphraseFromEnv().value ?? undefined;

  // Fleet fan-out only injects --json (not --yes). Treat --json as non-interactive
  // so refresh({ skipPrompts }) never tries to prompt over SSH.
  const yes = !!opts.yes || json;

  if (!quiet && !json) outLog(chalk.bold('Syncing this machine…'));
  try {
    const result = await runUmbrellaSync({
      flags,
      yes,
      passphrase,
      // quiet under --json so refresh() cannot pollute the JSON stdout the fleet parses.
      quiet: quiet || json,
      log: (msg) => { if (!quiet && !json) outLog(chalk.gray(`  ${msg}`)); },
    });

    // Drain the legacy central `browser:` tombstone AFTER the umbrella pull, so
    // we act on central as converged by this sync rather than a stale pre-pull
    // copy that could re-claim a profile a peer already migrated. Skipped under
    // --cloud (fetch-only, no local reconcile).
    if (!opts.cloud) evictCentralBrowserProfilesForSync(quiet, json, outLog, errLog);

    // Post-reconcile verification (PHNX-3186): re-read every version the reconcile
    // wrote into and confirm it now matches source. Without this the umbrella
    // printed `✓ sync: reconciled` unconditionally, the exact false-success the
    // ticket reports. Residual drift downgrades the line and sets a non-zero exit.
    const residual = result.reconciled
      ? verifyReconciled(
          result.reconciledVersions.map((r) => ({ agent: r.agent as AgentId, version: r.version })),
          cwd,
        )
      : [];

    // Post-reconcile repair, machine-wide: no agent scope → heal every installed
    // agent, re-wire hooks the diff left behind, and repair managed hook runtime
    // shims. The stale-CLI purge runs ONLY with `--prune-clis` (never automatic).
    // Skipped under --cloud (fetch-only: nothing was reconciled to repair).
    const repair = opts.cloud ? null : await repairAfterSync({ cwd, pruneClis: !!opts.pruneClis });
    // A repair that left something for a human (an unresolvable shim, a failed
    // rewire/purge) is a non-zero outcome, same as the deleted `doctor --fix`.
    const repairFailed = repair !== null && repairHadFailures(repair);
    if (repairFailed) process.exitCode = 1;

    if (json) {
      emitJson({
        // A refused resource, residual drift, OR a repair failure is not a clean
        // sync (RUSH-2700 + PHNX-3186).
        ok: result.declined.length === 0 && residual.length === 0 && !repairFailed,
        mode: 'umbrella',
        plan: result.plan,
        repos: result.repos,
        secrets: result.secrets,
        devices: result.devices,
        reconciled: result.reconciled,
        declined: result.declined,
        residualDrift: residual,
        repair: repair ? repairAfterSyncJson(repair) : null,
      });
      return;
    }

    if (!quiet) {
      const parts: string[] = [];
      if (result.repos) {
        parts.push(`repos ${result.repos.pulled} pulled` +
          (result.repos.errors.length ? `, ${result.repos.errors.length} failed` : ''));
      }
      if (result.secrets) {
        parts.push(result.secrets.skipped ? 'secrets skipped' : `secrets ${result.secrets.pulled} pulled`);
      }
      // Only claim "reconciled" when the reconcile actually converged. Residual
      // drift is already printed loudly by verifyReconciled above; reflect it in
      // the one-line summary rather than a bare ✓.
      if (result.reconciled) parts.push(residual.length === 0 ? 'reconciled' : 'reconcile INCOMPLETE');
      const symbol = residual.length === 0 ? chalk.green('✓') : chalk.yellow('⚠');
      const line = `${symbol} sync: ${parts.join(' · ') || 'nothing to do'}`;
      outLog(residual.length === 0 ? chalk.green(line) : chalk.yellow(line));

      const errs = [...(result.repos?.errors ?? []), ...(result.secrets?.errors ?? [])];
      for (const e of errs) errLog(chalk.yellow(`  ! ${e}`));
      printResidual(residual, errLog);
      if (repair) renderRepairAfterSync(repair, outLog);
    }
  } catch (err) {
    if (json) {
      emitJson({ ok: false, mode: 'umbrella', error: (err as Error).message });
    } else {
      errLog(chalk.red(`sync failed: ${(err as Error).message}`));
    }
    process.exitCode = 1;
  }
}

async function runSync(agentSpec: string | undefined, repoArg: string | undefined, opts: SyncOpts): Promise<void> {
  const json = !!opts.json;
  // --json is a machine consumer: suppress human stdout/stderr chatter so the
  // single JSON object on stdout stays parseable for fleet fan-out.
  const quiet = !!opts.quiet || json;
  const errLog = (msg: string) => { if (!quiet) console.error(msg); };
  const outLog = (msg: string) => { if (!quiet) console.log(msg); };
  // Failures under --json still need a structured line on stdout so fleet
  // fan-out's safeJsonParse gets a real object (not "unknown option").
  const failJson = (payload: Record<string, unknown>) => {
    if (json) emitJson({ ok: false, ...payload });
  };

  // ---------- 1. Resolve agent + version ----------
  let agentId: AgentId | undefined;
  let version: string | undefined;

  // A positional @selector typed by the user (latest/oldest/pinned/default/
  // all/explicit). parseAgentSpec defaults a missing version to 'latest', so a
  // bare `agents sync claude` and `agents sync claude@latest` are
  // indistinguishable after parsing — we only treat the version as a selector
  // when an '@' was actually typed, keeping bare `claude` on the
  // default-version path.
  let selector: string | undefined;

  // Repo-level git sync: a DotAgent repo name given ALONE (no agent, no second
  // positional) means "git-sync that repo" — pull --rebase, and push for
  // user-owned repos. This is distinct from the [repo] resource-scoping arg
  // below, and it precedes agent-spec parsing because repo names like
  // "system"/"user" would otherwise fail parseAgentSpec.
  //
  // DEPRECATED: prefer `agents repo sync <name>` — this positional form will be
  // removed in a future release.
  if (agentSpec && !opts.agent && !repoArg && listRepoNames().includes(agentSpec)) {
    if (!quiet && !json) {
      console.error(chalk.yellow(`Warning: 'agents sync ${agentSpec}' is deprecated. Use: agents repo sync ${agentSpec}`));
    }
    await runRepoGitSync(agentSpec, quiet, outLog, errLog, json);
    return;
  }

  if (agentSpec) {
    const parsed = parseAgentSpec(agentSpec);
    if (!parsed) {
      failJson({
        mode: 'agent',
        error: `Invalid agent spec '${agentSpec}'.`,
        hint: 'Examples: claude, claude@2.1.142, claude@latest, claude@oldest, claude@pinned, claude@all',
      });
      if (!json) {
        errLog(chalk.red(`Invalid agent spec '${agentSpec}'.`));
        errLog(chalk.gray('Examples: claude, claude@2.1.142, claude@latest, claude@oldest, claude@pinned, claude@all'));
      }
      process.exitCode = 1;
      return;
    }
    agentId = parsed.agent;
    if (agentSpec.includes('@')) selector = parsed.version;
  }

  // --version flag beats any @selector from the positional.
  // Strip a leading @ so '--version @latest' and '--version latest' both work.
  if (opts.version) selector = opts.version.replace(/^@/, '');

  // Repo scope: --repo flag wins over the positional. Validate against the
  // known DotAgent repos so a typo fails loudly instead of syncing nothing.
  const repoScope = opts.repo || repoArg;
  if (repoScope !== undefined) {
    const known = listRepoNames();
    if (!known.includes(repoScope)) {
      failJson({ mode: 'agent', error: `Unknown repo '${repoScope}'.`, known });
      if (!json) {
        errLog(chalk.red(`Unknown repo '${repoScope}'.`));
        errLog(chalk.gray(`Known repos: ${known.join(', ')}`));
      }
      process.exitCode = 1;
      return;
    }
  }

  if (opts.agent) {
    const resolved = resolveAgentName(opts.agent);
    if (!resolved) {
      failJson({ mode: 'agent', error: `Unknown agent '${opts.agent}'.` });
      if (!json) errLog(chalk.red(`Unknown agent '${opts.agent}'.`));
      process.exitCode = 1;
      return;
    }
    agentId = resolved;
  }
  if (agentId && isAgentHardDeprecated(agentId)) {
    failJson({ mode: 'agent', error: hardDeprecationError(agentId) });
    if (!json) errLog(chalk.red(hardDeprecationError(agentId)));
    process.exitCode = 1;
    return;
  }
  if (opts.agentVersion) {
    // Legacy flag and the launch-shim hot path (`--agent-version <concrete>`):
    // pass through verbatim. Selector aliases are a positional-spec feature.
    version = opts.agentVersion;
  }

  if (!agentId) {
    // No agent specified → the umbrella verb: make this machine current
    // (fetch repos + secrets + sessions, then reconcile all installed agents).
    // This is the path fleet fan-out (`--device all`) hits with injected --json.
    await runUmbrella(opts, quiet, outLog, errLog, json);
    return;
  }

  const projectDir = opts.projectDir;
  const cwd = opts.cwd || process.cwd();
  const force = !!opts.force;

  // RUSH-2471: self-heal any version pointer (global/isolated default, ~/.<agent>
  // symlink) left aimed at a version that is no longer installed BEFORE resolving
  // the version to sync. Skipped on --dry-run since it mutates on-disk pointers.
  let healed: HealedVersionPointers = {};
  if (!opts.dryRun) {
    healed = await healDanglingVersionPointers(agentId, cwd);
    if (!quiet && !json) {
      if (healed.globalDefault) {
        const to = healed.globalDefault.to ? `@${healed.globalDefault.to}` : 'none';
        outLog(chalk.yellow(`Reassigned ${agentLabel(agentId)} default from @${healed.globalDefault.from} (not installed) to ${to}.`));
      }
      if (healed.isolatedDefault) {
        const to = healed.isolatedDefault.to ? `@${healed.isolatedDefault.to}` : 'none';
        outLog(chalk.yellow(`Reassigned ${agentLabel(agentId)} isolated default from @${healed.isolatedDefault.from} (not installed) to ${to}.`));
      }
      if (healed.configSymlink) {
        outLog(chalk.yellow(`Repointed ${agentLabel(agentId)} config symlink from @${healed.configSymlink.from} (not installed) to @${healed.configSymlink.to}.`));
      }
    }
  }
  const healedPointers = Object.keys(healed).length > 0 ? { healedPointers: healed } : {};

  // Promote to @all when no version can be resolved and multiple are installed.
  // Replaces the old "no default version pinned" error: bare `agents sync claude`
  // with multiple installed versions and no pinned default now syncs them all.
  if (!selector && !version && !opts.agentVersion) {
    const pinned = resolveVersion(agentId, opts.cwd || process.cwd());
    if (!pinned) {
      const installed = listInstalledVersions(agentId);
      if (installed.length > 1) selector = 'all';
    }
  }

  // ---------- 2a. @all: reconcile every installed version of this agent ----------
  // Non-interactive by design — fanning an interactive preview across N
  // versions is unusable. Honors optional repo scope and per-kind flags.
  if (selector === 'all') {
    const installed = listInstalledVersions(agentId);
    if (installed.length === 0) {
      failJson({ mode: 'agent-all', agent: agentId, error: `No ${agentLabel(agentId)} versions installed.` });
      if (!json) {
        errLog(chalk.red(`No ${agentLabel(agentId)} versions installed.`));
        errLog(chalk.gray(`Install one: agents add ${agentId}@latest`));
      }
      process.exitCode = 1;
      return;
    }
    const kindFilter = parseKindSelection(opts);
    let selection: ResourceSelection | undefined;
    if (repoScope || kindFilter) {
      selection = buildSelection(repoScope ? [`${repoScope}:*`] : [], kindFilter ?? undefined, cwd);
      if (Object.keys(selection).length === 0) {
        if (json) emitJson({ ok: true, mode: 'agent-all', agent: agentId, repo: repoScope, versions: [], note: 'nothing to sync' });
        else outLog(chalk.gray(`Nothing to sync${repoScope ? ` from repo '${repoScope}'` : ''}.`));
        return;
      }
    }
    const scopeLabel = repoScope ? chalk.gray(` (repo: ${repoScope})`) : '';
    if (!json) outLog(chalk.cyan(`Syncing ${installed.length} ${agentLabel(agentId)} version(s)${scopeLabel}.`));
    if (opts.dryRun) {
      if (!quiet && !json) {
        console.log(chalk.cyan(`Dry run — would sync ${agentLabel(agentId)} (${installed.length} version(s))${scopeLabel}:`));
        if (selection) {
          for (const [k, v] of Object.entries(selection) as [string, string[] | 'all'][]) {
            const names = v === 'all' ? chalk.gray('(all)') : v.join(', ');
            console.log(chalk.gray(`  ${k}: ${names}`));
          }
        } else {
          console.log(chalk.gray('  (all resources)'));
        }
      }
      if (json) emitJson({ ok: true, mode: 'dry-run', agent: agentId, repo: repoScope, versions: installed, selection: selection ?? 'all' });
      return;
    }
    const versions: Array<{ version: string; result: SyncResult }> = [];
    for (const v of installed) {
      // A repo scope makes @all a full reconcile of that repo → prune resources
      // it no longer provides. Bare @all (no repo) leaves selection undefined
      // and falls through to the full-sync orphan sweep, so prune is a no-op
      // there (it requires a caller selection).
      const result = syncResourcesToVersion(agentId, v, selection, { projectDir, cwd, force, prune: !!repoScope, allowExecSurfaces: !!opts.allowExecSurfaces });
      versions.push({ version: v, result });
      if (!quiet && !json) printSyncDetail(result, agentId, v, cwd);
    }
    // Verify each version actually converged; a repo-scoped sync only touched
    // that repo's kinds, so skip verification there (the other layers legitimately
    // still differ and are not this run's responsibility).
    const residual = repoScope
      ? []
      : verifyReconciled(versions.map(({ version: v }) => ({ agent: agentId, version: v })), cwd);
    if (!quiet && !json) printResidual(residual, errLog);
    // Post-reconcile repair over exactly the versions just reconciled (the
    // superset of the old `doctor --fix`). Runs under --json too (fleet fan-out);
    // only its human detail is gated on !quiet && !json.
    const allRepair = await repairAfterSync({ agent: agentId, versions: installed, cwd });
    if (!quiet && !json) renderRepairAfterSync(allRepair, outLog);
    const allRepairFailed = repairHadFailures(allRepair);
    if (allRepairFailed) process.exitCode = 1;
    if (json) {
      emitJson({
        // Any version that refused a write, any residual drift, or a repair
        // failure makes the whole run not-ok (RUSH-2700 + PHNX-3186).
        ok: versions.every(({ result }) => result.declined.length === 0) && residual.length === 0 && !allRepairFailed,
        mode: 'agent-all',
        agent: agentId,
        repo: repoScope,
        residualDrift: residual,
        repair: repairAfterSyncJson(allRepair),
        ...healedPointers,
        versions: versions.map(({ version: v, result }) => ({
          version: v,
          commands: !!result.commands,
          skills: !!result.skills,
          hooks: !!result.hooks,
          memory: result.memory,
          mcp: result.mcp,
          permissions: !!result.permissions,
          subagents: result.subagents,
          plugins: result.plugins,
          workflows: result.workflows,
          pruned: result.pruned,
          declined: result.declined,
        })),
      });
    }
    return;
  }

  // ---------- 2. Resolve version (project pin → global default → sole installed) ----------
  // A positional @selector wins over the default-resolution below.
  //   @latest / @oldest        → newest / oldest installed (process.exit if none)
  //   @pinned / @default       → undefined → fall through to the default path
  //   @x.y.z                   → that version (process.exit if not installed)
  if (selector !== undefined && !version) {
    version = resolveVersionAlias(agentId, selector);
  }

  if (!version) {
    version = resolveVersion(agentId, process.cwd()) || undefined;
    if (!version) {
      const installed = listInstalledVersions(agentId);
      if (installed.length === 1) {
        version = installed[0];
      } else if (installed.length === 0) {
        failJson({ mode: 'agent', agent: agentId, error: `No ${agentLabel(agentId)} versions installed.` });
        if (!json) {
          errLog(chalk.red(`No ${agentLabel(agentId)} versions installed.`));
          errLog(chalk.gray(`Install one: agents add ${agentId}@latest`));
        }
        process.exitCode = 1;
        return;
      } else {
        // Multiple installed, no default — promoted to @all before reaching here.
        // This branch is a safety net for unexpected flow; normal callers won't hit it.
        failJson({
          mode: 'agent',
          agent: agentId,
          error: `No default ${agentLabel(agentId)} version pinned.`,
          installed,
          hint: `Use agents sync ${agentId}@all to sync every installed version, or agents sync ${agentId}@latest for the newest.`,
        });
        if (!json) {
          errLog(chalk.red(`No default ${agentLabel(agentId)} version pinned.`));
          errLog(chalk.gray(`  Sync all:    agents sync ${agentId}@all`));
          errLog(chalk.gray(`  Sync newest: agents sync ${agentId}@latest`));
        }
        process.exitCode = 1;
        return;
      }
    }
  }

  if (!isVersionInstalled(agentId, version)) {
    const installed = listInstalledVersions(agentId);
    failJson({
      mode: 'agent',
      agent: agentId,
      version,
      error: `${agentLabel(agentId)}@${version} is not installed.`,
      installed,
    });
    if (!json) {
      errLog(chalk.red(`${agentLabel(agentId)}@${version} is not installed.`));
      if (installed.length > 0) {
        errLog(chalk.gray(`Installed: ${installed.join(', ')}`));
      }
      errLog(chalk.gray(`Install it: agents add ${agentId}@${version}`));
    }
    process.exitCode = 1;
    return;
  }

  // ---------- 3. --launch mode bypasses everything below ----------
  if (opts.launch) {
    runLaunchMode(agentId, version, cwd, quiet, json);
    return;
  }

  // ---------- 3b. Repo-scoped or kind-filtered single-version sync ----------
  // An explicit --repo / positional repo, or any per-kind flag, is a targeted
  // request: skip the interactive preview and reconcile only the specified scope.
  const kindFilter = parseKindSelection(opts);
  if (repoScope || kindFilter) {
    const scoped = buildSelection(repoScope ? [`${repoScope}:*`] : [], kindFilter ?? undefined, cwd);
    if (Object.keys(scoped).length === 0) {
      if (json) {
        emitJson({
          ok: true,
          mode: 'agent',
          agent: agentId,
          version,
          ...(repoScope !== undefined ? { repo: repoScope } : {}),
          note: 'nothing to sync',
        });
      } else {
        outLog(chalk.gray(`Nothing to sync${repoScope ? ` from repo '${repoScope}'` : ''} into ${agentLabel(agentId)}@${version}.`));
      }
      return;
    }
    if (opts.dryRun) {
      if (!quiet && !json) {
        console.log(chalk.cyan(`Dry run — would sync into ${agentLabel(agentId)}@${version}${repoScope ? ` (repo: ${repoScope})` : ''}:`));
        for (const [k, v] of Object.entries(scoped) as [string, string[] | 'all'][]) {
          const names = v === 'all' ? chalk.gray('(all)') : v.join(', ');
          console.log(chalk.gray(`  ${k}: ${names}`));
        }
      }
      if (json) emitJson({ ok: true, mode: 'dry-run', agent: agentId, version, repo: repoScope, selection: scoped });
      return;
    }
    const result = syncResourcesToVersion(agentId, version, scoped, { projectDir, cwd, force, prune: !!repoScope, allowExecSurfaces: !!opts.allowExecSurfaces });
    const scopedRepair = await repairAfterSync({ agent: agentId, versions: [version], cwd });
    const scopedRepairFailed = repairHadFailures(scopedRepair);
    if (scopedRepairFailed) process.exitCode = 1;
    if (json) {
      const base = agentSyncJson(agentId, version, result, repoScope);
      emitJson({ ...base, ok: base.ok === true && !scopedRepairFailed, repair: repairAfterSyncJson(scopedRepair) });
    } else if (!quiet) {
      printSyncDetail(result, agentId, version, cwd);
      renderRepairAfterSync(scopedRepair, outLog);
    }
    return;
  }

  // ---------- 4. Decide selection (interactive preview vs auto) ----------
  // --json forces non-interactive (machine consumer / fleet fan-out).
  const yes = !!opts.yes || json;
  const interactive = !quiet && !yes && isInteractiveTerminal();

  let selection: ResourceSelection | undefined;

  if (interactive) {
    const available = getAvailableResources(cwd);
    const actuallySynced = getActuallySyncedResources(agentId, version, { cwd });
    const projectOnly = getProjectOnlyResources(cwd);
    const newResources = getNewResources(available, actuallySynced, projectOnly);
    const hasAnySynced = anyResources(actuallySynced);

    try {
      if (!hasAnySynced) {
        outLog(chalk.cyan(`Syncing to ${agentLabel(agentId)}@${version}.`));
        const userSelection = await promptResourceSelection(agentId);
        if (!userSelection || Object.keys(userSelection).length === 0) {
          outLog(chalk.gray('Nothing selected. No changes made.'));
          return;
        }
        selection = userSelection;
      } else if (hasNewResources(newResources, agentId, version)) {
        const userSelection = await promptNewResourceSelection(agentId, newResources, version);
        if (!userSelection || Object.keys(userSelection).length === 0) {
          outLog(chalk.gray('Nothing selected. No changes made.'));
          return;
        }
        selection = userSelection;
      } else if (!force) {
        // Tracked resources match source — but a generated hook shim can still be
        // broken on an otherwise in-sync version (the yosemite-s1 class), and
        // syncResourcesToVersion never generates it. Run the repair pass BEFORE
        // the early return so a broken shim is still fixed on bare
        // `agents sync <agent>`, then report what (if anything) it touched.
        const repair = await repairAfterSync({ agent: agentId, versions: [version], cwd });
        if (repairChangedAnything(repair)) {
          renderRepairAfterSync(repair, outLog);
        } else {
          outLog(chalk.gray(`${agentLabel(agentId)}@${version} is already in sync.`));
          outLog(chalk.gray('Run with --force to re-sync, or --yes to bypass this check.'));
        }
        if (repairHadFailures(repair)) process.exitCode = 1;
        return;
      }
      // else: --force on a fully-synced version → selection stays undefined,
      // syncResourcesToVersion falls through to its pattern-based full sync.
    } catch (e) {
      if (isPromptCancelled(e)) {
        outLog(chalk.gray('Cancelled. No changes made.'));
        return;
      }
      throw e;
    }
  }

  // ---------- 5. Run sync ----------
  if (opts.dryRun) {
    if (!quiet && !json) {
      console.log(chalk.cyan(`Dry run — would sync into ${agentLabel(agentId)}@${version}${repoScope ? ` (repo: ${repoScope})` : ''}:`));
      if (selection) {
        for (const [k, v] of Object.entries(selection) as [string, string[] | 'all'][]) {
          const names = v === 'all' ? chalk.gray('(all)') : v.join(', ');
          console.log(chalk.gray(`  ${k}: ${names}`));
        }
      } else {
        console.log(chalk.gray('  (all resources)'));
      }
    }
    if (json) emitJson({ ok: true, mode: 'dry-run', agent: agentId, version, repo: repoScope, selection: selection ?? 'all' });
    return;
  }
  const result = syncResourcesToVersion(agentId, version, selection, { projectDir, cwd, force, allowExecSurfaces: !!opts.allowExecSurfaces });

  // Post-reconcile verification (PHNX-3186). Only for a FULL reconcile
  // (`!selection`): an interactive subset-selection deliberately touched only the
  // picked kinds, so the rest legitimately still differs and is not this run's
  // failure. This is the exact path `agents sync <agent>[@version]` takes.
  const residual = selection ? [] : verifyReconciled([{ agent: agentId, version }], cwd);

  // Post-reconcile repair over the single version just reconciled (the superset
  // of the old `doctor --fix`). Runs under --json too; only its human detail is
  // gated on the non-quiet path below.
  const singleRepair = await repairAfterSync({ agent: agentId, versions: [version], cwd });
  const singleRepairFailed = repairHadFailures(singleRepair);
  if (singleRepairFailed) process.exitCode = 1;

  // Compile project-scope rules into the workspace itself so each agent's
  // native loader picks up cwd/<INSTRUCTIONS_FILE>. projectDir is the
  // .agents/ directory; the workspace root is its parent.
  let projectCompile: ReturnType<typeof compileRulesForProject> | null = null;
  if (projectDir) {
    const projectRoot = path.dirname(projectDir);
    projectCompile = compileRulesForProject(projectRoot);
  }

  if (json) {
    const base = agentSyncJson(agentId, version, result);
    emitJson({
      ...base,
      ok: base.ok === true && residual.length === 0 && !singleRepairFailed,
      residualDrift: residual,
      repair: repairAfterSyncJson(singleRepair),
      ...healedPointers,
      projectCompile: projectCompile
        ? {
            compiled: !!projectCompile.compiled,
            agentsPath: projectCompile.agentsPath,
            symlinks: projectCompile.symlinks,
            skippedClobber: projectCompile.skippedClobber,
          }
        : null,
    });
    return;
  }

  if (quiet) return;

  // ---------- 6. Detailed output ----------
  printSyncDetail(result, agentId, version, cwd);
  printResidual(residual, errLog);
  renderRepairAfterSync(singleRepair, outLog);

  if (projectCompile?.compiled) {
    const linkInfo = projectCompile.symlinks.length > 0
      ? ` (+ ${projectCompile.symlinks.join(', ')})`
      : '';
    console.log(chalk.gray(`Compiled project rules → ${projectCompile.agentsPath}${linkInfo}`));
  }
  if (projectCompile && projectCompile.skippedClobber.length > 0) {
    console.log(chalk.yellow(
      `Skipped (user-authored, not overwritten): ${projectCompile.skippedClobber.join(', ')}`,
    ));
  }
}

/** Stable `--json` payload for a single agent@version resource sync. */
function agentSyncJson(
  agent: AgentId,
  version: string,
  result: SyncResult,
  repo?: string,
): Record<string, unknown> {
  return {
    // A refused resource is not a clean sync. `ok` was hardcoded true, so the
    // machine surface (`--host all` fan-out) reported success for exactly the
    // silent no-op this changed (RUSH-2677).
    ok: result.declined.length === 0,
    mode: 'agent',
    agent,
    version,
    ...(repo !== undefined ? { repo } : {}),
    commands: !!result.commands,
    skills: !!result.skills,
    hooks: !!result.hooks,
    memory: result.memory,
    mcp: result.mcp,
    permissions: !!result.permissions,
    subagents: result.subagents,
    plugins: result.plugins,
    workflows: result.workflows,
    projectSkipped: result.projectSkipped,
    pruned: result.pruned,
    declined: result.declined,
  };
}

function anyResources(r: AvailableResources): boolean {
  return r.commands.length + r.skills.length + r.hooks.length + r.memory.length +
    r.mcp.length + r.permissions.length + r.subagents.length +
    r.plugins.length + r.workflows.length > 0;
}

/** Format the post-sync detail output: per-kind count + a name preview. */
function printSyncDetail(result: SyncResult, agent: AgentId, version: string, cwd: string): void {
  // Booleans in SyncResult (commands, skills, hooks, permissions) carry no
  // name list. Re-derive ground truth from the version home so the user
  // sees what's actually present after the sync.
  const synced = getActuallySyncedResources(agent, version, { cwd });

  type Line = { kind: string; items: string[] };
  const lines: Line[] = [];
  if (result.commands)              lines.push({ kind: 'commands',    items: synced.commands });
  if (result.skills)                lines.push({ kind: 'skills',      items: synced.skills });
  if (result.hooks)                 lines.push({ kind: 'hooks',       items: synced.hooks });
  if (result.memory.length > 0)     lines.push({ kind: 'memory',      items: result.memory });
  if (result.permissions)           lines.push({ kind: 'permissions', items: synced.permissions });
  if (result.mcp.length > 0)        lines.push({ kind: 'mcp',         items: result.mcp });
  if (result.subagents.length > 0)  lines.push({ kind: 'subagents',   items: result.subagents });
  if (result.plugins.length > 0)    lines.push({ kind: 'plugins',     items: result.plugins });
  if (result.workflows.length > 0)  lines.push({ kind: 'workflows',   items: result.workflows });

  const kept = formatKeptProjectResources(result.projectSkipped);

  // Removals from source-deleted resources (RUSH-2438). Rendered even when
  // nothing was added, so a reconcile that only pruned still reports it.
  const prunedLines = (Object.entries(result.pruned) as Array<[string, string[]]>)
    .filter(([, names]) => names.length > 0)
    .map(([kind, names]) => ({ kind, items: names }));

  if (lines.length === 0 && prunedLines.length === 0 && result.declined.length === 0) {
    console.log(chalk.gray(`Already in sync — ${agentLabel(agent)}@${version}`));
    if (kept) console.log(chalk.gray(kept));
    return;
  }

  const PREVIEW = 5;
  const printKindLine = (label: string, items: string[], width: number, color: (s: string) => string) => {
    const padded = label.padEnd(width);
    const sorted = [...items].sort((a, b) => a.localeCompare(b));
    const preview = sorted.slice(0, PREVIEW).join(', ');
    const more = sorted.length > PREVIEW ? chalk.gray(`, +${sorted.length - PREVIEW} more`) : '';
    const count = color(`(${sorted.length})`.padStart(5));
    console.log(`  ${chalk.bold(padded)}  ${count}  ${chalk.gray(preview)}${more}`);
  };

  if (lines.length > 0) {
    console.log(chalk.green(`Synced to ${agentLabel(agent)}@${version}:`));
    const kindWidth = Math.max(...lines.map(l => l.kind.length));
    for (const { kind, items } of lines) printKindLine(kind, items, kindWidth, chalk.cyan);
  }

  if (prunedLines.length > 0) {
    console.log(chalk.yellow(`Pruned from ${agentLabel(agent)}@${version} (removed from source):`));
    const kindWidth = Math.max(...prunedLines.map(l => l.kind.length));
    for (const { kind, items } of prunedLines) printKindLine(kind, items, kindWidth, chalk.yellow);
  }

  // A resource agents-cli refused to write is reported, never swallowed — an
  // empty synced list on its own reads as "nothing to do" (RUSH-2677).
  if (result.declined.length > 0) {
    console.log(chalk.yellow(`Not written to ${agentLabel(agent)}@${version}:`));
    for (const reason of result.declined) console.log(`  ${chalk.yellow(reason)}`);
  }

  if (kept) console.log(chalk.gray(kept));
}

function runLaunchMode(agent: AgentId, version: string, cwd: string, quiet: boolean, json = false): void {
  let result;
  try {
    result = runLaunchSync({ agent, version, cwd });
  } catch (err) {
    if (json) {
      emitJson({
        ok: false,
        mode: 'launch',
        agent,
        version,
        error: (err as Error).message,
      });
      process.exitCode = 1;
    } else if (!quiet) {
      console.error(chalk.yellow(`agents: launch sync skipped (${(err as Error).message})`));
    }
    return;
  }

  if (json) {
    emitJson({
      ok: true,
      mode: 'launch',
      agent,
      version,
      rulesCompiled: !!result.rulesCompiled,
      workspaceLinks: result.workspaceLinks,
      marketplaces: result.marketplaces,
      workspaceSkipped: result.workspaceSkipped,
    });
    return;
  }

  if (quiet) return;

  const bits: string[] = [];
  if (result.rulesCompiled) bits.push('rules');
  if (result.workspaceLinks > 0) bits.push(`${result.workspaceLinks} project resource(s)`);
  const mpCount = Object.keys(result.marketplaces).length;
  if (mpCount > 0) {
    const pluginCount = Object.values(result.marketplaces).reduce((acc, names) => acc + names.length, 0);
    bits.push(`${pluginCount} plugin(s) across ${mpCount} marketplace(s)`);
  }

  if (bits.length === 0) {
    console.log(chalk.gray('No project resources to compile'));
  } else {
    console.log(chalk.green(`Launch sync: ${bits.join(', ')}`));
  }

  const kept = formatKeptProjectResources(result.workspaceSkipped);
  if (kept) console.log(chalk.gray(kept));
}
