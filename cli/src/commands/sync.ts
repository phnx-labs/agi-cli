
import * as path from 'path';
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { resolveSyncPassphraseFromEnv } from '../lib/sync-passphrase.js';
import { agentLabel, resolveAgentName, MANAGED_AGENT_IDS, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
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
  json?: boolean;
  repos?: boolean;
  secrets?: boolean;
  cloud?: boolean;
  local?: boolean;
  pruneClis?: boolean;
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

function emitJson(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

// Verify only full reconciles. Residual drift is ok:false, but peer commands
// still exit zero so fleet passthrough does not discard their JSON.
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
  return residual;
}

function printResidual(residual: ResidualDrift[], errLog: (msg: string) => void): void {
  if (residual.length === 0) return;
  const lines = formatResidualDrift(residual);
  errLog(chalk.yellow(`⚠ sync did not fully reconcile — ${lines.length} resource(s) still drift after writing:`));
  for (const line of lines) errLog(chalk.yellow(`  ${line}`));
  errLog(chalk.gray('  Re-run the sync; a gap that survives a re-run is a real unreconcilable drift — report it.'));
}

function parseKindSelection(opts: SyncOpts): ResourceSelection | undefined {
  // Bare singular/plural flags mean all, arrays mean named resources;
  // rule(s)/memory always recompiles the full composed memory.
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
    .option('--repos', 'Umbrella: git-pull ~/.agents + enabled ~/.agents-* extras', false)
    .option('--secrets', 'Umbrella: pull encrypted secret bundles from the remote', false)
    .option('--cloud', 'Umbrella: fetch all remote state but skip the local reconcile', false)
    .option('--local', "Umbrella: reconcile resources into installed agents only (no fetch)", false)
    .option('--prune-clis', 'Umbrella: also purge stale/legacy agents-cli installs (npx-cache, pre-1.22.30, unsafe helper) when a fixed peer exists. DESTRUCTIVE and off by default — the purge never runs on a routine sync.', false)
    .action(async (agentSpec: string | undefined, repo: string | undefined, opts: SyncOpts) => {
      await runSync(agentSpec, repo, opts);
    });

  addSelectorOptions(cmd);
  registerStatusCommand(cmd);
}

function resolveRepoGitTarget(repo: string): { dir: string; push: boolean } | null {
  // System is pull-only; user/extras push. Project is never independently git-synced.
  if (repo === 'system') return { dir: getSystemAgentsDir(), push: false };
  if (repo === 'user') return { dir: getUserAgentsDir(), push: true };
  const extra = getEnabledExtraRepos().find((e) => e.alias === repo);
  if (extra) return { dir: extra.dir, push: true };
  return null;
}

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

  if (repo === 'user') {
    // Adopt partial user repos in place and persist their remote before JSON return.
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

function repoChoiceLabel(repo: string): string {
  switch (repo) {
    case 'system': return 'system  — shared, npm-shipped defaults';
    case 'user': return 'user    — your ~/.agents config';
    case 'project': return "project — this repo's .agents";
    default: return `${repo}  — extra repo`;
  }
}

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

  for (const repo of repos) {
    const target = resolveRepoGitTarget(repo);
    if (!target) continue;
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


  const selection = mergeRepoScopedSelections(repos, cwd);
  const hasResources = selection.memory === 'all' || Object.entries(selection).some(
    ([kind, v]) => kind !== 'memory' && Array.isArray(v) && v.length > 0,
  );
  if (!hasResources) {
    outLog(chalk.gray(`Nothing from ${repos.join(', ')} to sync.`));
    return;
  }

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

  for (const t of touched) {
    const repair = await repairAfterSync({ agent: t.agent, versions: [t.version], cwd });
    renderRepairAfterSync(repair, outLog);
  }

  const umbrellaRepair = await repairAfterSync({ cwd, pruneClis: !!opts.pruneClis });
  renderRepairAfterSync(umbrellaRepair, outLog);
  if (repairHadFailures(umbrellaRepair)) process.exitCode = 1;
}

async function runUmbrella(
  opts: SyncOpts,
  quiet: boolean,
  outLog: (msg: string) => void,
  errLog: (msg: string) => void,
  json = false,
): Promise<void> {
  // Umbrella dry-run must fail before mutation; stale-CLI pruning is explicit.
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

  // Kind-only umbrella requests stay local unless fetch was explicit; browser
  // setup remains owned by the standalone browser CLI.
  const kindSelection = parseKindSelection(opts);
  const anyExplicitFlag = !!(opts.repos || opts.secrets || opts.cloud || opts.local || kindSelection);
  if (!quiet && !json && !opts.yes && !anyExplicitFlag && isInteractiveTerminal()) {
    await runInteractiveReconcile(opts, outLog, errLog);
    return;
  }

  const cwd = opts.cwd || process.cwd();
  const flags: UmbrellaFlags = {
    repos: opts.repos,
    secrets: opts.secrets,
    cloud: opts.cloud,
    local: opts.local || (!!kindSelection && !opts.repos && !opts.secrets && !opts.cloud),
  };
  const passphrase = resolveSyncPassphraseFromEnv().value ?? undefined;

  const yes = !!opts.yes || json;

  if (!quiet && !json) outLog(chalk.bold('Syncing this machine…'));
  try {
    const result = await runUmbrellaSync({
      flags,
      yes,
      passphrase,
      quiet: quiet || json,
      selection: kindSelection,
      allowExecSurfaces: !!opts.allowExecSurfaces,
      log: (msg) => { if (!quiet && !json) outLog(chalk.gray(`  ${msg}`)); },
    });


    const residual = result.reconciled && !kindSelection
      ? verifyReconciled(
          result.reconciledVersions.map((r) => ({ agent: r.agent as AgentId, version: r.version })),
          cwd,
        )
      : [];

    const repair = opts.cloud || kindSelection
      ? null
      : await repairAfterSync({ cwd, pruneClis: !!opts.pruneClis });
    const repairFailed = repair !== null && repairHadFailures(repair);
    if (repairFailed) process.exitCode = 1;

    if (json) {
      emitJson({
        ok: result.declined.length === 0 && residual.length === 0 && !repairFailed,
        mode: 'umbrella',
        plan: result.plan,
        repos: result.repos,
        secrets: result.secrets,
        devices: result.devices,
        reconciled: result.reconciled,
        selection: kindSelection ?? null,
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
  // --json is noninteractive fleet fan-out and emits exactly one JSON object.
  // Preserve explicit @selectors before parseAgentSpec defaults bare agents.
  const json = !!opts.json;
  const quiet = !!opts.quiet || json;
  const errLog = (msg: string) => { if (!quiet) console.error(msg); };
  const outLog = (msg: string) => { if (!quiet) console.log(msg); };
  const failJson = (payload: Record<string, unknown>) => {
    if (json) emitJson({ ok: false, ...payload });
  };

  let agentId: AgentId | undefined;
  let version: string | undefined;

  let selector: string | undefined;

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

  if (opts.version) selector = opts.version.replace(/^@/, '');

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
    version = opts.agentVersion;
  }

  if (!agentId) {
    await runUmbrella(opts, quiet, outLog, errLog, json);
    return;
  }

  const projectDir = opts.projectDir;
  const cwd = opts.cwd || process.cwd();
  const force = !!opts.force;

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

  if (!selector && !version && !opts.agentVersion) {
    const pinned = resolveVersion(agentId, opts.cwd || process.cwd());
    if (!pinned) {
      const installed = listInstalledVersions(agentId);
      if (installed.length > 1) selector = 'all';
    }
  }

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
      const result = syncResourcesToVersion(agentId, v, selection, { projectDir, cwd, force, prune: !!repoScope, allowExecSurfaces: !!opts.allowExecSurfaces });
      versions.push({ version: v, result });
      if (!quiet && !json) printSyncDetail(result, agentId, v, cwd);
    }
    const residual = repoScope
      ? []
      : verifyReconciled(versions.map(({ version: v }) => ({ agent: agentId, version: v })), cwd);
    if (!quiet && !json) printResidual(residual, errLog);
    const allRepair = await repairAfterSync({ agent: agentId, versions: installed, cwd });
    if (!quiet && !json) renderRepairAfterSync(allRepair, outLog);
    const allRepairFailed = repairHadFailures(allRepair);
    if (allRepairFailed) process.exitCode = 1;
    if (json) {
      emitJson({
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

  if (opts.launch) {
    // Shim hot path: project-only work, no version-home reconcile; keep steady state sub-50ms.
    runLaunchMode(agentId, version, cwd, quiet, json);
    return;
  }

  const kindFilter = parseKindSelection(opts);
  if (repoScope || kindFilter) {
    // After an actual targeted reconcile, skip full-tree verification and repair generated shims.
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
        // Even a no-drift path repairs generated shims before returning.
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
    } catch (e) {
      if (isPromptCancelled(e)) {
        outLog(chalk.gray('Cancelled. No changes made.'));
        return;
      }
      throw e;
    }
  }

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

  const residual = selection ? [] : verifyReconciled([{ agent: agentId, version }], cwd);

  const singleRepair = await repairAfterSync({ agent: agentId, versions: [version], cwd });
  const singleRepairFailed = repairHadFailures(singleRepair);
  if (singleRepairFailed) process.exitCode = 1;

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

function agentSyncJson(
  agent: AgentId,
  version: string,
  result: SyncResult,
  repo?: string,
): Record<string, unknown> {
  // Machine success must include declines, residual drift, and repair failures at the caller.
  return {
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

function printSyncDetail(result: SyncResult, agent: AgentId, version: string, cwd: string): void {
  // Human output re-reads installed truth and reports both pruned and declined resources.
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
