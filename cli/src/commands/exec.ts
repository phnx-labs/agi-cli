/**
 * Agent execution command.
 *
 * Registers the `agents run` command which spawns agent CLIs interactively
 * or headlessly. Supports profile resolution, version rotation, secrets
 * injection, and multi-agent fallback chains for rate-limit resilience.
 */

import { InvalidArgumentError, Option, type Command } from 'commander';
import chalk from 'chalk';
import type { ExecOptions, ExecMode, ExecEffort, FallbackEntry } from '../lib/exec.js';
import { isTierToken } from '../lib/model-tiers.js';
import type { AgentId } from '../lib/types.js';
import { RUN_AUTO_KEYWORD } from '../lib/types.js';
import type { ResolvedRunDefaults } from '../lib/run-defaults.js';
import { setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';
import { getUserAgentsDir, readMeta } from '../lib/state.js';
import type { CrabboxBox } from '../lib/crabbox/cli.js';
import { parseLoopInterval } from '../lib/loop.js';
import type { RotateResult } from '../lib/accounting/rotate.js';
import { AGENTS, resolveAgentName, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import { parseAgentVersionSpec } from '../lib/agent-spec/agents.js';
import { recordDispatchedRun } from '../lib/audit/log.js';
import { maybeShowStarNudge } from '../lib/star-nudge.js';
import { warnUnpushedWork, shouldWarnUnpushed } from '../lib/warn-unpushed.js';
import { warnOrphanedOpenPr } from '../lib/pr-land-detach.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { isSessionTrackedAgent } from '../lib/session/types.js';
import { applyActiveRulesPresetAtRun } from '../lib/rules/run-sync.js';
import { applySystemResourcesAtRun } from '../lib/system-run-sync.js';
import { handleBroadcast } from './run-broadcast.js';
import { bootMark } from '../lib/boot-profile.js';

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  /** --project <slug>[@worktree]: resolve cwd from the projects root shorthand. */
  project?: string;
  addDir: string[];
  env: string[];
  secrets: string[];
  /** Commander maps `--no-auto-secrets` to `autoSecrets` (default true, false when passed). */
  autoSecrets?: boolean;
  json?: boolean;
  quiet?: boolean;
  headless?: boolean;
  interactive?: boolean;
  /** --no-auth-check: Commander maps it to `authCheck` (default true, false when passed). Silences the logged-out preflight warning on an interactive launch. */
  authCheck?: boolean;
  /** --resume [id]: string id/prefix, or `true` for the bare flag (interactive picker). */
  resume?: string | boolean;
  sessionId?: string;
  /** --name <slug>: durable launch handle, resolvable via `agents sessions <name>`. */
  name?: string;
  /** --notify: post a desktop notification when a headless run finishes. */
  notify?: boolean;
  /** `--no-trace-sync` → commander maps it to `traceSync` (default true, false when passed). Skips the run-exit trace auto-sync for this run (PHNX-3628). */
  traceSync?: boolean;
  /** --terminal [backend]: open this run in a terminal tab; `true` = auto-detect. */
  terminal?: string | boolean;
  verbose?: boolean;
  raw?: boolean;
  /** `--no-tmux` → commander sets this false (default true) to bypass the tmux wrapper. */
  tmux?: boolean;
  /** `--disable-tmux` → explicit alias of --no-tmux. */
  disableTmux?: boolean;
  timeout?: string;
  fallback?: string;
  balanced?: boolean;
  strategy?: string;
  /** Restrict selection to a named provider account discovered from live version homes. */
  account?: string;
  /**
   * @deprecated Hidden alias for `--device auto`. Resolved before host dispatch.
   * Remove after one release.
   */
  smart?: boolean;
  acp?: boolean;
  yes?: boolean;
  loop?: boolean;
  resumeCheckpoint?: string;
  maxIterations?: string;
  budget?: string;
  until?: string;
  interval?: string;
  // Host dispatch: run on a registered agent device instead of locally.
  // `--device` is canonical; `--on`/`--computer` are hidden aliases.
  // `--where` is the unified placement alias (lib/placement.ts) — expands into
  // device/lease before dispatch; do not combine with those flags.
  where?: string;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  remoteCwd?: string;
  follow?: boolean; // --no-follow sets this false
  any?: boolean;
  copyCreds?: boolean;
  lease?: string | boolean; // --lease [backend]: true when bare, backend string when given
  box?: string; // --box <slug>: reuse an existing warm crabbox box
  keepBox?: boolean; // --keep-box: don't tear down the leased box after the run
  fresh?: boolean; // --fresh: with --lease, skip the warm profile-pool reuse and always provision a new box
  reuse?: boolean; // --reuse: reuse the most-recently-used warm box if one exists
  bare?: boolean; // --bare: skip copying the local ~/.agents setup onto the box
  tailscale?: boolean; // --tailscale / --no-tailscale: tri-state net-mode override
  // Cloud placement: dispatch to the agent's native vendor cloud via the
  // cloud provider registry (commands/run-cloud.ts). Mutually exclusive with
  // the machine-placement flags above (one placement door).
  cloud?: boolean; // --cloud: vendor cloud placement
  provider?: string; // --provider <id>: override the agent's native cloud provider
  repo?: string[]; // --repo <owner/repo> (repeatable): GitHub repo(s) for the cloud task
  branch?: string; // --branch <name>: target git branch for the cloud task
  cloudEnv?: string; // --cloud-env <id>: Codex Cloud environment id (--env is taken by KEY=VAL passthrough)
  secretsKeys?: string; // --secrets-keys: comma-separated key subset for --secrets bundles
  allowExpired?: boolean; // --allow-expired: skip expiry pre-run abort for secrets
  emitSessionId?: boolean; // internal: forwarded by --device dispatch so the remote run prints its session id (hosts/session-marker.ts)
  /** --broadcast: matrix-run the same prompt/task across agents × models. */
  broadcast?: boolean;
  /** --task <id>: house broadcast task (with --broadcast). */
  task?: string;
  /** --list-tasks: list broadcast tasks. */
  listTasks?: boolean;
  /** --results [run-id]: show saved broadcast runs. */
  results?: string | true;
  /** --concurrency <n>: broadcast cell parallelism. */
  concurrency?: string;
}

/** Validate a caller-supplied session id before it reaches tmux, paths, indexes, or remote dispatch. */
export function parseExplicitSessionId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new InvalidArgumentError(
      'must contain only ASCII letters, digits, dots, underscores, or hyphens',
    );
  }
  return value;
}

export interface RunAccountPickerRequest {
  requested: boolean;
  normalizedAgentSpec: string;
  valid: boolean;
}

/** Distinguish a terminal account-picker marker from an explicit @version pin. */
export function parseRunAccountPickerRequest(agentSpec: string): RunAccountPickerRequest {
  const requested = agentSpec.endsWith('@');
  const normalizedAgentSpec = requested ? agentSpec.slice(0, -1) : agentSpec;
  return {
    requested,
    normalizedAgentSpec,
    valid: !requested || (!!normalizedAgentSpec && !normalizedAgentSpec.includes('@')),
  };
}

/**
 * The `--device` alias family — the flags that mean "dispatch this run to another
 * machine over SSH". `--device` is canonical; `--on`/`--computer` are hidden
 * aliases. Returns the values actually given (so callers can both test presence
 * and read the target). Kept in ONE place because a guard that listed only a
 * subset silently let `--terminal --device` open a local tab and drop the remote
 * target — the drift this predicate exists to prevent.
 */
export function hostTargetGiven(options: {
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
}): string[] {
  return [options.host, options.device, options.on, options.computer].filter(
    (v): v is string => !!v,
  );
}

/** Return every option whose selection semantics conflict with an account choice. */
export function runAccountPickerConflicts(options: {
  resume?: string | boolean;
  strategy?: string;
  balanced?: boolean;
  lease?: string | boolean;
  box?: string;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
}): string[] {
  const conflicts: string[] = [];
  if (options.resume !== undefined) conflicts.push('--resume');
  if (options.strategy !== undefined) conflicts.push('--strategy');
  if (options.balanced) conflicts.push('--balanced');
  if (options.lease) conflicts.push('--lease');
  if (options.box) conflicts.push('--box');
  return conflicts;
}

/** Type guard that narrows a string to a known AgentId. */
function isValidAgent(agent: string): agent is AgentId {
  return agent in AGENTS;
}

// Reserved `<agent>` keyword for `agents run auto` — canonical definition in
// lib/types.ts (shared with the host dispatch layer); re-exported here.
export { RUN_AUTO_KEYWORD };

/**
 * Whether `run auto` should default its host layer to the affinity pick (the
 * same machinery as `--device auto`). False when the caller pinned any host
 * flag, and false when this process was itself dispatched by a host run — the
 * dispatcher exports AGENTS_RUN_AUTO_HOST_RESOLVED=1 into the remote SHELL
 * (hosts/dispatch.ts remoteRunShellPrelude) because it already resolved the
 * host layer, and re-picking here would chain-hop the run across the fleet.
 * Pure so the pinning matrix is unit-testable.
 */
export function runAutoDefaultsToAffinity(
  options: { host?: string; device?: string; on?: string; computer?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hostTargetGiven(options).length > 0) return false;
  return env.AGENTS_RUN_AUTO_HOST_RESOLVED !== '1';
}

/**
 * Whether an interactive host dispatch must mint a correlation launch id and
 * resolve the remote session via the launch-id join (RUSH-2034), rather than
 * trusting a pre-known session id. `run auto` ALWAYS joins: the harness is
 * picked on the remote, so an explicit --session-id is only adopted when the
 * pick lands on claude — pre-registering it would strand a stale session-index
 * entry naming an id a non-claude pick never used (RUSH-2132). Pure so the
 * decision matrix is unit-testable.
 */
export function hostInteractiveNeedsCorrelationId(
  runAgent: string,
  hostSessionId: string | undefined,
  resumeId: string | undefined,
): boolean {
  if (resumeId) return false;
  if (runAgent === RUN_AUTO_KEYWORD) return true;
  return !hostSessionId && isSessionTrackedAgent(runAgent);
}

/** Build a one-line banner describing which version the strategy picked. */
function formatRotationBanner(result: RotateResult, verb: string = 'balanced'): string {
  const { picked, healthy, excluded } = result;
  const label = picked.email ? `${picked.email} · ${picked.agent}@${picked.version}` : `${picked.agent}@${picked.version}`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} healthy`;
  // Say it when the pick was a guess. A machine whose usage refresh is failing
  // reports old percentages with total confidence, so a silent banner reads
  // identical whether the router knew the account had headroom or merely hoped
  // so — and the operator only finds out when the agent answers "you've hit
  // your weekly limit".
  const caveat = result.usageUnverified ? ', usage unverified — no account could be refreshed' : '';
  return `[agents] ${verb} picked ${label} (${ratio}${caveat})`;
}

/**
 * Whether `cwd` is inside a git work tree.
 *
 * `--lease` / `--box` sync the working directory to the box through crabbox,
 * which enumerates the files to copy with `git ls-files`. Outside a git repo
 * that exits 128 (`fatal: not a git repository`) and the whole run dies at
 * "build sync file list: exit status 128" — AFTER the box is provisioned and
 * billed. Checking this up front lets the caller fail fast, before provisioning.
 */
export function isInsideGitWorkTree(cwd: string): boolean {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf-8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/** Absolute git toplevel for `cwd`, or null when it is not a git repo. */
export function gitToplevel(cwd: string): string | null {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Network mode for a `--lease` run (F5, RUSH-1924). `--tailscale` forces the
 * tailnet, `--no-tailscale` forces public, and neither (undefined) defaults to
 * the tailnet ONLY in a reuse context (`--reuse`, `--box`, or a picked warm
 * box) — a one-shot solo `--lease` stays public. Pure so it is unit-testable;
 * the caller downgrades to `'public'` when no auth key is configured.
 */
export function computeNetMode(opts: { tailscale?: boolean; reuseContext: boolean }): 'public' | 'tailscale' {
  if (opts.tailscale === false) return 'public'; // --no-tailscale wins
  if (opts.tailscale === true) return 'tailscale'; // explicit --tailscale
  return opts.reuseContext ? 'tailscale' : 'public';
}

// ── "Always provision fresh" per-repo memory (F3, RUSH-1922) ─────────────────
// The picker's "Always provision fresh (remember for this repo)" choice is
// persisted as a list of git-toplevel paths in a small state file, so a repo
// that opted out of the reuse picker is never prompted again.

/** True when `repoRoot` is in the remembered always-fresh set. Pure. */
export function isAlwaysFreshRepo(repos: string[], repoRoot: string): boolean {
  return repos.includes(repoRoot);
}

/** Add `repoRoot` to the always-fresh set (idempotent). Pure. */
export function addAlwaysFreshRepo(repos: string[], repoRoot: string): string[] {
  return repos.includes(repoRoot) ? repos : [...repos, repoRoot];
}

/** Path to the always-fresh state file under the USER agents dir (CLI-written per-user preference, never the maintainer-owned `.system` repo). */
export function leaseFreshReposPath(): string {
  return path.join(getUserAgentsDir(), 'lease-fresh-repos.json');
}

/** Read the remembered always-fresh repo roots (empty on any read/parse error). */
export function readAlwaysFreshRepos(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(leaseFreshReposPath(), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the always-fresh repo roots. Best-effort — never throws. */
export function writeAlwaysFreshRepos(repos: string[]): void {
  try {
    const p = leaseFreshReposPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(repos, null, 2));
  } catch {
    /* best-effort — losing the preference just means the picker shows next time */
  }
}

/**
 * Build the LoopConfig the driver consumes from CLI flags and/or a workflow's
 * `loop:` frontmatter block (issue #332). Returns undefined when neither source
 * activates a loop (the common single-shot run). CLI flags take precedence over
 * the workflow's declared values field-by-field, so `--max-iterations 5`
 * overrides a workflow's `max_iterations: 3`.
 *
 * `--loop` with no sub-options is a valid bare loop (driver applies its own
 * maxIterations safety cap). A workflow `loop:` block activates a loop even
 * without `--loop` so `agents run <workflow>` honors a declared loop.
 */
export function buildLoopConfig(
  flags: { loop?: boolean; maxIterations?: string; budget?: string; until?: string; interval?: string },
  workflowLoop?: import('../lib/workflows.js').LoopConfigRaw,
): import('../lib/loop.js').LoopConfig | undefined {
  const active = flags.loop === true || workflowLoop !== undefined;
  if (!active) return undefined;

  const cfg: import('../lib/loop.js').LoopConfig = {};

  // until: CLI > workflow. Only `signal` is supported.
  const until = flags.until ?? workflowLoop?.until;
  if (until !== undefined) {
    if (until !== 'signal') {
      throw new Error(`Invalid --until '${until}'. Only 'signal' is supported.`);
    }
    cfg.until = 'signal';
  }

  // max_iterations: CLI > workflow.
  if (flags.maxIterations !== undefined) {
    const n = Number(flags.maxIterations);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid --max-iterations '${flags.maxIterations}'. Use a positive integer.`);
    }
    cfg.maxIterations = n;
  } else if (workflowLoop?.max_iterations !== undefined) {
    cfg.maxIterations = workflowLoop.max_iterations;
  }

  // budget (tokens): CLI > workflow.
  if (flags.budget !== undefined) {
    const b = Number(flags.budget);
    if (!Number.isFinite(b) || b <= 0) {
      throw new Error(`Invalid --budget '${flags.budget}'. Use a positive token count.`);
    }
    cfg.budget = b;
  } else if (workflowLoop?.budget !== undefined) {
    cfg.budget = workflowLoop.budget;
  }

  // interval: CLI > workflow. Validate eagerly — an unparseable interval
  // (e.g. "30s", "5", "abc") must be rejected here, not silently coalesced to
  // 0ms (back-to-back) at run time. "0" is the one accepted non-duration value.
  const interval = flags.interval ?? workflowLoop?.interval;
  if (interval !== undefined) {
    try {
      parseLoopInterval(interval);
    } catch {
      throw new Error(
        `Invalid --interval '${interval}'. Use "0" for back-to-back or a duration like "30m", "1h", "2h30m" (units: w/d/h/m).`,
      );
    }
    cfg.interval = interval;
  }

  return cfg;
}

/** Map a loop stop reason to a process exit code. condition-met/max are clean exits. */
export function loopExitCode(stoppedBy: import('../lib/loop.js').LoopStoppedBy): number {
  switch (stoppedBy) {
    case 'condition-met':
    case 'max':
      return 0;
    case 'budget':
      return 7; // mirrors BUDGET_KILL_EXIT_CODE so CI can tell a budget stop apart
    case 'signal':
      return 130; // 128 + SIGINT(2)
    case 'stalled':
    case 'error':
    default:
      return 1;
  }
}

/**
 * Drive a workflow's declarative `for_each:` fan-out end-to-end (issue #343).
 *
 * Runs the producer, expands one stage teammate per produced item (respecting
 * `max_items` / `DEFAULT_FOR_EACH_CAP`, surfacing any truncation — never a
 * silent cap), stages them into a fresh team via the existing `runForEach`
 * bridge, then drives the teams supervisor until the DAG drains. When a verify
 * panel is declared, tallies each item's `keep_if` gate from the skeptics'
 * terminal status and logs which items survived.
 *
 * Reuses the teams substrate wholesale — no new orchestration engine. Returns
 * the process exit code (0 on drain, 1 on producer failure / non-drain).
 */
export async function runWorkflowForEach(
  spec: import('../lib/workflows.js').ForEachSpec,
  opts: { workflowName: string; cwd: string; effort?: ExecEffort },
): Promise<number> {
  const [{ produceItems, runForEach, tallyForEach }, { expandForEach, DEFAULT_FOR_EACH_CAP }, { AgentManager }, { createTeam }, { runSupervisor }, { ALL_AGENT_IDS }] = await Promise.all([
    import('../lib/teams/forEach.js'),
    import('../lib/workflows.js'),
    import('../lib/teams/agents.js'),
    import('../lib/teams/registry.js'),
    import('../lib/teams/supervisor.js'),
    import('../lib/agents.js'),
  ]);

  // The teams substrate spawns teammates as a real harness. When `agent:` names
  // a known harness id, honor it; otherwise fall back to claude (the workflow
  // harness) so a subagent-style name in `agent:` still runs.
  const isHarness = (a: string): boolean => (ALL_AGENT_IDS as readonly string[]).includes(a);
  const runSpec: import('../lib/workflows.js').ForEachSpec = {
    ...spec,
    agent: isHarness(spec.agent) ? spec.agent : 'claude',
    ...(spec.verify
      ? { verify: { ...spec.verify, agent: isHarness(spec.verify.agent) ? spec.verify.agent : 'claude' } }
      : {}),
  };
  if (runSpec.agent !== spec.agent) {
    process.stderr.write(chalk.gray(`[for_each] '${spec.agent}' is not a harness id — staging stage teammates as claude\n`));
  }

  // 1. Producer: run the shell command (or resolve itemsRef) into the item list.
  let items: string[];
  try {
    items = await produceItems(runSpec, { cwd: opts.cwd });
  } catch (err) {
    console.error(chalk.red(`[for_each] producer failed: ${(err as Error).message}`));
    return 1;
  }
  if (items.length === 0) {
    process.stderr.write(chalk.yellow('[for_each] producer emitted no items — nothing to fan out.\n'));
    return 0;
  }

  // 2. Cap accounting (surfaced, never silent — acceptance criterion in #343).
  const cap = runSpec.max_items ?? DEFAULT_FOR_EACH_CAP;
  const { truncated } = expandForEach(runSpec, items);
  if (truncated > 0) {
    process.stderr.write(chalk.yellow(
      `[for_each] producer emitted ${items.length} items; capping at ${cap} (${truncated} dropped). Raise \`max_items\` to fan out more.\n`,
    ));
  }
  process.stderr.write(chalk.gray(`[for_each] ${Math.min(items.length, cap)} stage teammate(s) from ${items.length} produced item(s)\n`));

  // 3. Stage the expanded teammates into a fresh team via the existing bridge.
  const team = `foreach-${opts.workflowName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
  await createTeam(team, { description: `for_each fan-out from workflow '${opts.workflowName}'` });
  const mgr = new AgentManager();
  const { teammates } = await runForEach(mgr, team, runSpec, items, {
    cwd: opts.cwd,
    effort: opts.effort,
    concurrency: runSpec.concurrency,
  });

  // 4. Drive the supervisor until the DAG drains (the same loop `teams start
  // --watch` uses; it absorbs the staged teammates via rescanFromDisk).
  const result = await runSupervisor(mgr, {
    team,
    onWave: (s) => {
      const ts = s.timestamp.slice(11, 19);
      process.stderr.write(
        `[${ts}] [for_each] wave ${s.wave}  launched=${s.launched.length}  running=${s.running}  pending=${s.pending}  done=${s.completed}  failed=${s.failed}\n`,
      );
    },
  });

  // 5. keep_if tally: a skeptic that COMPLETED is a keep vote; a failed skeptic
  // votes to drop. Gate each item and report which survived.
  if (runSpec.verify) {
    const loaded = await mgr.listByTask(team);
    const statusByName = new Map(loaded.map((a) => [a.name, a.status]));
    const verdicts = tallyForEach(teammates, (v) => statusByName.get(v.name) === 'completed');
    const kept = verdicts.filter((v) => v.kept);
    process.stderr.write(chalk.gray(
      `[for_each] keep_if=${runSpec.verify.keep_if}: kept ${kept.length}/${verdicts.length} item(s)\n`,
    ));
    for (const v of verdicts) {
      const tag = v.kept ? chalk.green('keep') : chalk.red('drop');
      process.stderr.write(chalk.gray(`  [${tag}] ${v.item} (${v.votes.filter(Boolean).length}/${v.votes.length} votes)\n`));
    }
  }

  if (result.stoppedBy === 'drained') {
    process.stderr.write(chalk.green(`[for_each] drained in ${Math.floor(result.elapsed_ms / 1000)}s (${result.waves} waves). Team: ${team}\n`));
    return 0;
  }
  process.stderr.write(chalk.yellow(`[for_each] stopped by ${result.stoppedBy} after ${result.waves} waves. Team: ${team}\n`));
  return 1;
}

/**
 * The run's working directory from `--cwd` / `--project`. `--project <slug>` owns
 * the directory and is mutually exclusive with `--cwd`/`--remote-cwd`; both the
 * main dispatch and the `--terminal` handoff need the same answer, so the rule
 * and its error live here once instead of in two places that can drift.
 *
 * A project that binds several directories also contributes the ones it is not
 * landing in as `--add-dir` grants, so an agent on a multi-repo project can
 * actually reach the sibling checkouts. Claude / Cursor / Kimi take the native
 * flag; Codex folds them into workspace_roots; Grok widens its sandbox profile
 * (and always injects a rules note). Other harnesses have no multi-root surface
 * and ignore the grants (cwd only).
 */
async function resolveRunCwd(
  options: Pick<ExecCommandActionOptions, 'cwd' | 'project' | 'remoteCwd' | 'addDir'>,
  opts: { forRemote: boolean },
): Promise<string | undefined> {
  if (!options.project) return options.cwd;
  if (options.cwd || options.remoteCwd) {
    console.error(chalk.red('Pass --project alone — not with --cwd or --remote-cwd.'));
    process.exit(1);
  }
  const { resolveProjectDirs } = await import('../lib/project-root.js');
  try {
    const { cwd, extraDirs } = await resolveProjectDirs(options.project, {
      forRemote: opts.forRemote,
    });
    // Explicit --add-dir values keep their position; a directory the project
    // already contributes is not passed twice.
    if (extraDirs.length > 0) {
      const seen = new Set(options.addDir ?? []);
      options.addDir = [...(options.addDir ?? []), ...extraDirs.filter((d) => !seen.has(d))];
    }
    return cwd;
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exit(1);
  }
}

/**
 * `--terminal`: hand this run to a real terminal tab and exit.
 *
 * The terminal is detected from the user's live sessions, so a run started from
 * a surface that cannot host a TUI (the menu bar's "New Session", a script) lands
 * in the terminal they actually work in instead of a hardcoded Terminal.app.
 * Exits non-zero when no terminal could be opened — the caller must not believe
 * a session started when none did.
 */
async function handleTerminalHandoff(
  agentSpec: string,
  options: ExecCommandActionOptions,
  prompt: string | undefined,
): Promise<void> {
  const { parseTerminalFlag, openRunInTerminal, toHostSamples, currentContext } = await import('../lib/terminal/index.js');

  const parsed = parseTerminalFlag(options.terminal);
  if (parsed.error) {
    console.error(chalk.red(parsed.error));
    process.exit(1);
  }

  // Reject an unrunnable target HERE, where the person can read it. The tab would
  // otherwise open, print the same error, and close — the failure lands in a
  // window that is gone before it can be read, which reads as "nothing happened".
  //
  // `agents run <thing>` takes an agent id, a PROFILE, or a WORKFLOW (see the
  // isValidAgent / profileExists / resolveWorkflowRef chain below), so this must
  // accept all three. Gating on the agent table alone rejected every profile —
  // the whole Kimi/DeepSeek/Qwen/GLM path — for `--terminal` runs only.
  const rawTarget = parseRunAccountPickerRequest(agentSpec).normalizedAgentSpec.split('#')[0].split('@')[0];
  const knownAgent = resolveAgentName(rawTarget);
  const [{ profileExists }, { resolveWorkflowRef }] = await Promise.all([
    import('../lib/profiles.js'),
    import('../lib/workflows.js'),
  ]);
  const hasProfile = profileExists(rawTarget);
  if (knownAgent && !hasProfile && isAgentHardDeprecated(knownAgent)) {
    console.error(chalk.red(hardDeprecationError(knownAgent)));
    process.exit(1);
  }
  if (!knownAgent) {
    const probeCwd = options.cwd ?? process.cwd();
    if (!hasProfile && !resolveWorkflowRef(rawTarget, probeCwd)) {
      console.error(chalk.red(
        `Unknown agent, profile, or workflow: ${rawTarget}. See \`agents view\` for the installed harnesses.`,
      ));
      process.exit(1);
    }
  }
  // --device and its aliases (--on/--computer) all mean "dispatch this
  // run to another machine over SSH", which is incompatible with opening a
  // terminal tab on THIS machine — so reject the whole alias family, not just
  // the canonical flag. The rule and its wording live once, in the --device
  // forwarding table, so the classification a reviewer reads and the error a
  // user sees can't drift.
  if (hostTargetGiven(options).length) {
    const { RUN_OPTION_REJECT_MESSAGES } = await import('../lib/hosts/remote-cmd.js');
    console.error(chalk.red(RUN_OPTION_REJECT_MESSAGES.terminal));
    process.exit(1);
  }
  // Machine-readable output would land in the tab, where the caller that asked
  // for it can never read it. Same class of failure as --device: refuse, don't
  // hand back a stream that goes nowhere.
  const streamFlag = options.json ? '--json' : options.emitSessionId ? '--emit-session-id' : undefined;
  if (streamFlag) {
    console.error(chalk.red(
      `${streamFlag} streams to stdout, but --terminal moves the run into a tab where you cannot read it. Drop one.`,
    ));
    process.exit(1);
  }

  // `--project` owns the working directory, but the main action resolves it far
  // below this handoff — so without this the tab would open in THIS process's
  // cwd (launchd's `/` for a menu-bar click) while the run inside it moved to
  // the project. `forRemote: false` because --terminal is always local (--device
  // is rejected above).
  const cwd = await resolveRunCwd(options, { forRemote: false });

  const { getActiveSessions } = await import('../lib/session/active.js');
  let sessions: Awaited<ReturnType<typeof toHostSamples>> = [];
  try {
    sessions = await toHostSamples(await getActiveSessions());
  } catch {
    // Detection is best-effort — an unreadable session index must not block the
    // launch; resolution falls through to the available-backend floor.
  }

  const result = await openRunInTerminal({
    argv: process.argv.slice(2),
    forced: parsed.backend,
    consumedValue: typeof options.terminal === 'string' ? options.terminal : undefined,
    cwd: cwd ?? process.cwd(),
    sessions,
    ctx: currentContext(),
  });

  if (!result.ok) {
    console.error(chalk.red(`Could not open a terminal: ${result.error ?? 'unknown error'}`));
    process.exit(1);
  }
  if (!options.quiet) {
    const what = prompt === undefined ? 'session' : 'run';
    console.log(chalk.gray(`Opened the ${what} in ${result.description}.`));
  }
}

/** Register the `agents run <agent> [prompt]` command. */
export function registerRunCommand(program: Command): void {
  const runCmd = program
    .command('run [agent] [prompt]')
    .description('Execute an agent. Pass a prompt for headless runs; omit it to launch the agent interactively. With --broadcast, run the same prompt/task across an agent × model matrix.')
    .option('-m, --mode <mode>', 'How much the agent can do: plan (read-only), edit (can write files), auto (more autonomous than edit, mechanism per-harness: smart classifier auto-approves safe ops and still prompts for risky ones on Claude/Copilot; approval_policy=never over the edit sandbox on Codex, which never prompts), skip (bypass all permission prompts). Omitted Codex mode defaults to safe writable edit; other harnesses default to plan. \'full\' accepted as alias for skip.', 'plan')
    .option('-e, --effort <effort>', 'Reasoning effort: low | medium | high | xhigh | max | auto (claude and codex only)', 'auto')
    .option('--model <model>', 'Cost tier (cheap|default|best|ultra) or a concrete model id; tiers resolve per harness+version to a supported model')
    .option(
      '--env <key=value>',
      'Pass environment variable to the agent (repeatable, e.g., --env DEBUG=1 --env API_KEY=xyz)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option(
      '--secrets <bundle>',
      'Inject a secrets bundle (repeatable). Values resolve from macOS Keychain at run time. See `agents secrets`.',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option(
      '--no-auto-secrets',
      'Skip auto-injection of secrets declared by a workflow\'s frontmatter `secrets:` field. Has no effect on bare-agent runs.',
    )
    .option(
      '--secrets-keys <keys>',
      'Inject only this comma-separated subset of keys from --secrets bundles (e.g. KEY1,KEY2). Missing keys are an error. Applies to all --secrets bundles on this run.',
    )
    .option('--allow-expired', 'Inject secrets even if their expiry date has passed (overrides the pre-run expiry abort).')
    .option('--cwd <dir>', 'Working directory for the agent (defaults to current directory). With --device, the directory ON the device.')
    .option(
      '-P, --project <ref>',
      'Project shorthand <slug>[@worktree], resolved against your projects root (auto-inferred, cached). Sets the cwd locally or on --device.',
    )
    .option(
      '--add-dir <dir>',
      'Grant access to an additional directory outside the project (Claude, Codex, Cursor, Kimi, Grok; repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      []
    )
    .option('--json', 'Stream events as JSON lines (for parsing by other tools)')
    .option('--quiet', 'Suppress preamble (rotation banner, "Running:" line). Useful when piping JSON events to a parser.', false)
    .option('--headless', 'Force headless mode. Auto-enabled when a prompt is provided; pass explicitly to stay headless with no prompt (reads the prompt from stdin).', false)
    .option('--no-auth-check', 'Skip the pre-launch "looks logged out" warning on an interactive run (advisory; never blocks anyway). Also silenced by AGENTS_NO_AUTH_CHECK=1.')
    .option('-i, --interactive', 'Force interactive mode even when a prompt is provided. Mutually exclusive with --headless.')
    .option('--broadcast', 'Run the same prompt or --task across multiple agents (comma-separated [agent]) × --model cells. Replaces the former `agents bench` group.')
    .option('--task <id>', 'With --broadcast: house benchmark task id under cli/bench/tasks/')
    .option('--list-tasks', 'With --broadcast: list available broadcast task ids')
    .option('--results [run-id]', 'With --broadcast: show one saved matrix run, or list saved runs newest first')
    .option('--concurrency <n>', 'With --broadcast: maximum cells running at once', '3')
    .option('--resume [id]', 'Recover a previous conversation on its origin device. The exact healthy origin uses native resume; otherwise a healthy version of the same harness replays via /continue. Pair with a prompt to continue headlessly.')
    .option('--session-id <id>', 'Force a NEW conversation to use this exact session UUID (Claude only). This CREATES a session — to resume an existing one, use --resume.', parseExplicitSessionId)
    .option('--name <slug>', 'Name the run — seeds the session label so it shows up as `<name>` in `agents sessions` and resolves by it (and `agents hosts logs <name>` for --device runs) instead of an opaque id. An agent-generated title later refines the label; your name shows until then. Optional.')
    .option('--notify', 'Post a desktop notification when a headless run finishes. Fired by this process on exit, so it survives whatever launched the run (the menu bar dispatching it, a terminal you closed).')
    .option('--no-trace-sync', 'Skip the run-exit trace auto-sync for this run. Auto-sync fires by default only for local runs and only once you have run `agents traces sync` at least once (also silenced by AGENTS_NO_TRACE_SYNC=1).')
    .option(
      '--terminal [backend]',
      "Open this run in a real terminal tab instead of here. Without a value the terminal is detected from your live sessions (`agents sessions --active` host), so it lands where you already work — Ghostty for a Ghostty user, iTerm for an iTerm user. Name one to force it: iterm | ghostty | terminal | tmux | vscodium-agent. This is how the menu bar's New Session opens.",
    )
    .option('--verbose', 'Show detailed execution logs')
    .option('--raw', 'Keep this interactive run direct when the device has opted into tmux wrapping. A no-op under the default tmux-off configuration; equivalent to AGENTS_NO_TMUX=1.')
    .option('--no-tmux', 'Keep this run direct when tmux wrapping is enabled for the device. Same effect as --raw / AGENTS_NO_TMUX=1; it is a no-op under the default tmux-off configuration.')
    .option('--disable-tmux', 'Compatibility alias for --no-tmux; a no-op when tmux wrapping is already off.')
    .option('--timeout <duration>', 'Kill the agent after this duration (e.g., 30m, 1h, 2h30m)')
    .option(
      '--fallback <agents>',
      'Comma-separated agents to try on rate-limit failure. Each entry accepts an optional @version pin (e.g., codex@0.116.0,antigravity). The primary runs first; if it exits with a rate-limit error, the next agent picks up via /continue handoff.',
    )
    .option(
      '-b, --balanced',
      'Shortcut for --strategy balanced. Ignored when @version is pinned.',
    )
    .option(
      '--strategy <strategy>',
      'Version/account selection strategy: pinned | available | balanced. Defaults to run.<agent>.strategy, then balanced (spreads load across healthy accounts and skips any that are rate-limited). (Legacy `rotate` accepted as alias for `balanced`.)',
    )
    .option('--account <label>', 'Use this labeled native login or durable provider credential for the run')
    .option(
      '--acp',
      'Route through the Agent Client Protocol instead of direct exec. Supported for claude via @zed-industries/claude-code-acp adapter. Unified event stream; emits ndjson when --json.',
    )
    .option(
      '-y, --yes',
      'Skip the interactive budget-confirm prompt (require_confirm_over). Never skips a hard budget block.',
      false,
    )
    .option(
      '--loop',
      'Re-inject the prompt/entrypoint each iteration until a stop condition (issue #332). Guards (--max-iterations, --budget, --until) are enforced outside the agent. Writes a checkpoint after every iteration for --resume-checkpoint.',
    )
    .option(
      '--resume-checkpoint <file>',
      'Resume a killed loop run from its checkpoint.json. Continues from the last completed iteration, reusing the same runId, session id, prompt, and loop config.',
    )
    .option(
      '--max-iterations <n>',
      'Loop hard cap: stop after N iterations (stoppedBy: max). Loop only.',
    )
    .option(
      '--budget <tokens>',
      'Loop token hard-cap: stop once cumulative tokens reach this (stoppedBy: budget), enforced outside the agent. Loop only.',
    )
    .option(
      '--until <signal>',
      'Loop stop condition. `signal` reads <runDir>/loop-signal.json {continue,reason} each iteration; absent or continue:false stops (fail-closed). Loop only.',
    )
    .option(
      '--interval <dur>',
      'Loop delay between iterations ("0" back-to-back, "30m" paces). Loop only.',
    )
    .option(
      '--where <spec>',
      'Where this run\'s body executes (one placement door): local | device:<name> | auto | lease[:backend] | cloud[:provider]. Expands to --device/--lease/--cloud. Do not combine with those flags. See docs/00-concepts.md#placement.',
    )
    .option(
      '-D, --device <name>',
      'Offload this run onto another machine over SSH — a registered device, or user@host. Pass "auto" to pick the least-loaded reachable device where the requested agent is installed and signed in, keeping the run local when no remote is better, or "interactive" for the machine pinned as interactive.host (the box a human is sitting at). Same as --where device:<name>. See `agents devices`.',
    )
    .option('--remote-cwd <dir>', "Explicit device working directory for --device runs, used VERBATIM (overrides --cwd; usually --cwd suffices — it re-roots a local-home path onto the remote home). Pass a single-quoted '$HOME/…' or a valid remote absolute path; a local ~ expands here and won't exist there (/Users/you vs /home/you).")
    .option('--no-follow', 'With --device, dispatch detached and return immediately (track via `agents hosts ps/logs`).')
    .option('--any', 'With --device <cap> (a capability tag), pick any matching device instead of erroring when several match.')
    .option(
      '--copy-creds',
      'Deprecated refusal: native OAuth/session credentials cannot be copied between devices. Use `agents accounts sync <account> --device <device>` for a portable provider credential.',
    )
    .option(
      '--lease [backend]',
      "Run on a cloud box (via crabbox) and tear it down after — reuses a warm box from the repo's profile pool when one is ready (--fresh forces a new box). Optional backend selects the cloud (hetzner/aws/do). Same as --where lease[:backend]. Unlike --device, no machine is registered.",
    )
    .option(
      '--box <slug>',
      'Reuse an existing warm crabbox box for this run instead of provisioning a disposable --lease box.',
    )
    .option('--keep-box', 'With --lease, keep the box after the run instead of stopping it.')
    .option(
      '--fresh',
      "With --lease, always provision a brand-new box (skip the warm profile-pool reuse) and tear it down after the run.",
    )
    .option(
      '--reuse',
      'With --lease, reuse the most-recently-used warm box if one exists (else provision fresh). The scriptable form of the interactive reuse picker.',
    )
    .option('--bare', 'With --lease, skip copying your local ~/.agents setup (skills/hooks/commands/MCP) onto the box.')
    .option('--tailscale', 'Lease the box onto your tailnet (reachable only over Tailscale) rather than a public IP.')
    .option('--no-tailscale', 'Force a public-IP lease even when a reuse context would default to Tailscale.')
    .option(
      '--cloud',
      'Vendor cloud placement: dispatch to the agent\'s native cloud (claude→rush, codex→codex, cursor→cursor, droid→factory, antigravity→antigravity) and stream the result. Same dispatch as `agents cloud run --agent <agent>`; tracked by `agents cloud list/status/logs`. Same as --where cloud. Mutually exclusive with --device/--lease and local-run flags.',
    )
    .option('--provider <id>', 'With --cloud: override the agent\'s native cloud provider (rush | codex | cursor | factory | antigravity | host).')
    .option(
      '--repo <owner/repo>',
      'With --cloud: GitHub repository. Repeatable for multi-repo dispatch (Rush Cloud only).',
      (val: string, prev: string[]) => [...prev, val],
      [],
    )
    .option('--branch <name>', 'With --cloud: target git branch.')
    .option('--cloud-env <id>', 'With --cloud: Codex Cloud environment ID (run\'s --env is the KEY=VAL passthrough, so the cloud env id gets its own flag).');

  // `--on` and `--computer` are hidden aliases of `--device` — same behavior.
  runCmd.addOption(new Option('--on <name>', 'Alias of --device.').hideHelp());
  runCmd.addOption(new Option('--computer <name>', 'Alias of --device.').hideHelp());
  // Deprecated one-release alias: `agents run … --smart` → treat as `--device auto`.
  runCmd.addOption(
    new Option('--smart', 'Deprecated: use --device auto (affinity host pick).').hideHelp(),
  );

  // Internal: the `--device` dispatch forwards this so the REMOTE run prints its
  // resolved session id as a one-line stdout sentinel (hosts/session-marker.ts),
  // letting the launcher relate the remote-created session back to itself for
  // every agent — not just Claude, whose id it forces up front.
  runCmd.addOption(new Option('--emit-session-id', 'internal: print the resolved session id for a --device launcher to capture').hideHelp());

  // Required for the documented `agents run <agent> [prompt] -- <native flags>`
  // passthrough: commander >=13 rejects excess operands by default, so any
  // post-`--` token died with "too many arguments" before the action ran. The
  // action re-derives the `--` boundary from rawArgs and still errors on excess
  // operands that are NOT behind `--`.
  runCmd.allowExcessArguments(true);

  setHelpSections(runCmd, {
    examples: `
      # Headless, read-only: investigate or summarize without writing files
      agents run claude "summarize recent git commits" --mode plan

      # Headless, can edit: have the agent make changes
      agents run claude "fix lint errors in src/" --mode edit

      # Interactive (TUI) with the pinned default version
      agents run claude

      # Pick a signed-in account/version for only this run
      agents run claude@

      # Full-auto: affinity-pick the host, then the harness with the most
      # account headroom, then a balanced account on it
      agents run auto "fix the flaky test" --mode edit
agents run auto --device yosemite-s0 "fix the flaky test"   # pin the device
      agents run auto --interactive --device auto --strategy balanced --mode auto

      # Placement (one door — where the body runs). Old flags still work.
      agents run claude "…" --where device:yosemite-s0   # = --device yosemite-s0
      agents run claude "…" --where auto                 # = --device auto
      agents run claude "fix CI" --where lease --mode edit

      # Vendor cloud placement — the agent's own cloud runs the task and
      # agents cloud list/status/logs tracks it. Fire-and-forget: --no-follow
      agents run claude "fix the flaky e2e" --cloud --repo acme/example
      agents run codex "add parser tests" --cloud --cloud-env env_a1b2c3
      agents run droid "QA the onboarding flow" --cloud --no-follow
      agents run claude "…" --where cloud          # same as --cloud

      # Open the session in a terminal tab — detected from where your sessions
      # already run (Ghostty / iTerm / Terminal.app); force one with a value
      agents run claude --terminal
      agents run claude --terminal ghostty

      # Pipe JSON events to a parser (--quiet drops the preamble)
      agents run claude "..." --json --quiet | jq

      # Bounded run — kill the agent after 30 minutes
      agents run claude "generate sales report for yesterday" --mode plan --timeout 30m

      # Inject a keychain-backed secrets bundle
      agents run claude "deploy the worker" --secrets prod --mode edit

      # Run on a cloud box — reuses a warm box from the repo's profile pool when
      # one is ready (kept after the run), else leases a fresh box, torn down after
      agents run claude "fix the failing tests" --lease

      # Force a brand-new box (destroyed after), or target a warm box by slug
      agents run claude "fix the failing tests" --lease --fresh
      agents run claude "fix the failing tests" --box warm-one

      # Broadcast one prompt (or --task) across agents × models
      agents run --broadcast claude,codex "say hello" --model cheap,default
      agents run --broadcast --task hello-repo --model cheap
      agents run --broadcast --list-tasks
      agents run --broadcast --results --json

      # Pass arbitrary native flags to the underlying CLI via -- separator
      agents run kimi -- --plan --some-kimi-option value
      agents run claude "fix the bug" -- --custom-flag
    `,
    notes: `
      Modes (not every agent supports every mode — run \`agents modes <agent>\`):
        plan  read-only investigation; no writes, no shell side-effects
        edit  may edit files; prompts for shell / risky operations
        auto  more autonomous than edit; the mechanism is per-harness --
              claude, copilot: smart classifier auto-approves safe ops and
                     STILL PROMPTS for risky ones
              codex: approval_policy=never over the edit sandbox; never
                     prompts at all, and a denied command fails instead
        skip  bypass every permission prompt (dangerously-skip-permissions)
        Legacy 'full' is silently rewritten to 'skip'.
        List per-harness support + native flags: agents modes · agents modes claude
        Models (cheap|default|best|ultra): agents models <agent[@version]>

      Headless plan support (a prompt makes the run headless):
        plan works headless on claude, codex, cursor, droid, opencode.
        kimi, grok, antigravity have no headless plan mode — a headless
        --mode plan auto-downgrades to --mode auto (with a stderr warning).
        Interactive plan (omit the prompt) works everywhere it is listed.

      Run strategy (set via --strategy or run.<agent>.strategy in agents.yaml):
        pinned     use the workspace/global pinned version; if that version is logged out on this device, pick a signed-in sibling instead of dying (an explicit @version pin is unchanged)
        available  use pinned if it can run right now; otherwise switch to another signed-in version
        balanced   distribute load across healthy accounts by remaining capacity (default)
        A version/account is skipped when it is rate-limited right now — any usage window (incl. the 5-hour session window) at 100%, matching the 'agents view' badge.
        --balanced is shorthand for --strategy balanced. Ignored when @version is pinned, when a profile is used, or with --fallback.
        Zero healthy accounts under balanced/available (or a logged-out pinned default with no signed-in sibling) exits nonzero naming each
        excluded account and the earliest window reset — use --strategy pinned to force a rate-limited default; a logged-out default is never forced.

      'auto' harness (agents run auto): picks the host (14d usage affinity,
      unless --device is given), the harness (installed CLIs weighted by
      best-account headroom), and the account (the strategy above). Zero
      healthy accounts on any harness exits nonzero with the earliest reset.

      Account picker: append @ with no version (agents run claude@) to choose one
        installed account for this run. Rows show identity, login state, plan,
        and available limits; unsafe accounts stay visible but disabled.

      Fallback: --fallback codex,antigravity retries on rate-limit failure via /continue handoff. Each entry accepts @version.

      Cloud placement: --cloud sends the run to the agent's native vendor cloud
        (claude→rush, codex→codex, droid→factory, antigravity→antigravity) — the
        same dispatch as agents cloud run --agent <agent>, tracked by agents
        cloud list/status/logs/cancel/message. --provider overrides the routing;
        --repo/--branch/--cloud-env refine the task. Agents without a native
        cloud (kimi, grok, cursor, opencode, …) fail loud unless --provider is
        given. --cloud is mutually exclusive with --device/--lease and with
        local-run flags (--loop, --resume, --secrets, --terminal, …).

      Resume: --resume <id> resolves full IDs locally first, then fleet-wide, and recovers on the source device with its cwd/mode. The exact healthy origin version uses native resume; otherwise a healthy version of the same harness replays via /continue. agents sessions resume <id> infers the harness too.

      Passthrough: everything after -- is forwarded verbatim to the underlying agent CLI.
        agents run kimi -- --plan --some-native-flag value
    `,
  });

  runCmd.action(async (agentSpec: string | undefined, prompt: string | undefined, options: ExecCommandActionOptions, command: Command) => {
      bootMark('run-action:enter');
      // Capture everything after -- as passthrough args forwarded verbatim to the
      // underlying CLI. Commander strips the literal `--` and folds what follows
      // into the positional operands (so `agents run codex -- --yolo` would parse
      // `--yolo` as the PROMPT) — recover the boundary from rawArgs instead of
      // operand counts. Excess operands not behind `--` are still an error (an
      // unquoted prompt must not silently become agent flags).
      const rawArgs: string[] = process.argv;
      const separatorIdx = rawArgs.indexOf('--');
      const passthroughArgs = separatorIdx === -1 ? [] : rawArgs.slice(separatorIdx + 1);
      const operandsBeforeSeparator = command.args.length - passthroughArgs.length;
      if (operandsBeforeSeparator > 2) {
        console.error(chalk.red(
          `Too many arguments for 'run'. Quote the prompt ("fix the bug"), and put agent-native flags after -- (agents run codex -- --yolo).`,
        ));
        process.exit(1);
      }
      if (prompt !== undefined && operandsBeforeSeparator < 2) {
        // The token commander assigned to [prompt] came from behind `--` — it is
        // a native flag, not a prompt. Run interactively.
        prompt = undefined;
      }

      // Broadcast matrix (formerly `agents bench`): list/results/run cells, then exit.
      // --broadcast is local-only fan-out — it is mutually exclusive with --host/--device.
      if (options.broadcast || options.listTasks || options.results !== undefined) {
        const whereIsRemote =
          typeof options.where === 'string' && options.where.trim().toLowerCase() !== 'local';
        if (hostTargetGiven(options).length > 0 || whereIsRemote) {
          console.error(chalk.red('--broadcast is local-only and cannot be combined with --host/--device/--where.'));
          process.exit(1);
        }
        try {
          await handleBroadcast({
            listTasks: options.listTasks === true,
            results: options.results,
            task: options.task,
            model: options.model,
            concurrency: options.concurrency,
            json: options.json,
            agentsCsv: agentSpec,
            prompt,
            requireRun: options.broadcast === true && !options.listTasks && options.results === undefined,
          });
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
        return;
      }

      if (!agentSpec) {
        console.error(chalk.red("Missing required argument 'agent'. Example: agents run claude \"hello\"."));
        process.exit(1);
      }

      // --cloud: vendor cloud placement. Validate BEFORE the terminal handoff
      // and every local dispatch path — flags like --terminal/--loop/--resume
      // belong to the local runner and must error, never ride along silently.
      if (options.cloud || (typeof options.where === 'string' && /^cloud(:|$)/i.test(options.where.trim()))) {
        const { runCloudConflicts } = await import('./run-cloud.js');
        const conflicts = runCloudConflicts(options as unknown as Record<string, unknown>);
        if (conflicts.length > 0) {
          console.error(chalk.red(
            `--cloud is a vendor cloud placement; these only apply to local/machine runs: ${conflicts.join(', ')}. Drop them, or drop --cloud.`,
          ));
          process.exit(1);
        }
      }

      // --terminal: this process can't host the TUI (a menu-bar click, a script),
      // so hand the run to a real terminal and exit. Resolved from the user's own
      // live sessions, so it opens where they already work. Done before every
      // other dispatch path because the tab re-runs this same argv without the
      // flag — arming --notify or picking a version here would happen twice.
      if (options.terminal) {
        await handleTerminalHandoff(agentSpec, options, prompt);
        return;
      }

      // Placement: --where expands into --device / --lease / --cloud before any
      // dispatch. One door for "where does the body run?" — old flags remain
      // aliases. See lib/placement.ts and docs/concepts.md#placement.
      {
        const { placementFromRunFlags, expandPlacementToRunFlags, PlacementError } =
          await import('../lib/placement.js');
        try {
          const placement = placementFromRunFlags(options);
          if (options.where) {
            const expanded = expandPlacementToRunFlags(placement);
            if (expanded.host !== undefined) options.host = expanded.host;
            if (expanded.device !== undefined) options.device = expanded.device;
            if (expanded.lease !== undefined) options.lease = expanded.lease;
            if (expanded.box !== undefined) options.box = expanded.box;
            if (expanded.cloud !== undefined) options.cloud = expanded.cloud;
            if (expanded.provider !== undefined) options.provider = expanded.provider;
            // Clear the where flag so remote re-entry (host dispatch) does not
            // re-expand and conflict with the concrete host we just set.
            options.where = undefined;
          }
        } catch (err) {
          if (err instanceof PlacementError) {
            console.error(chalk.red(err.message));
            process.exit(1);
          }
          throw err;
        }
      }

      // Cloud refinement flags without the placement are a typo, not a no-op.
      if (!options.cloud) {
        const { cloudFlagsWithoutCloud } = await import('./run-cloud.js');
        const stray = cloudFlagsWithoutCloud(options as unknown as Record<string, unknown>);
        if (stray.length > 0) {
          console.error(chalk.red(`${stray.join(', ')} ${stray.length > 1 ? 'require' : 'requires'} --cloud (vendor cloud placement).`));
          process.exit(1);
        }
      }

      // --cloud: dispatch through the cloud provider registry and return — the
      // run never touches the local/host/lease paths below.
      if (options.cloud) {
        const { handleRunCloud } = await import('./run-cloud.js');
        await handleRunCloud(agentSpec, prompt, options as unknown as Record<string, unknown>, command);
        return;
      }

      // --notify: post a desktop notification when this run finishes. Armed on
      // process exit so it covers EVERY dispatch path below (local, --device,
      // --lease, the error path) instead of one branch. Only for headless runs
      // — an interactive run ends in front of the person who started it.
      if (options.notify && prompt !== undefined) {
        const { armRunFinishNotification } = await import('../lib/run-notify.js');
        armRunFinishNotification({
          agent: agentSpec,
          name: options.name,
          prompt,
          cwd: options.cwd ?? process.cwd(),
          host: options.host,
        });
      }

      // A trailing @ is an explicit request to choose one installed account.
      // Strip only that terminal marker; concrete agent@version pins retain
      // their existing meaning in every dispatch path below.
      const accountPicker = parseRunAccountPickerRequest(agentSpec);
      const accountPickerRequested = accountPicker.requested;
      let normalizedAgentSpec = accountPicker.normalizedAgentSpec;
      if (!accountPicker.valid) {
        console.error(chalk.red(`Invalid account picker target: ${agentSpec}. Use agents run <agent>@.`));
        process.exit(1);
      }
      // Peel `#name` off before --device dispatch so the selector rides the hop
      // unchanged and the peer resolves ITS slot (PHNX-3940 T5). The later local
      // parse is idempotent when the values match.
      {
        const labelParts = normalizedAgentSpec.split('#');
        if (labelParts.length > 2 || labelParts[1] === '') {
          console.error(chalk.red(`Invalid account label in '${normalizedAgentSpec}'.`));
          process.exit(1);
        }
        const specAccountLabel = labelParts[1];
        if (specAccountLabel && options.account && specAccountLabel !== options.account) {
          console.error(chalk.red(`Account '${specAccountLabel}' from the agent spec conflicts with --account '${options.account}'.`));
          process.exit(1);
        }
        if (specAccountLabel) options.account = specAccountLabel;
      }

      // Hard-deprecated harnesses cannot be run — point the user at the successor.
      const runBaseAgentName = normalizedAgentSpec.split('#')[0].split('@')[0];
      const runBaseAgentId = resolveAgentName(runBaseAgentName);
      const { profileExists: runProfileExists } = await import('../lib/profiles.js');
      if (runBaseAgentId && !runProfileExists(runBaseAgentName) && isAgentHardDeprecated(runBaseAgentId)) {
        console.error(chalk.red(hardDeprecationError(runBaseAgentId)));
        process.exit(1);
      }

      // Account-picker conflict check runs BEFORE device=auto may set balanced,
      // so an implicit balanced preference never surfaces as a fake
      // "cannot be combined with --balanced" when the user only typed trailing @.
      if (accountPickerRequested) {
        const conflicts = runAccountPickerConflicts(options);
        if (conflicts.length > 0) {
          console.error(chalk.red(
            `Account selection with ${agentSpec} cannot be combined with ${conflicts.join(', ')}. ` +
            'Remove the conflicting selector, or use an explicit agent@version target.',
          ));
          process.exit(1);
        }
      }

      // `agents run auto`: the reserved harness keyword — full-auto dispatch
      // (host affinity → cross-harness balance → account balance, RUSH-2132).
      if (normalizedAgentSpec.split('#')[0].split('@')[0] === RUN_AUTO_KEYWORD && normalizedAgentSpec !== RUN_AUTO_KEYWORD) {
        console.error(chalk.red(
          `agents run auto picks the harness itself — a @version pin does not apply. ` +
          `Pin a concrete harness instead: agents run <harness>@<version>.`,
        ));
        process.exit(1);
      }
      let autoHarnessRequested = normalizedAgentSpec === RUN_AUTO_KEYWORD;
      let resolvedResumeSource: import('../lib/session/types.js').SessionMeta | undefined;
      let resolvedRecoveryTarget: import('../lib/session/recovery.js').SessionRecoveryTarget | undefined;

      // Concrete resume ids resolve BEFORE placement. Full UUIDs take the local
      // SQLite fast path; only a local miss fans out to the fleet. This lets a
      // command entered on zion discover that the owning version-home is on a
      // worker, while a command entered on that worker never pays for SSH.
      if (typeof options.resume === 'string' && options.resume.trim()) {
        const selector = options.resume.trim();
        const injectedSource = (() => {
          try {
            const parsed = JSON.parse(process.env.AGENTS_RESUME_SOURCE_JSON ?? 'null');
            return parsed?.id === selector ? parsed as import('../lib/session/types.js').SessionMeta : undefined;
          } catch {
            return undefined;
          }
        })();
        delete process.env.AGENTS_RESUME_SOURCE_JSON;
        const outcome = injectedSource
          ? { kind: 'resolved' as const, session: injectedSource }
          : await (await import('./sessions.js')).resolveSessionMetadataValue(selector);
        if (outcome.kind === 'partial') {
          // RUSH-2492: an unreachable peer is a warning, not a hard failure. The
          // resolver already resolves an id found on the reachable fleet (SES-9a),
          // so reaching here means the session was not found on any device we
          // COULD reach — it may live on an unreachable peer we could not check.
          const offline = outcome.failedPeers;
          console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
          console.error(chalk.red(`No session matching "${selector}" on any reachable device (${offline.length} unreachable, not checked).`));
          console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
          process.exit(1);
        }
        if (outcome.kind === 'not-found') {
          console.error(chalk.red(`No session matching "${selector}".`));
          process.exit(1);
        }
        if (outcome.kind === 'ambiguous') {
          console.error(chalk.red(`"${selector}" matches ${outcome.candidates.length} sessions. Pass the full session id.`));
          process.exit(1);
        }
        resolvedResumeSource = outcome.session;

        const [requestedAgent, requestedVersion] = normalizedAgentSpec.split('#')[0].split('@');
        if (!autoHarnessRequested && requestedAgent !== resolvedResumeSource.agent) {
          console.error(chalk.red(
            `Session ${resolvedResumeSource.shortId} belongs to ${resolvedResumeSource.agent}, not ${requestedAgent}. ` +
            `Use: agents sessions resume ${resolvedResumeSource.id}`,
          ));
          process.exit(1);
        }
        if (!autoHarnessRequested && requestedVersion && requestedVersion !== resolvedResumeSource.version) {
          console.error(chalk.red(
            `Session ${resolvedResumeSource.shortId} started with ${resolvedResumeSource.agent}@${resolvedResumeSource.version ?? 'unknown'}, ` +
            `not @${requestedVersion}.`,
          ));
          process.exit(1);
        }

        // Omitted --mode inherits the effective source mode. Commander keeps
        // the normal new-run default as a real value, so consult its provenance
        // rather than mistaking the default for an explicit override.
        if (command.getOptionValueSource('mode') === 'default') {
          if (resolvedResumeSource.mode) {
            options.mode = resolvedResumeSource.mode;
            command.setOptionValueWithSource('mode', resolvedResumeSource.mode, 'implied');
          }
          else if (!options.quiet) process.stderr.write(chalk.yellow(
            `[agents] session ${resolvedResumeSource.shortId} predates stored launch modes; using --mode ${options.mode}\n`,
          ));
        }

        const { machineId } = await import('../lib/machine-id.js');
        const {
          sessionRecoveryDestinationMatches,
          sessionRecoveryPeer,
        } = await import('../lib/session/recovery.js');
        const sourceMachine = resolvedResumeSource.machine;
        const sourcePeer = sessionRecoveryPeer(resolvedResumeSource);
        const explicitPlacement = hostTargetGiven(options).length > 0;
        if (sourcePeer && !explicitPlacement) {
          options.host = sourcePeer;
        } else if (sourcePeer && explicitPlacement && !hostTargetGiven(options).some((host) =>
          sessionRecoveryDestinationMatches(resolvedResumeSource!, host))) {
          console.error(chalk.red(
            `Session ${resolvedResumeSource.shortId} must recover on ${sourcePeer}, where its indexed transcript and version history are owned; ` +
            `the requested device was ${hostTargetGiven(options).join(', ')}.`,
          ));
          process.exit(1);
        }

        // Recovery is resolved on the device that owns the transcript. A remote
        // dispatch is pinned to the source HARNESS (not `run auto`'s cross-harness
        // picker); the peer repeats this block with the injected SessionMeta and
        // chooses its own healthy version. Locally, resolve it now.
        const sourceAgent = resolvedResumeSource.agent as AgentId;
        if (!sourcePeer) {
          try {
            const { resolveSessionRecovery } = await import('../lib/session/recovery.js');
            resolvedRecoveryTarget = await resolveSessionRecovery(resolvedResumeSource);
          } catch (err) {
            console.error(chalk.red((err as Error).message));
            process.exit(1);
          }
          normalizedAgentSpec = `${resolvedRecoveryTarget.agent}@${resolvedRecoveryTarget.version}`;
          autoHarnessRequested = false;
          if (!options.quiet) process.stderr.write(chalk.gray(
            `[agents] session recovery → ${resolvedRecoveryTarget.mode} ${normalizedAgentSpec} on ${sourceMachine ?? machineId()} · ${resolvedRecoveryTarget.reason}\n`,
          ));
        } else if (autoHarnessRequested) {
          normalizedAgentSpec = sourceAgent;
          autoHarnessRequested = false;
        }
      }
      if (autoHarnessRequested) {
        // `auto` is reserved. If a future harness registers that id, the
        // keyword collides — fail loud rather than silently shadow the harness.
        if (RUN_AUTO_KEYWORD in AGENTS) {
          console.error(chalk.red(
            `'${RUN_AUTO_KEYWORD}' is now a registered harness and collides with the reserved 'run auto' keyword. ` +
            `Run the harness by name instead.`,
          ));
          process.exit(1);
        }
        if (accountPickerRequested) {
          console.error(chalk.red(
            `agents run auto picks the harness and account itself — the trailing-@ account picker needs a concrete harness (agents run <harness>@).`,
          ));
          process.exit(1);
        }
        // Host layer: with no explicit --device, default to the
        // affinity pick. Skipped on a device-dispatched run — its dispatcher
        // already resolved this layer (see runAutoDefaultsToAffinity).
        if (!resolvedResumeSource && runAutoDefaultsToAffinity(options)) options.device = 'auto';
      }

      // --device auto (and deprecated --smart): live fleet pick.
      // Harness is always the agent the user typed — never auto-picked.
      // Placement failure propagates; an automatic request never becomes local.
      {
        const { applyDeviceAutoToOptions } = await import('../lib/smart-launch.js');
        const result = await applyDeviceAutoToOptions(options, {
          accountPickerRequested,
          // `run auto` selects its harness after placement, so do not filter
          // candidates against an arbitrary proxy harness at this stage.
          agent: normalizedAgentSpec.split('#')[0].split('@')[0] === RUN_AUTO_KEYWORD
            ? undefined
            : (resolveAgentName(normalizedAgentSpec.split('#')[0].split('@')[0]) ?? undefined),
        });
        if (!options.quiet && result.deprecationSmart) {
          process.stderr.write(
            chalk.yellow('[agents] --smart is deprecated; use --device auto\n'),
          );
        }
        if (!options.quiet && result.banner) {
          const { hostLabel, deviceHint, acctNote } = result.banner;
          process.stderr.write(
            chalk.gray(
              `[agents] device=auto → ${hostLabel}` +
                (deviceHint ? ` (load ${deviceHint})` : '') +
                ` · ${acctNote}\n`,
            ),
          );
        }
      }

      // --lease: invent a disposable cloud box for this run (via crabbox), run
      // the agent there, then tear it down. --box: reuse a named warm crabbox
      // box, run the same bootstrap there, and leave the box running.
      if (options.lease || options.box) {
        if (prompt === undefined) {
          console.error(chalk.red(`A prompt is required for crabbox runs: agents run <agent> "<task>" ${options.box ? '--box <slug>' : '--lease'}`));
          process.exit(1);
        }
        if (options.lease && options.box) {
          console.error(chalk.red('Pass either --lease to provision a disposable box, or --box <slug> to reuse a warm box — not both.'));
          process.exit(1);
        }
        if (options.fresh && options.box) {
          console.error(chalk.red('--fresh forces a brand-new box; it cannot be combined with --box <slug> (which reuses one).'));
          process.exit(1);
        }
        if (options.fresh && options.reuse) {
          console.error(chalk.red('--fresh forces a brand-new box; it cannot be combined with --reuse.'));
          process.exit(1);
        }
        const backend = typeof options.lease === 'string' ? options.lease : undefined;

        // crabbox syncs this directory to the box via `git ls-files`; outside a
        // git repo that fails with "build sync file list: exit status 128" — but
        // only AFTER the box is provisioned and billed. Fail fast here instead.
        const leaseCwd = options.cwd ?? process.cwd();
        if (!isInsideGitWorkTree(leaseCwd)) {
          console.error(
            chalk.red(
              `${options.box ? '--box' : '--lease'} syncs the working directory to the box, but ${leaseCwd} is not a git repository.`,
            ),
          );
          console.error(chalk.yellow(`Run from inside a git repo, or initialize one: (cd ${leaseCwd} && git init)`));
          process.exit(1);
        }

        // First-run: no provider credential resolves (no env var, no config, no
        // detectable bundle) → guide the user through one-time setup, then continue.
        const { resolveLeaseBundle } = await import('../lib/crabbox/cli.js');
        if (options.lease && !resolveLeaseBundle()) {
          const { runLeaseSetup } = await import('./lease.js');
          const ok = await runLeaseSetup({ provider: backend ?? 'hetzner' });
          if (!ok) {
            console.error(chalk.yellow('Leasing needs a cloud provider set up. Run `agents devices lease setup` and retry.'));
            process.exit(1);
          }
        }

        // ── F3 reuse (RUSH-1922) + F5 net-mode (RUSH-1924) ───────────────────
        // Resolve which box this run targets and how it is networked BEFORE any
        // provisioning. `--box` is an explicit reuse; otherwise, on an
        // interactive tty, offer the warm boxes as a reuse picker. Headless runs
        // never block: leaseAndRun itself is reuse-first against the profile
        // pool (a ready pool box is reused; none ready → warm a fresh one).
        // `--fresh` opts out of every reuse path.
        const leaseSecretsBundle = process.env.AGENTS_LEASE_SECRETS_BUNDLE;
        const nowSecs = Math.floor(Date.now() / 1000);
        let reuseSlug: string | undefined = options.box;

        // Lease runs share one default warm pool across repositories. The generic
        // `.crabbox.yaml profile:` remains available to repo sandbox/CI scripts;
        // `leaseProfile:` is the explicit opt-in for a dedicated lease hot box.
        const repoRoot = gitToplevel(leaseCwd);
        const { readCrabboxLeaseProfile } = await import('../lib/crabbox/config.js');
        const poolProfile = repoRoot ? readCrabboxLeaseProfile(repoRoot) : 'default';

        if (options.lease && !reuseSlug && !options.fresh) {
          const { crabboxList, poolReusableBoxes } = await import('../lib/crabbox/cli.js');
          const { formatBoxRow } = await import('./lease.js');
          let warm: CrabboxBox[] = [];
          try {
            warm = poolReusableBoxes(crabboxList({ secretsBundle: leaseSecretsBundle }), {
              profile: poolProfile,
              nowSecs,
            });
          } catch {
            warm = []; // crabbox unavailable / no creds → the pool check in leaseAndRun decides
          }

          const alwaysFresh = repoRoot ? isAlwaysFreshRepo(readAlwaysFreshRepos(), repoRoot) : false;

          if (warm.length > 0 && !alwaysFresh) {
            if (options.reuse) {
              reuseSlug = warm[0].slug; // scriptable: most-recently-touched warm box
            } else if (isInteractiveTerminal() && options.json !== true) {
              const { select } = await import('@inquirer/prompts');
              try {
                const choice = await select({
                  message: 'Reuse a warm box, or provision a fresh one?',
                  choices: [
                    ...warm.map((b) => ({ name: formatBoxRow(b, nowSecs), value: b.slug })),
                    { name: 'Provision a fresh box', value: '__fresh__' },
                    { name: 'Always provision fresh (remember for this repo)', value: '__always_fresh__' },
                  ],
                });
                if (choice === '__always_fresh__') {
                  if (repoRoot) {
                    writeAlwaysFreshRepos(addAlwaysFreshRepo(readAlwaysFreshRepos(), repoRoot));
                    console.error(chalk.dim(`Will always provision fresh for ${repoRoot} (edit ${leaseFreshReposPath()} to undo).`));
                  }
                } else if (choice !== '__fresh__') {
                  reuseSlug = choice;
                }
              } catch (e) {
                if (!isPromptCancelled(e)) throw e;
                console.error(chalk.yellow('Selection cancelled — provisioning a fresh box.'));
              }
            }
            // Headless with no --reuse falls through here → leaseAndRun's
            // profile-pool check decides (reuse a ready pool box, else warm fresh).
          } else if (options.reuse && warm.length > 0) {
            // --reuse still honors a warm box even when the picker is suppressed.
            reuseSlug = warm[0].slug;
          }
        }

        // reuseContext: an existing box (picked, --box, or --reuse) defaults the
        // network to the tailnet; a solo one-shot --lease stays public.
        const reuseContext = !!reuseSlug || !!options.reuse;
        let netMode = computeNetMode({ tailscale: options.tailscale, reuseContext });
        const copySetup = !options.bare;

        // Tailscale requested but no auth key configured → downgrade to public
        // with an actionable hint instead of hard-failing the run (F5).
        if (netMode === 'tailscale') {
          const { pickTailscaleBundleFromList } = await import('../lib/crabbox/cli.js');
          const { listBundles } = await import('../lib/secrets-client.js');
          let hasKey = !!process.env.CRABBOX_TAILSCALE_AUTH_KEY;
          if (!hasKey) {
            try {
              hasKey = !!pickTailscaleBundleFromList(await listBundles());
            } catch {
              hasKey = false;
            }
          }
          if (!hasKey) {
            console.error(chalk.yellow('Tailscale requested but no auth key is configured — falling back to a public-IP lease.'));
            console.error(chalk.gray('Set one up with `agents devices lease setup` (mint an EPHEMERAL, pre-authorized, tag:crabbox key), or store CRABBOX_TAILSCALE_AUTH_KEY in a secrets bundle.'));
            netMode = 'public';
          }
        }

        const { assertNoNativeOAuthTransfer, detectSignedInRuntimes, inferLeaseRuntime, profileNeedsBaseRuntimeCredentials } = await import('../lib/crabbox/runtimes.js');
        const { leaseAndRun, leaseWorkspaceId } = await import('../lib/crabbox/lease.js');
        const { boxAddress } = await import('./lease.js');
        const { getConfiguredRunStrategy, resolveRunVersion } = await import('../lib/accounting/rotate.js');
        const { profileExists, readProfile, resolveProfileEnv } = await import('../lib/profiles.js');

        const detected = await detectSignedInRuntimes();
        const [agentName, rawLeaseVersion] = normalizedAgentSpec.split('#')[0].split('@');
        let runtime: AgentId | null = null;
        let credentialRuntimes: AgentId[] = [];
        let dispatchProfile: import('../lib/crabbox/lease.js').LeaseDispatchProfile | undefined;

        // `--lease` requires a prompt (guarded above), so it is headless by
        // contract — never block on an interactive picker. Provision exactly the
        // one runtime this run needs, inferred from the agent, not every
        // signed-in CLI (which would ship unrelated tokens to a throwaway box).
        if (profileExists(agentName)) {
          try {
            const profile = readProfile(agentName);
            const profileEnv = resolveProfileEnv(profile);
            runtime = profile.host.agent;
            const profileNeedsCredentials = profileNeedsBaseRuntimeCredentials(runtime, profileEnv, profile.auth?.envVar);
            credentialRuntimes = profileNeedsCredentials ? [runtime] : [];
            dispatchProfile = {
              name: profile.name,
              agent: profile.host.agent,
              version: rawLeaseVersion || profile.host.version,
              env: profileEnv,
              description: profile.description,
              preset: profile.preset,
              provider: profile.provider,
              fallbackModel: profile.fallback_model,
            };
          } catch (err) {
            console.error(chalk.red((err as Error).message));
            process.exit(1);
          }
        } else {
          runtime = inferLeaseRuntime(agentName, detected);
          if (runtime) credentialRuntimes = [runtime];
        }
        if (!runtime) {
          console.error(chalk.yellow('No signed-in runtime to provision on the box. Sign into one locally (e.g. run `claude` once) then retry.'));
          process.exit(1);
        }
        const runtimes = [runtime];
        if (credentialRuntimes.length > 0 && !detected.some((d) => d.id === runtime && d.signedIn && d.credPath)) {
          console.error(chalk.yellow(`Profile '${agentName}' needs ${runtime} credentials, but ${runtime} is not signed in locally. Sign in locally, then retry.`));
          process.exit(1);
        }
        // Refuse before account selection, OAuth reads, box lookup, or lease
        // provisioning. A provider-backed profile has no credentialRuntimes and
        // proceeds with its portable provider environment instead.
        assertNoNativeOAuthTransfer(credentialRuntimes, detected);

        // Headless-by-contract: don't prompt, but print exactly what ships and
        // where — copying an auth token to a cloud box is a credential transfer.
        // The box is destroyed after the run, so the credential's lifetime is
        // bounded by the run.
        const whatShips = dispatchProfile
          ? `profile '${dispatchProfile.name}'`
          : `${runtime} runtime setup`;
        const boxLifecycle = reuseSlug
          ? `Reusing crabbox box ${reuseSlug}`
          : options.fresh
            ? `Leasing a fresh ${backend ?? 'hetzner'} box${netMode === 'tailscale' ? ' on your tailnet' : ''}`
            : `Leasing a ${backend ?? 'hetzner'} box${netMode === 'tailscale' ? ' on your tailnet' : ''} (a ready box from the '${poolProfile ?? 'default'}' pool is reused when one exists)`;
        const boxAfterRun = reuseSlug
          ? 'the box is kept after the run'
          : options.keepBox
            ? 'the box is kept after the run'
            : options.fresh
              ? 'the box is destroyed after the run'
              : 'the shared-pool box is kept after the run';
        console.error(
          chalk.gray(
            `${boxLifecycle} · shipping ${whatShips}; ${boxAfterRun}.`,
          ),
        );

        const claudeCredentialsJson: null = null;

        // Progress UI (F2, RUSH-1921). A self-throttled spinner (NOT ora — see
        // progress.ts) covers provisioning; the box-side bootstrap then streams a
        // structured step stream (sync → install → runtime → creds → …) via the
        // router's `onStep`, and each step renders as a checklist line through the
        // lib's `renderStepLine` (✔ <Step> — <detail> (<elapsed>)). The agent's own
        // output prints verbatim after the box-side marker. Rule: only ONE spinner
        // phase is active at a time, so it can never storm.
        const { createLeaseOutputRouter, createSpinner, renderStepLine } = await import('../lib/crabbox/progress.js');
        const spinner = createSpinner({ stream: process.stderr });
        let warmupTimer: ReturnType<typeof setInterval> | undefined;
        const stopTimer = () => { if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = undefined; } };

        const jsonMode = options.json === true;
        const stepsTty = Boolean(process.stderr.isTTY) && !jsonMode;
        // The step currently in flight (its label spins on a TTY). It is persisted
        // as a ✔ line when the NEXT step arrives (whose elapsedMs measures how long
        // THIS step's block took) — or, for the last step, when agent output or
        // teardown begins.
        let activeStep: import('../lib/crabbox/progress.js').LeaseStep | null = null;
        const flushStep = (elapsedMs?: number) => {
          if (!activeStep) return;
          const done = activeStep;
          activeStep = null;
          if (jsonMode) {
            process.stdout.write(JSON.stringify({ phase: 'setup', name: done.name, elapsedMs: elapsedMs ?? null }) + '\n');
          } else {
            spinner.stopAndPersist('✔', renderStepLine({ ...done, elapsedMs }));
          }
        };
        const router = createLeaseOutputRouter({
          now: () => Date.now(),
          // Raw setup lines stay captured for a failure dump (router.setupLines());
          // the structured step stream drives the visible checklist, so plain lines
          // are not shown (they would fight the step spinner).
          onSetupLine: () => {},
          onStep: (step) => {
            flushStep(step.elapsedMs); // persist the previous step, timed by this one
            activeStep = step;
            if (stepsTty) spinner.start(renderStepLine(step));
          },
          onAgentChunk: (chunk) => {
            flushStep(); // last setup step done (no following sentinel to time it)
            if (spinner.active) spinner.stop();
            process.stdout.write(chunk);
          },
        });

        try {
          const { exitCode, box, toreDown } = await leaseAndRun({
            agent: agentName,
            prompt,
            mode: options.mode,
            model: options.model,
            backend,
            runtimes,
            credentialRuntimes,
            detected,
            dispatchProfile,
            claudeCredentialsJson,
            secretsBundle: leaseSecretsBundle,
            keep: options.keepBox,
            reuseBox: reuseSlug,
            fresh: options.fresh,
            profile: poolProfile,
            workspaceId: leaseWorkspaceId(repoRoot ?? leaseCwd),
            copySetup,
            netMode,
            onData: (chunk) => router.push(chunk),
            onPhase: (phase) => {
              if (phase.kind === 'warmup') {
                const label = `Leasing a ${phase.backend ?? 'hetzner'} box${netMode === 'tailscale' ? ' (tailnet)' : ''}`;
                spinner.start(`${label}…`);
                const t0 = Date.now();
                warmupTimer = setInterval(() => spinner.update(`${label}… (${Math.round((Date.now() - t0) / 1000)}s)`), 1000);
              } else if (phase.kind === 'reuse') {
                spinner.start(`Reusing crabbox box ${phase.slug}…`);
              } else if (phase.kind === 'ready') {
                stopTimer();
                const addr = boxAddress(phase.box);
                // Steps drive the spinner from here — no generic "Setting up box…".
                spinner.stopAndPersist('✔', `Box ${phase.box.slug} ready${addr ? ` (${addr})` : ''} · ${Math.round(phase.elapsedMs / 1000)}s`);
              } else if (phase.kind === 'teardown') {
                flushStep();
                if (spinner.active) spinner.stop();
              }
            },
          });
          router.end();
          flushStep();
          stopTimer();
          if (spinner.active) spinner.stop();
          // Safety net: if setup failed before the agent ever ran, the setup log
          // was only shown as transient spinner text — surface it so the error is
          // diagnosable.
          if (exitCode !== 0 && !router.sawAgent()) {
            const log = router.setupLines();
            if (log.length) process.stderr.write(chalk.dim(log.join('\n')) + '\n');
          }
          const keptAddr = boxAddress(box);
          console.error(chalk.gray(toreDown ? `Box ${box.slug} destroyed.` : `Box ${box.slug} kept${keptAddr ? ` (${keptAddr})` : ''}. Stop it: agents devices lease stop ${box.slug}`));
          process.exit(exitCode === null ? 1 : exitCode);
        } catch (err) {
          stopTimer();
          flushStep();
          if (spinner.active) spinner.stopAndPersist('✖', chalk.red('Lease failed'));
          const log = router.setupLines();
          if (log.length && !router.sawAgent()) process.stderr.write(chalk.dim(log.join('\n')) + '\n');
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // --device/--on/--computer: offload this run onto a registered agent host
      // over SSH instead of running locally. The three flags are aliases.
      const hostGiven = hostTargetGiven(options);

      // Auto-sync this run's redacted trajectory when it exits, so the console is
      // never stale and a session link/QR resolves the moment the run finishes
      // (PHNX-3628). Armed HERE — after hostGiven is finalized — so every
      // remote-placement signal is already reflected in options: --device/--on/
      // --computer and --where device: (expanded to options.host above), AND the
      // --resume-to-peer redirect that sets options.host during resume
      // resolution. A run that will dispatch remotely (hostGiven non-empty, or
      // --lease/--box) has its trajectory on that box and never arms a local
      // sync; --cloud returned earlier. The module additionally gates on opt-in
      // (signed in + already synced once) and is best-effort.
      if (
        prompt !== undefined &&
        hostGiven.length === 0 &&
        !options.lease &&
        !options.box
      ) {
        const { armRunFinishTraceSync } = await import('../lib/run-trace-sync.js');
        armRunFinishTraceSync({ disabled: options.traceSync === false });
      }

      // --project <slug>[@worktree]: resolve the projects-root shorthand into a
      // cwd. On a host run it resolves home-relative (`~/…`, so the host expands
      // it); locally it becomes an absolute path. It owns the working directory,
      // so it is mutually exclusive with both --cwd and --remote-cwd.
      if (options.project) {
        options.cwd = await resolveRunCwd(options, { forRemote: hostGiven.length > 0 });
      }

      if (hostGiven.length > 0) {
        if (new Set(hostGiven).size > 1) {
          console.error(chalk.red('Conflicting --device values values — pass just one.'));
          process.exit(1);
        }
        const hostName = hostGiven[0];
        // Note: a `run auto` dispatch needs no marker forwarded from here — the
        // dispatch layer (hosts/dispatch.ts remoteRunShellPrelude) exports the
        // chain-hop guard into the remote shell for BOTH interactive and
        // headless paths, keyed off the agent name being `auto`.
        const { resolveHostRunTarget, resolveHostSessionId, dispatchPromptToHost, HostResolutionError } = await import('../lib/hosts/run-target.js');
        const { runInteractiveOnHost } = await import('../lib/hosts/dispatch.js');
        const { registerInteractiveHostSession } = await import('../lib/hosts/session-index.js');
        const { RUN_OPTION_REJECT_MESSAGES } = await import('../lib/hosts/remote-cmd.js');
        const { normalizeRunStrategy, RUN_STRATEGIES } = await import('../lib/accounting/rotate.js');

        // The forwarding contract (RUN_OPTION_FORWARDING): options that cannot
        // cross the SSH boundary fail loud BEFORE dispatch — never a silent
        // drop. Value-aware: only reject what was actually passed.
        const hostRejects: string[] = [];
        if (options.secrets.length > 0) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.secrets);
        if (options.secretsKeys) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.secretsKeys);
        if (options.allowExpired) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.allowExpired);
        if (options.resumeCheckpoint) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.resumeCheckpoint);
        if (options.resume === true) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.resumeBare);
        if (hostRejects.length > 0) {
          for (const msg of hostRejects) console.error(chalk.red(msg));
          process.exit(1);
        }
        if (options.copyCreds) {
          console.error(chalk.red(
            'Refusing --copy-creds: native OAuth/session credentials are device-local and cannot be copied. ' +
            'Create a portable provider account and run `agents accounts sync <account> --device <device>` instead.',
          ));
          process.exit(1);
          return;
        }
        // Shared resolution (name → capability tag → error). A password-auth
        // device throws DeviceOffloadUnsupportedError inside the helper and
        // propagates untouched — it's printed cleanly by the top-level catch in
        // index.ts (covers every resolveHost caller).
        let host;
        try {
          host = await resolveHostRunTarget(hostName, { any: options.any });
        } catch (e) {
          if (e instanceof HostResolutionError) {
            console.error(chalk.red(e.message));
            process.exit(1);
          }
          throw e;
        }
        try {
          const [runAgent, rawRunVersion] = normalizedAgentSpec.split('#')[0].split('@');
          // Forward the explicit @version pin verbatim. Resolving aliases like
          // @latest locally would check local installs, but the remote host may
          // have versions the laptop does not. The remote agents CLI resolves
          // aliases against its own installed versions.
          const runVersion = rawRunVersion || undefined;

          // Normalize the effective strategy exactly like the local path so we
          // fail fast on invalid input and can forward --balanced/--strategy.
          const explicitStrategy = options.strategy ? normalizeRunStrategy(options.strategy) : null;
          if (options.strategy && !explicitStrategy) {
            console.error(chalk.red(`Invalid strategy: ${options.strategy}. Use ${RUN_STRATEGIES.join(', ')}.`));
            process.exit(1);
          }
          if (options.balanced && explicitStrategy && explicitStrategy !== 'balanced') {
            console.error(chalk.red('--balanced conflicts with --strategy. Use one strategy override.'));
            process.exit(1);
          }
          const runStrategy = options.balanced ? 'balanced' : explicitStrategy ?? undefined;

          // Working directory on the host: an explicit --remote-cwd is used
          // verbatim; --cwd/--project are made portable (a local-home absolute
          // becomes `~/…` so the remote shell re-roots it at ITS home).
          //
          // With neither flag, mirror the LOCAL cwd's home-relative path onto
          // the host (deriveMirroredCwd). Otherwise every host run starts in the
          // remote `$HOME` — launch an agent from a repo and it opens with no
          // project, and you `cd` by hand every time. The same checkout at the
          // same home-relative path on both boxes is the normal fleet layout, so
          // the mirror usually hits; when the host lacks that directory the run
          // falls back to the remote home rather than failing.
          const { toRemotePortable } = await import('../lib/project-root.js');
          const { deriveMirroredCwd } = await import('../lib/hosts/dispatch.js');
          const explicitHostCwd = options.remoteCwd ?? (options.cwd ? toRemotePortable(options.cwd) : undefined);
          const hostCwd = explicitHostCwd ?? deriveMirroredCwd(process.cwd());
          const mirrorHostCwd = explicitHostCwd === undefined;
          const hostAddDirs = options.addDir.length > 0 ? options.addDir.map(toRemotePortable) : undefined;
          // `--resume [id]`: commander yields the string id, or `true` when the
          // flag is passed bare. A bare resume needs the interactive picker,
          // which can't run over a detached remote dispatch — only forward a
          // concrete id.
          const resumeId = typeof options.resume === 'string' ? options.resume : undefined;

          let hostCopyCreds: undefined;

          // Decide whether this host run is interactive. No prompt always means
          // interactive (matching local resolveInteractive); --interactive forces
          // interactive even when a prompt is provided; --headless forces headless
          // and therefore requires a prompt.
          if (options.interactive && options.headless) {
            console.error(chalk.red('--interactive and --headless are mutually exclusive. Pass one, or neither (mode is inferred from prompt presence).'));
            process.exit(1);
          }
          const interactiveHost = options.interactive === true || (prompt === undefined && options.headless !== true);

          if (accountPickerRequested && !interactiveHost) {
            console.error(chalk.red(
              `Account selection with ${agentSpec} requires an interactive host run. ` +
              `Use agents run ${runAgent}@ --device ${host.name} --interactive.`,
            ));
            process.exit(1);
          }

          if (interactiveHost) {
            // Interactive host run: forward the local TTY over SSH and let the
            // remote agent start its normal interactive UI (tmux on the host).
            if (options.follow === false) {
              console.error(chalk.red('--no-follow is not compatible with interactive host runs. Interactive runs are attached by definition.'));
              process.exit(1);
            }
            // Mirror the local path (lib/exec.ts): only Claude accepts a forced
            // `--session-id`. Adopt the caller's id when present; otherwise mint
            // one here. Registering that same id keeps the local index aligned
            // with the remote agent. On resume, don't mint a new one.
            const hostSessionId = resolveHostSessionId(runAgent, resumeId, options.sessionId);
            // For every OTHER agent the remote coins its own id, which we can't
            // know up front. Forward a launch id we control as AGENT_LAUNCH_ID:
            // the remote `agents run` adopts it (exec.ts resolveLaunchId) and its
            // SessionStart hook records the real id under that exact key, so after
            // the stream we resolve the id by one ssh read of the remote hook
            // record — the same launch-id join used locally (RUSH-2034). Not
            // needed for Claude (id forced) or resume (id already known).
            // `run auto` ALWAYS joins: the remote picks the harness, so an
            // explicit --session-id is only adopted by a claude pick.
            const correlationLaunchId =
              hostInteractiveNeedsCorrelationId(runAgent, hostSessionId, resumeId) ? randomUUID() : undefined;
            const hostEnv = correlationLaunchId
              ? [...options.env, `AGENT_LAUNCH_ID=${correlationLaunchId}`]
              : options.env;
            // `run auto` never pre-registers: the explicit id is only real when
            // the remote pick lands on claude. The launch-id join below records
            // the id the remote ACTUALLY used, whatever the pick.
            if (hostSessionId && runAgent !== RUN_AUTO_KEYWORD) {
              registerInteractiveHostSession({
                cwd: process.cwd(),
                host: host.name,
                agent: runAgent,
                sessionId: hostSessionId,
                name: options.name,
              });
            }
            const isRaw = options.raw || options.tmux === false || options.disableTmux === true;
            const { modeForRemoteDispatch } = await import('../lib/codex-policy.js');
            const forwardedMode = modeForRemoteDispatch(options.mode, command.getOptionValueSource('mode'));
            if (process.env.AGENTS_DISPATCH_DEBUG || options.verbose) {
              process.stderr.write(chalk.gray(
                `[hosts] dispatch interactive ${runAgent}${runVersion ? `@${runVersion}` : ''} -> ${host.name}\n`,
              ));
            }
            {
              const { connectionStartedNotice, startConnectionTarget } = await import('../lib/hosts/reconnect.js');
              const startTarget = startConnectionTarget({
                agent: runAgent,
                hostSessionId,
                resumeId,
              });
              if (startTarget) {
                const started = connectionStartedNotice(startTarget, host.name);
                if (started) process.stderr.write(chalk.gray(started));
              }
            }
            const exitCode = await runInteractiveOnHost(host, {
              agent: runAgent,
              version: resumeId ? undefined : runVersion,
              accountPicker: accountPickerRequested,
              strategy: resumeId ? undefined : runStrategy,
              account: resumeId ? undefined : options.account,
              fallback: options.fallback,
              prompt,
              mode: forwardedMode,
              model: options.model,
              effort: options.effort,
              env: hostEnv,
              addDir: hostAddDirs,
              json: options.json,
              verbose: options.verbose,
              timeout: options.timeout,
              yes: options.yes,
              acp: options.acp,
              remoteCwd: hostCwd,
              mirrorCwd: mirrorHostCwd,
              sessionId: hostSessionId,
              name: options.name,
              resume: resumeId,
              passthroughArgs,
              raw: isRaw,
              forceInteractive: options.interactive,
              copyCreds: hostCopyCreds,
            });
            // Resolve a non-Claude agent's REAL remote session id now the run has
            // booted (its hook has fired on the peer): one ssh read of the remote
            // hook record, keyed by the launch id we forwarded. Register it so the
            // run shows in `agents sessions` and can be reconnected/focused —
            // closing the non-Claude gap RUSH-2033 left. Best-effort: an
            // unreachable host or a not-yet-landed record leaves the run un-mapped
            // rather than mis-mapped.
            let resolvedRemoteId: string | undefined;
            if (correlationLaunchId) {
              const { resolveRemoteSessionId } = await import('../lib/hosts/remote-session-id.js');
              const { sshTargetFor } = await import('../lib/hosts/types.js');
              try {
                resolvedRemoteId = resolveRemoteSessionId(sshTargetFor(host), correlationLaunchId);
              } catch {
                /* ssh read is best-effort — keep the run un-mapped, never guess */
              }
              if (resolvedRemoteId) {
                registerInteractiveHostSession({
                  cwd: process.cwd(),
                  host: host.name,
                  agent: runAgent,
                  sessionId: resolvedRemoteId,
                  name: options.name,
                });
              }
            }
            // A network drop kills the local ssh client (exit 255). What the
            // remote agent does next depends on the peer's tmux.enabled
            // (PHNX-3316): wrapped, it survives in its detached pane and the
            // reconnect rejoins it; bare (the default), the drop SIGHUPs it and
            // the reconnect resumes the session in place from disk. Either way,
            // with a known session id (Claude's forced id, a resumed run, or a
            // non-Claude id we just resolved from the remote hook record) we
            // reconnect automatically instead of exiting — the user never has
            // to notice the drop and `agents sessions focus` by hand.
            // `raw` runs opted out of all of this, so there is nothing to
            // reconnect to. For `run auto` prefer the join-resolved id (the
            // harness the remote ACTUALLY picked) over the explicit
            // --session-id only claude adopts.
            const { pickReconnectTarget, reconnectInteractiveSession, afterInteractiveRemoteExit, SSH_CONN_FAILURE } = await import('../lib/hosts/reconnect.js');
            const reconnectTarget = pickReconnectTarget({
              agent: runAgent,
              sessionId: hostSessionId,
              resolvedId: resolvedRemoteId,
              resumeId,
              launchId: correlationLaunchId,
            });
            // Raw is not tmux-wrapped, so it never auto-reconnects — but it
            // still prints the session id (EXEC-55). Bundling the notice
            // behind `!isRaw` left a dropped `--raw` tab as a bare shell.
            const next = afterInteractiveRemoteExit({
              target: reconnectTarget,
              host: host.name,
              exitCode,
              willReconnect: exitCode === SSH_CONN_FAILURE && !isRaw,
            });
            if (next.reconnect && reconnectTarget) {
              process.exit(
                await reconnectInteractiveSession({
                  host,
                  target: reconnectTarget,
                  initialExit: exitCode,
                }),
              );
            }
            if (next.notice) process.stderr.write(next.notice);
            process.exit(exitCode);
          }

          // Headless host run: launch detached, tail the remote log, and follow
          // until the remote process exits.
          if (prompt === undefined) {
            console.error(chalk.red('A prompt is required for headless host runs: agents run <agent> "<task>" --device <name>'));
            process.exit(1);
          }
          // Session-id mint, detached dispatch, and local session-index
          // registration all live in the shared helper (lib/hosts/run-target.ts).
          const { modeForRemoteDispatch } = await import('../lib/codex-policy.js');
          const forwardedMode = modeForRemoteDispatch(options.mode, command.getOptionValueSource('mode'));
          if (process.env.AGENTS_DISPATCH_DEBUG || options.verbose) {
            process.stderr.write(chalk.gray(
              `[hosts] dispatch headless ${runAgent}${runVersion ? `@${runVersion}` : ''} -> ${host.name}\n`,
            ));
          }
          const { task, exitCode } = await dispatchPromptToHost(host, {
            agent: runAgent,
            version: resumeId ? undefined : runVersion,
            strategy: resumeId ? undefined : runStrategy,
            account: resumeId ? undefined : options.account,
            fallback: options.fallback,
            prompt,
            mode: forwardedMode,
            model: options.model,
            effort: options.effort,
            env: options.env,
            addDir: hostAddDirs,
            timeout: options.timeout,
            loop: options.loop,
            maxIterations: options.maxIterations,
            budget: options.budget,
            until: options.until,
            interval: options.interval,
            json: options.json,
            verbose: options.verbose,
            yes: options.yes,
            acp: options.acp,
            autoSecrets: options.autoSecrets,
            remoteCwd: hostCwd,
            mirrorCwd: mirrorHostCwd,
            name: options.name,
            resume: resumeId,
            sessionId: options.sessionId,
            follow: options.follow !== false,
            passthroughArgs,
            copyCreds: hostCopyCreds,
          });
          if (options.follow === false) {
            // The handle the caller uses to check on the run: the name if given,
            // else the real host-task id (never the old literal `<id>`). Steer
            // to the compact `agents sessions` digest over the raw log first.
            const handle = task.name ?? task.id;
            console.log(
              chalk.green(`Dispatched to ${host.name}${task.name ? ` as "${task.name}"` : ''}.`) + '\n' +
              chalk.gray(`  Status:  agents sessions ${handle}`) + chalk.gray('   (compact digest — use this)') + '\n' +
              chalk.gray(`  Raw log: agents logs ${handle} -f`) + chalk.gray('   (heavy, only if needed)'),
            );
            process.exit(0);
          }
          // -1 = the follow window closed but the run continues on the host (the
          // reattach hint is already printed). That's a detach, not a failure —
          // exit 0. Any real remote code passes through.
          if (exitCode === -1) process.exit(0);
          process.exit(exitCode ?? 1);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // --resume-checkpoint short-circuits normal dispatch entirely: the
      // checkpoint already carries the agent, version, prompt, session id,
      // iteration, and loop config of the killed run. Reconstruct ExecOptions
      // straight from it and continue the loop from the last completed
      // iteration, reusing the SAME runId/runDir (issue #332).
      if (options.resumeCheckpoint) {
        const { readCheckpoint } = await import('../lib/checkpoint.js');
        const { runLoop } = await import('../lib/loop.js');
        const { getRunsDir } = await import('../lib/state.js');
        const cp = readCheckpoint(options.resumeCheckpoint);
        if (!cp) {
          console.error(chalk.red(`Checkpoint not found or unreadable: ${options.resumeCheckpoint}`));
          process.exit(1);
        }
        const runDir = path.join(getRunsDir(), cp.id);
        fs.mkdirSync(runDir, { recursive: true });
        const resumeExec: ExecOptions = {
          agent: cp.agent,
          version: cp.version,
          prompt: cp.prompt,
          mode: options.mode,
          effort: options.effort,
          cwd: options.cwd,
          sessionId: cp.sessionId,
          json: true,
          headless: true,
        };
        // Resume honors the checkpoint's loop config, but lets the resume
        // command RAISE the bounds field-by-field — `--max-iterations 4` on a
        // checkpoint capped at 2 is the natural "continue, run more" gesture.
        // Flags override; unspecified fields fall through from the checkpoint.
        const resumeLoop = { ...cp.loop };
        if (options.maxIterations !== undefined) {
          const n = Number(options.maxIterations);
          if (!Number.isInteger(n) || n <= 0) {
            console.error(chalk.red(`Invalid --max-iterations '${options.maxIterations}'. Use a positive integer.`));
            process.exit(1);
          }
          resumeLoop.maxIterations = n;
        }
        if (options.budget !== undefined) {
          const b = Number(options.budget);
          if (!Number.isFinite(b) || b <= 0) {
            console.error(chalk.red(`Invalid --budget '${options.budget}'. Use a positive token count.`));
            process.exit(1);
          }
          resumeLoop.budget = b;
        }
        if (options.interval !== undefined) {
          try {
            parseLoopInterval(options.interval);
          } catch {
            console.error(chalk.red(`Invalid --interval '${options.interval}'. Use "0" for back-to-back or a duration like "30m", "1h", "2h30m" (units: w/d/h/m).`));
            process.exit(1);
          }
          resumeLoop.interval = options.interval;
        }
        if (options.until !== undefined) {
          if (options.until !== 'signal') {
            console.error(chalk.red(`Invalid --until '${options.until}'. Only 'signal' is supported.`));
            process.exit(1);
          }
          resumeLoop.until = 'signal';
        }
        process.stderr.write(chalk.gray(`[loop] resuming ${cp.agent} run ${cp.id} from iteration ${cp.iteration + 1} (session ${(cp.sessionId ?? '').slice(0, 8)})\n`));
        const result = await runLoop(resumeExec, resumeLoop, {
          runId: cp.id,
          runDir,
          agent: cp.agent,
          version: cp.version,
          startIteration: cp.iteration + 1,
          startTokens: cp.cumulativeTokens ?? 0,
          sessionId: cp.sessionId,
        });
        process.stderr.write(chalk.gray(`[loop] stopped: ${result.stoppedBy} after ${result.iterations} iteration(s), ${result.tokens} tokens\n`));
        // Governance chokepoint (#347): --resume-checkpoint short-circuits normal
        // dispatch and exits here — record its one audit entry with the agent,
        // version, and cwd reconstructed from the checkpoint.
        const resumeExit = loopExitCode(result.stoppedBy);
        recordDispatchedRun({
          agent: cp.agent,
          version: cp.version ?? 'unknown',
          mode: resumeExec.mode ?? 'auto',
          cwd: resumeExec.cwd ?? process.cwd(),
          exitCode: resumeExit,
        });
        // A resumed loop is always headless; surface any commits it left unpushed
        // and any open PR it left unattended (RUSH-2394).
        if (shouldWarnUnpushed(resumeExec.mode ?? 'auto', false)) {
          const resumeCwd = resumeExec.cwd ?? process.cwd();
          await warnUnpushedWork(resumeCwd);
          await warnOrphanedOpenPr(resumeCwd);
        }
        process.exit(resumeExit);
      }

      const [
        { buildExecCommand, parseExecEnv, execAgent, runWithFallback, normalizeMode, resolveMode, implicitModeFor, headlessPlanStallCommand, nativeResume, resolveInteractive, inferredInteractiveWithoutTty },
        { ALL_AGENT_IDS, ACCOUNT_INSPECTION_AGENT_IDS, agentLabel, supportsAccountInspection },
        { profileExists, readProfile, resolveProfileForRun },
        // Engine DATA ops resolve through the standalone `secrets` process client
        // (PHNX-3989); the agents-owned `bundle@host` policy helpers stay in agents-cli.
        { readAndResolveBundleEnv, describeBundle, remoteResolveEnv },
        { assertRemoteBundleFlagsUnsupported, splitBundleRef, resolveSecretsContextForRun },
        { resolveHostSshTarget },
        { getConfiguredRunStrategy, normalizeRunStrategy, resolveRunVersion, rotationFailoverChain, shouldArmRotationFailover, RUN_STRATEGIES, collectHarnessCandidates, pickHarnessWeighted, classifyHarnessCandidates, formatHarnessPickBanner, formatNoHealthyHarnessError, formatNoHealthyAccountError, formatNoVerifiedUsageError, signInRecoverableCandidates },
        { getGlobalDefault, getVersionHomePath, resolveVersion, resolveVersionAlias, ensureAgentRunnable },
        { buildDiscoveredPlugin, loadPluginManifest, syncPluginToVersion },
        { parseWorkflowFrontmatter, resolveWorkflowRef, resolveAllowedSubagents, pruneStaleWorkflowSubagents, ensureSubagentDispatchTool },
        { resolveRunDefaults },
        { getMcpServersByName, buildWorkflowMcpConfig },
        { supports, capableAgents },
        { shareRuntimeEnv },
      ] = await Promise.all([
        import('../lib/exec.js'),
        import('../lib/agents.js'),
        import('../lib/profiles.js'),
        import('../lib/secrets-client.js'),
        import('../lib/secrets-policy.js'),
        import('../lib/hosts/credential-transport.js'),
        import('../lib/accounting/rotate.js'),
        import('../lib/installations/versions.js'),
        import('../lib/plugins/plugins.js'),
        import('../lib/workflows.js'),
        import('../lib/run-defaults.js'),
        import('../lib/mcp.js'),
        import('../lib/capabilities.js'),
        import('../lib/share/config.js'),
      ]);
      bootMark('run-deps:imported');
      const isValidAgent = (agent: string): agent is AgentId => ALL_AGENT_IDS.includes(agent as AgentId);

      // Parse agent@version#label. The label selects native auth without pinning
      // the binary version; --account remains the equivalent flag form.
      const labelParts = normalizedAgentSpec.split('#');
      if (labelParts.length > 2 || labelParts[1] === '') {
        console.error(chalk.red(`Invalid account label in '${normalizedAgentSpec}'.`));
        process.exit(1);
      }
      const [rawAgent, rawVersion] = labelParts[0].split('@');
      const specAccountLabel = labelParts[1];
      if (resolveAgentName(rawAgent)) {
        const parsed = parseAgentVersionSpec(normalizedAgentSpec);
        if ('error' in parsed) {
          console.error(chalk.red(parsed.error));
          process.exit(1);
        }
      }
      if (specAccountLabel && options.account && specAccountLabel !== options.account) {
        console.error(chalk.red(`Account '${specAccountLabel}' from the agent spec conflicts with --account '${options.account}'.`));
        process.exit(1);
      }
      if (specAccountLabel) options.account = specAccountLabel;
      let agent: AgentId;
      let version: string | undefined = rawVersion || undefined;
      let profileEnv: Record<string, string> | undefined;
      let accountEnv: Record<string, string> | undefined;
      let accountConfigVersion: string | undefined;
      let execHome: string | undefined;
      // The candidate a local strategy/picker branch selected, and its resolved
      // safe identity. One canonical account resolution preserves the selected
      // account's slot/credential through to spawn and failover (PHNX-3940).
      let selectedCandidate: import('../lib/accounting/rotate.js').RotateCandidate | undefined;
      let resolvedLaunchAccount: import('../lib/accounting/account-launch.js').ResolvedLaunchAccount | undefined;
      let profileProvider: string | undefined;
      let fromProfile = false;
      let profileName: string | undefined;
      let profileFallbackModel: { envKey: string; model: string } | undefined;
      let workflowModel: string | undefined;
      // WORKFLOW.md capability scoping, translated to Claude headless flags below.
      let workflowToolsRestrict: string[] | undefined;
      let workflowMcpConfigPath: string | undefined;
      // Full paths of workflow subagent files THIS run copied into the shared
      // per-agent agents dir. Torn down after the run to restore the shared dir
      // (issue #401), mirroring cleanupWorkflowMcpConfig for the mcp-config.
      const workflowSubagentTargets: string[] = [];
      // WORKFLOW.md `loop:` block (issue #332). When a workflow declares it,
      // `agents run <workflow>` honors the loop without a --loop flag.
      let workflowLoop: import('../lib/workflows.js').LoopConfigRaw | undefined;
      // WORKFLOW.md `for_each:` block (issue #343). When a workflow declares it,
      // `agents run <workflow>` runs the producer, expands one stage teammate per
      // produced item, and drives the teams supervisor to drain — no `teams`
      // subcommands needed.
      let workflowForEach: import('../lib/workflows.js').ForEachSpec | undefined;
      // True once this run copies ≥1 dispatchable subagent into the shared agents
      // dir. Used below to keep the `Task` tool in a `tools:`-restricted workflow —
      // an orchestrator handed subagents but denied `Task` cannot reach them and
      // degenerates to a no-op ("I'll wait for the completion notification").
      let workflowHasSubagents = false;
      const cwd = options.cwd ?? process.cwd();

      if (accountPickerRequested && profileExists(rawAgent)) {
        console.error(chalk.red(
          `Account selection is not available for custom harness '${rawAgent}'. Run its concrete host agent with @ instead.`,
        ));
        process.exit(1);
      }
      if (accountPickerRequested && !isValidAgent(rawAgent)) {
        if (resolveWorkflowRef(rawAgent, cwd)) {
          console.error(chalk.red(
            `Account selection is not available for workflow '${rawAgent}'. Run a concrete agent with @ instead.`,
          ));
          process.exit(1);
        }
      }

      if (autoHarnessRequested) {
        // Harness layer (RUSH-2132): weighted pick across installed harnesses
        // by best-account headroom. Zero healthy accounts anywhere fails loud
        // — launching a default "because it's there" is how a rotate loop
        // hammers an exhausted account.
        const byHarness = await collectHarnessCandidates();
        // F1 (RUSH-2185 / EXEC-23a): a prompt-less run is interactive; only
        // harnesses that can open a REPL with no argv are valid candidates.
        // cursor-agent and similar exit immediately without a prompt, which
        // leaves a silent [detached] pane and an orphan session.
        const interactive = prompt === undefined && options.headless !== true;
        const replCapable = interactive ? new Set(capableAgents('interactiveRepl')) : null;
        const candidateHarness = replCapable
          ? new Map([...byHarness].filter(([id]) => replCapable.has(id)))
          : byHarness;
        const harnessPick = pickHarnessWeighted(candidateHarness);
        if (!harnessPick) {
          if (replCapable && byHarness.size > 0 && candidateHarness.size === 0) {
            const installed = [...byHarness.keys()].join(', ');
            console.error(chalk.red(
              `No installed harness supports a prompt-less interactive REPL (installed: ${installed}). Pass a prompt (-p) or install claude, codex, or another REPL-capable harness.`,
            ));
          } else {
            console.error(chalk.red(formatNoHealthyHarnessError(classifyHarnessCandidates(candidateHarness))));
          }
          process.exit(1);
        }
        agent = harnessPick.picked.agent;
        if (!options.quiet) {
          process.stderr.write(chalk.gray(formatHarnessPickBanner(harnessPick) + '\n'));
        }
        // --session-id keeps its claude-only semantics: honored when auto
        // picks claude, ignored (loudly) otherwise.
        if (options.sessionId && agent !== 'claude' && !options.quiet) {
          process.stderr.write(chalk.yellow(`[agents] --session-id ignored: auto picked ${agent} (only claude accepts a forced session id)\n`));
        }
      } else if (profileExists(rawAgent)) {
        // A profile by this exact name exists. Profiles bind (host agent,
        // version, env overrides, keychain-backed auth) so Chinese models
        // (Kimi, DeepSeek, Qwen, GLM) can run inside Claude Code without a
        // local proxy, including when the profile name matches a native id.
        try {
          const resolved = resolveProfileForRun(rawAgent, options.model);
          agent = resolved.agent;
          if (!version) version = resolved.version;
          profileEnv = resolved.env;
          profileProvider = readProfile(rawAgent).provider;
          profileFallbackModel = resolved.fallbackModel;
          fromProfile = true;
          profileName = resolved.profileName;
          process.stderr.write(chalk.gray(`Resolved custom harness '${resolved.profileName}' -> ${agent}${version ? `@${version}` : ''}\n`));
          if (resolved.tierNote) {
            process.stderr.write(chalk.gray(`[agents] ${resolved.tierNote}\n`));
          }
          // A tier token (cheap/default/best/ultra) already resolved against
          // this PROFILE's own `models:` map above, when the profile opts in.
          // Replace the raw --model value here so the tier never reaches the
          // native, HOST-catalog tier block below. When the profile has no
          // `models:` opt-in at all, resolvedModel stays undefined and
          // options.model is left as the raw tier token on purpose — the
          // "cost tiers don't apply to custom harness ..." discard guard further
          // down this function is the canonical fallback for that case, and
          // this block must not race it with a second, differently-worded
          // message.
          if (resolved.resolvedModel !== undefined) {
            options.model = resolved.resolvedModel;
          }
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      } else if (isValidAgent(rawAgent)) {
        agent = rawAgent;
      } else if (resolveWorkflowRef(rawAgent, cwd)) {
        // Workflow: explicit directory, project .agents/workflows/<name>, user, system, or extra repo.
        // Resolution follows resource precedence: direct path, then project > user > system > extras.
        // Structure:
        //   WORKFLOW.md        ← orchestrator instructions fed to claude as system prompt
        //   subagents/*.md     ← flat .md files copied to ~/.claude/agents/ for Agent tool discovery
        const workflowDir = resolveWorkflowRef(rawAgent, cwd)!;
        agent = 'claude';
        const workflowFrontmatter = parseWorkflowFrontmatter(workflowDir);
        if (typeof workflowFrontmatter?.model === 'string' && workflowFrontmatter.model.trim() !== '') {
          workflowModel = workflowFrontmatter.model.trim();
        }
        workflowLoop = workflowFrontmatter?.loop;
        workflowForEach = workflowFrontmatter?.forEach;

        const resolvedVersion = resolveVersionAlias('claude', version);
        const versionHome = getVersionHomePath('claude', resolvedVersion ?? getGlobalDefault('claude') ?? '');
        const claudeAgentsDir = path.join(versionHome, '.claude', 'agents');

        // Copy subagents/*.md into ~/.claude/agents/ so Claude's Agent tool finds
        // them. allowedAgents enforcement (issue #324): when the workflow declares
        // `allowedAgents:`, copy ONLY those subagent files (matched by filename
        // stem, e.g. security.md -> "security"). A subagent whose definition isn't
        // on disk can't be dispatched — this is the actual, fail-closed mechanism.
        // (Claude's `--agents` flag DEFINES custom agents; it does not restrict
        // which subagents may be dispatched, so it is not used here.)
        const subagentsDir = path.join(workflowDir, 'subagents');
        const allowedAgents = workflowFrontmatter?.allowedAgents;
        if (fs.existsSync(subagentsDir)) {
          fs.mkdirSync(claudeAgentsDir, { recursive: true });
          // Fail-closed subagent scoping (issue #324). resolveAllowedSubagents
          // distinguishes "allowedAgents absent" (undefined -> copy all) from
          // "present but empty" (=> copy ZERO). An explicit `allowedAgents: []`
          // must mean "allow none", never silently widen to "allow all".
          const allFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md'));
          const { allowedStems, missing } = resolveAllowedSubagents(allFiles, allowedAgents);
          const allowStemSet = new Set(allowedStems);
          // Fail-closed prune (issue #401, follow-up to #324). A prior
          // unrestricted run may have left workflow subagent files that THIS
          // scoped run does not permit; they linger in the shared dir and stay
          // dispatchable. Remove those no-longer-permitted workflow-managed
          // files BEFORE writing the allowed set — never a user's own subagent.
          const pruned = pruneStaleWorkflowSubagents(claudeAgentsDir, allFiles, allowedStems);
          if (pruned.length > 0) {
            process.stderr.write(chalk.gray(`[workflow] pruned ${pruned.length} stale workflow subagent(s) from shared dir: ${pruned.join(', ')}\n`));
          }
          let copied = 0;
          let skipped = 0;
          for (const file of allFiles) {
            const stem = file.replace(/\.md$/, '');
            if (!allowStemSet.has(stem)) {
              skipped++;
              continue;
            }
            const dest = path.join(claudeAgentsDir, file);
            fs.copyFileSync(path.join(subagentsDir, file), dest);
            workflowSubagentTargets.push(dest);
            copied++;
          }
          if (copied > 0) workflowHasSubagents = true;
          if (allowedAgents !== undefined) {
            // Surface any allowedAgents entry with no matching subagent file, and
            // report how many were filtered out, so the scope is auditable.
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] allowedAgents not found in subagents/: ${missing.join(', ')}\n`));
            }
            process.stderr.write(chalk.gray(`[workflow] subagents restricted to allowedAgents: copied ${copied}, withheld ${skipped}\n`));
          }
        }

        // Feed WORKFLOW.md body (strip frontmatter) as orchestrator system context.
        const workflowMd = path.join(workflowDir, 'WORKFLOW.md');
        const orchestratorBody = fs.existsSync(workflowMd)
          ? fs.readFileSync(workflowMd, 'utf-8').replace(/^---[\s\S]*?---\n/, '').trim()
          : '';
        if (orchestratorBody && prompt !== undefined) {
          prompt = `${orchestratorBody}\n\n---\n\n${prompt}`;
        }

        // Sync workflow-scoped skills into the version home's skills dir.
        const workflowSkillsDir = path.join(workflowDir, 'skills');
        if (fs.existsSync(workflowSkillsDir)) {
          const skillsTarget = path.join(claudeAgentsDir, '..', 'skills');
          fs.mkdirSync(skillsTarget, { recursive: true });
          for (const entry of fs.readdirSync(workflowSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            fs.cpSync(path.join(workflowSkillsDir, entry.name), path.join(skillsTarget, entry.name), { recursive: true });
          }
        }

        // Sync workflow-scoped plugins into the version home.
        const workflowPluginsDir = path.join(workflowDir, 'plugins');
        if (fs.existsSync(workflowPluginsDir)) {
          for (const entry of fs.readdirSync(workflowPluginsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const pluginRoot = path.join(workflowPluginsDir, entry.name);
            const manifest = loadPluginManifest(pluginRoot);
            if (!manifest) continue;
            syncPluginToVersion(
              buildDiscoveredPlugin(pluginRoot, manifest),
              'claude',
              versionHome,
            );
          }
        }

        // Auto-inject secrets bundles declared in the workflow's frontmatter `secrets:` field.
        // Union with any --secrets flags the user passed; dedupe. Skip when --no-auto-secrets is set.
        // (Commander stores the negated flag as `autoSecrets: false` — the old
        // `noAutoSecrets` read was never populated, making the flag a no-op.)
        if (options.autoSecrets !== false) {
          const declared = workflowFrontmatter?.secrets ?? [];
          if (declared.length > 0) {
            const existing = new Set(options.secrets);
            const added: string[] = [];
            for (const b of declared) {
              if (!existing.has(b)) {
                options.secrets.push(b);
                existing.add(b);
                added.push(b);
              }
            }
            if (added.length > 0) {
              process.stderr.write(chalk.gray(`[workflow] auto-injecting secrets from ${rawAgent}: ${added.join(', ')}\n`));
            }
          }
        }

        // Capability scoping: translate WORKFLOW.md `tools:` / `mcpServers:` into
        // the Claude headless flags that ACTUALLY restrict the run (verified
        // against `claude --help`): tools -> `--tools` (restricts the available
        // built-in tool set), mcpServers -> `--mcp-config` + `--strict-mcp-config`
        // (loads ONLY the named servers). `allowedAgents:` is enforced separately,
        // above, by copying only the allowed subagent definition files. Gated
        // behind the `allowlist` capability — if the resolved agent lacks it, warn
        // loudly rather than silently dropping the declaration (issue #324).
        const scopeVersion = resolveVersionAlias('claude', version) ?? getGlobalDefault('claude') ?? undefined;
        const allowlist = supports('claude', 'allowlist', scopeVersion);
        const tools = workflowFrontmatter?.tools;
        const mcpServerNames = workflowFrontmatter?.mcpServers;
        const hasScoping = (tools && tools.length > 0)
          || (mcpServerNames && mcpServerNames.length > 0)
          || (allowedAgents && allowedAgents.length > 0);

        if (hasScoping && !allowlist.ok) {
          process.stderr.write(chalk.yellow(
            `[workflow] tools/mcpServers declared but unenforceable on claude${scopeVersion ? `@${scopeVersion}` : ''} (allowlist ${allowlist.reason ?? 'unsupported'}) — running unscoped\n`,
          ));
        } else if (hasScoping) {
          if (tools && tools.length > 0) {
            // An orchestrator with dispatchable subagents MUST retain the `Task`
            // tool, or it can't reach the subagents this run just installed for it
            // — the run silently no-ops ("I'll wait for the completion notification").
            workflowToolsRestrict = ensureSubagentDispatchTool(tools, workflowHasSubagents);
            process.stderr.write(chalk.gray(`[workflow] restricting available tools to: ${workflowToolsRestrict.join(', ')} (Write/Bash/Edit unavailable unless listed)\n`));
            if (workflowToolsRestrict.length !== tools.length) {
              process.stderr.write(chalk.gray(`[workflow] kept Task tool: workflow ships subagents to dispatch\n`));
            }
          }
          if (mcpServerNames && mcpServerNames.length > 0) {
            const servers = getMcpServersByName(mcpServerNames, { cwd });
            const found = new Set(servers.map(s => s.name));
            const missing = mcpServerNames.filter(n => !found.has(n));
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] mcpServers not found in registry, skipped: ${missing.join(', ')}\n`));
            }
            // Fail-closed: `mcpServers:` was declared, so the run MUST be scoped to
            // a config — never fall through to the user's ambient MCP set. When
            // zero declared names resolve to installed servers, write a locked-down
            // empty config (`{ "mcpServers": {} }`); with `--strict-mcp-config` the
            // run gets NO MCP servers, which is LESS access than ambient (issue #324).
            const mcpConfig = buildWorkflowMcpConfig(servers);
            const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-workflow-mcp-'));
            workflowMcpConfigPath = path.join(configDir, 'mcp-config.json');
            // 0o600: the config embeds server `env` which can carry tokens.
            // Cleaned up after the run (finally block below).
            fs.writeFileSync(workflowMcpConfigPath, mcpConfig, { mode: 0o600 });
            if (servers.length > 0) {
              process.stderr.write(chalk.gray(`[workflow] scoping MCP servers to ONLY: ${servers.map(s => s.name).join(', ')}\n`));
            } else {
              process.stderr.write(chalk.yellow(`[workflow] no declared mcpServers resolved — scoping run to NO MCP servers (fail-closed)\n`));
            }
          }
        }

        // Count the subagents THIS workflow made available (after allowedAgents
        // filtering), not every file in the shared agents dir. Same fail-closed
        // semantics as the copy above: `allowedAgents: []` -> 0.
        const subagentCount = fs.existsSync(subagentsDir)
          ? resolveAllowedSubagents(
              fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')),
              allowedAgents,
            ).allowedStems.length
          : 0;
        process.stderr.write(chalk.gray(`Workflow '${rawAgent}' → claude (${subagentCount} subagents)\n`));
      } else {
        // Smart pick: auto-correct a single typo (insertion/deletion/substitution/transposition)
        // against the known agent ids before giving up. Example: `cladue` -> `claude`, `grk` -> `grok`.
        const { fuzzyMatch, FUZZY_PRESETS } = await import('../lib/fuzzy.js');
        const suggested = fuzzyMatch(rawAgent, ALL_AGENT_IDS, FUZZY_PRESETS.agents);
        if (suggested && isValidAgent(suggested)) {
          process.stderr.write(chalk.gray(`Resolved '${rawAgent}' -> '${suggested}' (single-edit match)\n`));
          agent = suggested;
        } else {
          console.error(chalk.red(`Unknown agent: ${rawAgent}`));
          console.error(chalk.gray(`Available agents: ${ALL_AGENT_IDS.join(', ')}`));
          console.error(chalk.gray(`Or add a custom harness: agents harness add <name>`));
          process.exit(1);
        }
      }

      if (accountPickerRequested) {
        if (!supportsAccountInspection(agent)) {
          console.error(chalk.red(
            `${agentLabel(agent)} does not expose local account state, so agents-cli cannot safely select an account.`,
          ));
          console.error(chalk.gray(
            `Supported account pickers: ${ACCOUNT_INSPECTION_AGENT_IDS.join(', ')}`,
          ));
          process.exit(1);
        }
        try {
          const { pickRunAccountCandidate } = await import('./run-account-picker.js');
          const selected = await pickRunAccountCandidate(agent);
          if (!selected) return;
          version = selected.version;
          if (selected.nativeAccount) options.account = selected.nativeAccount;
          if (selected.slotDir) execHome = selected.slotDir;
          if (!options.quiet) {
            const identity = selected.accountLabel || 'signed-in account';
            process.stderr.write(chalk.gray(
              `[agents] selected ${identity} · ${agent}@${selected.version} for this run\n`,
            ));
          }
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      version = resolveVersionAlias(agent, version);

      // Account selection follows the binding order: explicit --account → exact
      // `agent@version` binding → device-scoped `agent` binding → per-harness
      // default. The exact-installation binding needs the concrete launch
      // version, so resolve it (default when the run named no version).
      const { resolveSpawnAccount } = await import('../lib/account-registry.js');
      // Binding key: a custom harness keys on its own profile name; a native /
      // global run keys on the exact `agent@version` (default when unpinned).
      const bindingTarget = fromProfile ? rawAgent : (version ? `${agent}@${version}` : `${agent}@${getGlobalDefault(agent) ?? ''}`);
      let spawnAccount: import('../lib/account-registry.js').SpawnAccount | null = null;
      try {
        spawnAccount = resolveSpawnAccount(options.account, agent, version, readMeta(), { useDefault: !fromProfile, provider: profileProvider, target: bindingTarget });
      } catch (err) { console.error(chalk.red((err as Error).message)); process.exit(1); }
      // Downstream rotation gating asks only "was an account selected?".
      const configuredAccount = spawnAccount?.name;
      if (spawnAccount) {
        if (options.cloud || options.provider || options.lease) {
          console.error(chalk.red('--account selects a device-local credential and cannot be combined with cloud or lease placement.'));
          process.exit(1);
        }
        if (spawnAccount.kind === 'native') {
          // `#name` / `--account` on a --device run is forwarded unchanged at
          // dispatch time; the peer resolves ITS slot. This block is local-only.
          const remoteTarget = options.host || options.device;
          if (!remoteTarget) {
            const {
              adoptedConfigPointsAtHome,
              adoptedSymlinkMismatchError,
              durableSlotEnv,
              isSymlinkAdoptedHarness,
              resolveNativeSpawnHome,
              symlinkAdoptedAccountError,
            } = await import('../lib/exec-account-home.js');
            const { readMeta } = await import('../lib/state.js');
            const meta = readMeta();
            if (isSymlinkAdoptedHarness(agent)) {
              const defaultName = meta.accounts?.defaults?.[agent];
              if (spawnAccount.name !== defaultName) {
                console.error(chalk.red(symlinkAdoptedAccountError(agent, spawnAccount.name, defaultName)));
                process.exit(1);
              }
            }
            try {
              const resolved = await resolveNativeSpawnHome(agent, spawnAccount, meta);
              if (isSymlinkAdoptedHarness(agent) && !adoptedConfigPointsAtHome(agent, resolved.execHome)) {
                console.error(chalk.red(adoptedSymlinkMismatchError(agent, spawnAccount.name, resolved.execHome)));
                process.exit(1);
              }
              execHome = resolved.execHome;
              // A worker's durable api-key slot holds no file: the pushed key
              // rides the harness env var (CURSOR_API_KEY, …) on this launch.
              const durable = durableSlotEnv(agent, spawnAccount, resolved, meta);
              if (Object.keys(durable).length > 0) accountEnv = { ...accountEnv, ...durable };
              if (resolved.source === 'legacy-home') {
                accountConfigVersion = resolved.label;
                // A leftover version-labeled home is both the spawn HOME and
                // the account's installation — the pre-T5 `resolveAccountVersion`
                // behavior. An explicit `@<label>` still controls the binary.
                if (!version && !fromProfile && resolved.label) version = resolved.label;
              }
            } catch (err) {
              console.error(chalk.red((err as Error).message));
              process.exit(1);
            }
            // Slot / provisioned: binary comes from the one managed install unless `@<label>` pins it.
            if (!version && !fromProfile) {
              const { ensureHarnessInstallation } = await import('../lib/installations/store.js');
              const { installation } = await ensureHarnessInstallation(agent);
              version = installation.label;
            }
            if (!options.quiet) process.stderr.write(chalk.gray(`[agents] account '${spawnAccount.name}' · ${agent}\n`));
          }
        } else {
          accountEnv = spawnAccount.env;
        }
      }

      // --resume: resolve a prior conversation and rewrite the run target to
      // continue it. `version` here is already the alias-resolved candidate-version
      // FILTER (undefined for default/any, concrete for @latest/@oldest/@x.y.z);
      // it is replaced below by the chosen session's OWN version (isolation).
      let resumeNative = false;
      let resumeSessionId: string | undefined;
      let forceInteractive = false;
      if (options.resume !== undefined) {
        if (options.sessionId) {
          console.error(chalk.red('--resume and --session-id are mutually exclusive. --session-id CREATES a session with a fixed id; --resume continues an existing one.'));
          process.exit(1);
        }
        if (options.loop || options.fallback || options.resumeCheckpoint) {
          console.error(chalk.red('--resume cannot be combined with --loop, --fallback, or --resume-checkpoint (those are separate continuation mechanisms).'));
          process.exit(1);
        }

        const { findSessionsById } = await import('../lib/session/db.js');
        const { discoverSessions } = await import('../lib/session/discover.js');
        const { pickSessionInteractive } = await import('./sessions.js');
        const { buildContinuePrompt } = await import('../lib/loop.js');

        // Freshen the index for this agent before any lookup (incremental, cached).
        // AgentId is wider than SessionAgentId (amp/goose/copilot keep no transcripts);
        // those simply yield no matches and fall through to the not-found error.
        const sessionAgent = agent as import('../lib/session/types.js').SessionAgentId;
        if (!resolvedResumeSource) await discoverSessions({ agent: sessionAgent, version });

        // Resume is interactive unless a follow-on prompt makes it headless.
        const wantsInteractive = resolveInteractive({ interactive: options.interactive, headless: options.headless, prompt });
        const idArg = typeof options.resume === 'string' ? options.resume.trim() : '';
        let scopeCwd: string | undefined;
        try { scopeCwd = fs.realpathSync(cwd); } catch { scopeCwd = cwd; }

        let session: import('../lib/session/types.js').SessionMeta | undefined = resolvedResumeSource;
        if (idArg) {
          let matches = session ? [session] : findSessionsById(idArg, { agent: sessionAgent, version, cwd: scopeCwd });
          if (matches.length === 0) {
            const wide = findSessionsById(idArg, { agent: sessionAgent, version });
            if (wide.length > 0) {
              if (!options.quiet) process.stderr.write(chalk.gray(`No match for "${idArg}" in this project; widened to all projects.\n`));
              matches = wide;
            }
          }
          if (matches.length === 0) {
            console.error(chalk.red(`No ${agent} session matching "${idArg}".`));
            console.error(chalk.gray(`Browse sessions: agents sessions ${idArg}`));
            process.exit(1);
          } else if (matches.length === 1) {
            session = matches[0];
          } else if (wantsInteractive) {
            const picked = await pickSessionInteractive(matches, `Multiple sessions match "${idArg}":`);
            if (!picked) process.exit(0);
            session = picked.session;
          } else {
            console.error(chalk.red(`"${idArg}" is ambiguous — ${matches.length} sessions match:`));
            for (const m of matches.slice(0, 10)) {
              console.error(chalk.gray(`  ${m.shortId}  ${m.timestamp.slice(0, 16).replace('T', ' ')}  ${m.topic ?? m.label ?? ''}`));
            }
            console.error(chalk.gray('Pass more of the id, or resume interactively (drop the prompt).'));
            process.exit(1);
          }
        } else {
          // Bare --resume: pick from recent sessions in scope. Needs a TTY.
          if (!wantsInteractive) {
            console.error(chalk.red('--resume with no id needs an interactive terminal. Pass a session id (full or prefix), or run without --headless.'));
            process.exit(1);
          }
          const recent = await discoverSessions({ agent: sessionAgent, version, limit: 200 });
          if (recent.length === 0) {
            console.error(chalk.red(`No ${agent} sessions found to resume in this project.`));
            console.error(chalk.gray('Browse all: agents sessions'));
            process.exit(1);
          }
          const picked = await pickSessionInteractive(recent, `Resume which ${agent} session?`);
          if (!picked) process.exit(0);
          session = picked.session;
          forceInteractive = true; // bare resume always lands in the agent's TUI
        }

        // Bare `run <harness> --resume` learns the chosen SessionMeta only after
        // the host-placement phase above. If the picker chose a synced session
        // from another device, route the recovery command now; resolving local
        // candidates would otherwise native-resume through this device's
        // unrelated isolated home.
        if (!resolvedResumeSource) {
          const {
            sessionRecoveryPeer,
            sessionRecoveryRunArgs,
          } = await import('../lib/session/recovery.js');
          const peer = sessionRecoveryPeer(session);
          if (peer) {
            const { runOnPeer } = await import('../lib/session/remote-list.js');
            const routed = await runOnPeer(sessionRecoveryRunArgs(session), peer, { tty: true, sessionId: session.id });
            if (routed === 'no-target') {
              console.error(chalk.red(
                `Cannot recover session ${session.shortId}: origin device ${peer} is not a registered reachable peer.`,
              ));
              process.exitCode = 1;
            }
            return;
          }
        }

        // Bare interactive --resume selects the SessionMeta only down here, so
        // it has not gone through the early concrete-id resolver. Resolve it now;
        // concrete ids reuse the exact same target chosen above.
        if (!resolvedRecoveryTarget) {
          try {
            const { resolveSessionRecovery } = await import('../lib/session/recovery.js');
            resolvedRecoveryTarget = await resolveSessionRecovery(session);
          } catch (err) {
            console.error(chalk.red((err as Error).message));
            process.exit(1);
          }
        }
        if (resolvedRecoveryTarget.agent !== agent) {
          console.error(chalk.red(
            `Session ${session.shortId} belongs to ${resolvedRecoveryTarget.agent}, not ${agent}. ` +
            `Use: agents run auto --resume ${session.id}`,
          ));
          process.exit(1);
        }
        version = resolvedRecoveryTarget.version;
        // Account rotation (PHNX-3626 / PHNX-3674): recovery picked a healthy
        // provider of the SAME harness. Inject that credential through the
        // `--account` path so spawn does not authenticate as the version home's
        // native login (the exhausted origin when the continue pick is a
        // provider). An explicit --account (configuredAccount) always wins.
        const rotatedAccount = resolvedRecoveryTarget.account;
        if (rotatedAccount && !configuredAccount) {
          try {
            const picked = resolveSpawnAccount(rotatedAccount.providerAccount, agent, version, readMeta(), { useDefault: false });
            if (picked?.kind === 'provider') accountEnv = picked.env;
          } catch {
            // Account-registry errors can carry provider credential material;
            // never relay them onto the terminal from this automatic path.
            console.error(chalk.red('Could not prepare the rotated provider account for session recovery.'));
            process.exit(1);
          }
        }
        if (resolvedRecoveryTarget.mode === 'native') {
          version = session.version;
          resumeNative = true;
          resumeSessionId = session.id;
          // The centralized recovery decision proves the transcript belongs to
          // this exact isolated home and resolves any harness-specific launch cwd.
          // Claude's indexed `session.cwd` is the first user-turn cwd, which may
          // differ from the earlier cwd that selected projects/<cwd-key>.
          if (!options.cwd && resolvedRecoveryTarget.cwd) options.cwd = resolvedRecoveryTarget.cwd;
          if (rotatedAccount && !configuredAccount && !options.quiet) {
            process.stderr.write(chalk.gray(
              `[agents] origin ${agent} account limited → rotated to ${rotatedAccount.label} (native resume)\n`,
            ));
          }
          if (!options.quiet) process.stderr.write(chalk.gray(
            `Resuming ${agent} ${session.shortId} (native)${version ? ` @${version}` : ''} in ${options.cwd ?? cwd}\n`,
          ));
        } else {
          // Tier-2: launch fresh with a /continue <id> first message; the agent
          // loads the transcript via `agents sessions <id>` and picks up.
          prompt = buildContinuePrompt(session.id, prompt);
          if (prompt.trim() === `/continue ${session.id}`) forceInteractive = true;
          if (rotatedAccount && !configuredAccount && !options.quiet) {
            process.stderr.write(chalk.gray(
              `[agents] origin ${agent} account limited → rotated to ${rotatedAccount.label} (/continue)\n`,
            ));
          }
          if (!options.quiet) process.stderr.write(chalk.gray(`Resuming ${agent} ${session.shortId} (/continue replay)${version ? ` @${version}` : ''}\n`));
        }
      }

      const configuredStrategy = getConfiguredRunStrategy(agent, cwd);
      const explicitStrategy = options.strategy ? normalizeRunStrategy(options.strategy) : null;
      // Captured from resolveRunVersion below so mid-run rate-limit failover can
      // synthesize a same-agent fallback chain from the other healthy accounts
      // (issue #348). Stays null unless a non-pinned strategy actually rotated.
      let rotationResult: import('../lib/accounting/rotate.js').RotateResult | null = null;
      // Precomputed launchable-signed-in verdict for the ACTUAL launched
      // candidate, fed to the pre-launch `run.launch` event so it need not
      // re-probe. Sourced per resolution branch from the candidate that WON, not
      // the original auto-pick: the interactive picker (RUSH-2334 / PHNX-2526)
      // deliberately lets the user launch a LOGGED-OUT account, which is a
      // different candidate than `rotationResult.picked` — reading the verdict off
      // the auto-pick there would report `launchedLoggedOut:false` for a version
      // that is actually logged out, the exact false-negative this event exists to
      // prevent. Left undefined for pinned-default / explicit-pin so emitRunLaunch
      // falls back to probing the version home itself.
      let launchSignedIn: boolean | null | undefined;
      let launchEmail: string | null | undefined;
      // Set when the zero-healthy path already announced a deliberate
      // launch-to-sign-in, so the login preflight below does not repeat it.
      let signInLaunch = false;
      if (options.strategy && !explicitStrategy) {
        console.error(chalk.red(`Invalid strategy: ${options.strategy}. Use ${RUN_STRATEGIES.join(', ')}.`));
        process.exit(1);
      }
      if (options.balanced && explicitStrategy && explicitStrategy !== 'balanced') {
        console.error(chalk.red('--balanced conflicts with --strategy. Use one strategy override.'));
        process.exit(1);
      }
      const strategy = options.balanced ? 'balanced' : explicitStrategy ?? configuredStrategy;

      // Strategy applies to bare (unpinned) invocations. Explicit @version and
      // profiles already name the target. A --fallback chain does NOT pin the
      // primary: it only names where to cascade on a rate limit, so the bare
      // primary still resolves through the strategy — otherwise every
      // `agents run claude --fallback codex` run lands on the pinned default
      // account and account rotation silently stops (the gh-monitor heal bug).
      // `pinned` still resolves so a logged-out default can yield to a signed-in
      // sibling on this device (PHNX-2685); an explicit @version pin is unchanged.
      if (!accountPickerRequested && !configuredAccount && (!version || strategy !== 'pinned' || options.balanced || explicitStrategy)) {
        if (version) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: version ${version} is pinned\n`));
        } else if (fromProfile) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: custom harness pins its own version/auth\n`));
        } else {
          try {
            // Account-centric candidate list: native version-home logins PLUS
            // provider accounts (setup-token / API-key) that can auth this agent,
            // so `--strategy balanced` spreads across ALL accounts, not just the
            // ones sitting in a version home (RUSH-3182). Run-path only — the
            // picker's other callers keep the native-only collector.
            const { collectRunCandidatesForRun } = await import('../lib/accounting/account-pool-collect.js');
            bootMark('resolve-version:start');
            const resolved = await resolveRunVersion(agent, strategy, cwd, collectRunCandidatesForRun);
            bootMark('resolve-version:done');
            if (resolved.exhausted) {
              // Zero healthy accounts splits two ways, and conflating them is what
              // stranded a logged-out harness with no way in at all (RUSH-2334):
              //
              // - THROTTLED (rate_limited / out_of_credits) -> fail loud (RUSH-2132).
              //   The old behavior warned "found no usable version; falling back to
              //   defaults" and launched the pinned default anyway — the exact move
              //   that loops a rotate into an exhausted account. Only a window reset
              //   clears it. The message text is a contract the Factory watchdog
              //   tail-detects; do not reword it.
              // - NEEDS A SIGN-IN (signed_out / revoked) -> launching IS the fix,
              //   because the harness's own TUI is the login surface. So on a TTY we
              //   carry the user into that login instead of erroring. Exiting here
              //   made `agents run <agent>`, `agents run <agent>@`, and `agents use`
              //   all dead-end with no reachable way to authenticate.
              const recoverable = signInRecoverableCandidates(resolved.exhausted);
              const { signInLaunchDecision } = await import('./run-account-picker.js');
              const decision = signInLaunchDecision({
                recoverable: recoverable.length,
                tty: isInteractiveTerminal(),
                json: options.json === true,
              });
              if (decision === 'launch') {
                const { pickSignInLaunchCandidate } = await import('./run-account-picker.js');
                const signInPick = await pickSignInLaunchCandidate(agent, recoverable, !!options.quiet);
                // A cancelled prompt launches nothing — same contract as the
                // trailing-@ account picker above.
                if (!signInPick) return;
                version = signInPick.version;
                // Launch that exact account's home/slot so the login lands in the
                // right place, not the binary's version home (PHNX-3940). The
                // canonical resolver below keys off this candidate.
                selectedCandidate = signInPick;
                // We just told the user this account is logged out and why we're
                // launching it, so suppress the downstream login preflight — it
                // would print a second, near-identical "looks logged out" warning.
                signInLaunch = true;
              } else {
                console.error(chalk.red(formatNoHealthyAccountError(agent, strategy, resolved.exhausted)));
                if (recoverable.length > 0) {
                  // Off a TTY nobody can complete a login, so we still exit — but
                  // name the actual fix rather than only offering --strategy pinned,
                  // which would just pin the same unauthenticated account.
                  const { loginHint } = await import('../lib/signin-badge.js');
                  console.error(chalk.gray(
                    `To sign in: ${loginHint(agent)} — or run \`agents run ${agent}\` from a terminal.`,
                  ));
                }
                process.exit(1);
              }
            } else if (resolved.noVerifiedUsage) {
              // Entirely stale usage (PHNX-2526): every eligible account carries
              // a stale-but-present usage number and none is verified, so the
              // route would be a guess. NEVER auto-pick it. Interactive: show the
              // account picker so a human chooses with the (stale) numbers in
              // view. Unattended: fail loud with NO_VERIFIED_USAGE. The stale
              // pool survives ONLY as `resolved.rotation.healthy` for bounded
              // post-rejection failover, never as the initial pick.
              const { noVerifiedUsageDecision, pickRunAccountCandidate } = await import('./run-account-picker.js');
              const decision = noVerifiedUsageDecision({
                tty: isInteractiveTerminal(),
                json: options.json === true,
                headless: options.headless === true,
              });
              if (decision === 'picker') {
                const selected = await pickRunAccountCandidate(agent);
                // A cancelled picker launches nothing — same contract as the
                // trailing-@ account picker and the sign-in launch above.
                if (!selected) return;
                version = selected.version;
                // Preserve the selected account's identity + slot through to the
                // spawn: the canonical resolver below keys off this candidate, so
                // a stale-usage pick launches the chosen account's home, not the
                // binary's version home (PHNX-3940).
                selectedCandidate = selected;
                // Source the run.launch verdict from the account the user ACTUALLY
                // picked — the picker may deliberately return a logged-out one
                // (RUSH-2334), so it can differ from rotationResult.picked.
                launchSignedIn = selected.signedIn;
                launchEmail = selected.email;
                // Keep the rotation so mid-run failover can still cascade across
                // the other (stale) healthy accounts after a real rejection.
                rotationResult = resolved.rotation;
                if (!options.quiet) {
                  const identity = selected.accountLabel || 'signed-in account';
                  process.stderr.write(chalk.gray(
                    `[agents] no fresh usage for any ${agent} account — you picked ${identity} · ${agent}@${selected.version}\n`,
                  ));
                }
              } else {
                console.error(chalk.red(
                  formatNoVerifiedUsageError(agent, strategy, resolved.rotation?.healthy ?? []),
                ));
                process.exit(1);
              }
            } else if (resolved.version) {
              version = resolved.version;
              rotationResult = resolved.rotation;
              // The auto-pick already computed the launchable-signed-in verdict for
              // this exact version via the same gate — reuse it for run.launch.
              if (resolved.rotation) {
                launchSignedIn = resolved.rotation.picked.signedIn;
                launchEmail = resolved.rotation.picked.email;
                // Carry the picked account through the canonical resolver below:
                // a native slot launches its own home, a provider account
                // (setup-token / API-key) materializes its credential env — both
                // resolved once at the local spawn boundary (PHNX-3940, RUSH-3182),
                // never dropped back to the binary's version home.
                selectedCandidate = resolved.rotation.picked;
              }
              if (resolved.rotation && !options.quiet) {
                const banner = formatRotationBanner(resolved.rotation, strategy);
                process.stderr.write(chalk.gray(banner + '\n'));
              }
            } else if (!options.quiet) {
              // No installed version at all (not "accounts exhausted" — that
              // fails loud above): keep the pre-existing default resolution.
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} found no usable ${agent} version; falling back to defaults\n`));
            }
          } catch (err) {
            if (!options.quiet) {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} skipped: ${(err as Error).message}\n`));
            }
          }
        }
      }

      // One canonical account resolution for the local selection branches that
      // do NOT route through the explicit `--account` block above — the
      // stale-usage picker and the automatic rotation pick (PHNX-3940). Each
      // selected a candidate; resolving it here preserves that exact account's
      // identity and its slot / provider credential through to spawn, instead of
      // keeping only the binary version and launching the version home. The
      // version still selects the executable only; the account owns the home.
      if (selectedCandidate) {
        try {
          const { resolveLocalAccountLaunch } = await import('../lib/accounting/account-launch.js');
          const launch = await resolveLocalAccountLaunch({
            agent,
            executableVersion: version ?? selectedCandidate.version,
            candidate: selectedCandidate,
          });
          if (launch.execHome) execHome = launch.execHome;
          if (launch.configVersion) accountConfigVersion = launch.configVersion;
          if (Object.keys(launch.env).length > 0) accountEnv = { ...accountEnv, ...launch.env };
          resolvedLaunchAccount = launch.account ?? undefined;
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      // Self-heal the launch target. A gutted install (JS wrapper present,
      // native binary missing — a partial/raced npm extraction of the optional
      // per-arch dependency) would otherwise spawn and die with a raw ENOENT
      // inside the agent's own wrapper. Repair it in place (or fall back to a
      // runnable version, re-pinning it) BEFORE we build the launch command.
      // Skipped for headless resume-native/acp/loop paths only if it errored;
      // here it runs for every normal dispatch. Best-effort log to stderr.
      {
        const launchTarget = version ?? resolveVersion(agent, cwd) ?? undefined;
        if (launchTarget) {
          const healed = await ensureAgentRunnable(
            agent,
            launchTarget,
            options.quiet ? undefined : (m) => process.stderr.write(chalk.yellow(`[agents] ${m}\n`)),
          );
          if (healed === null) {
            // An isolated copy is never repaired by adopting another version, so
            // `add <agent>@latest` would build an unrelated NORMAL install rather
            // than fix what the user asked to run. Point at the isolated re-add.
            const { isVersionIsolated } = await import('../lib/installations/versions.js');
            const hint = isVersionIsolated(agent, launchTarget)
              ? `agents add ${agent}@${launchTarget} --isolated`
              : `agents add ${agent}@latest`;
            console.error(chalk.red(`agents: ${agent}@${launchTarget} is not runnable and could not be repaired. Try: ${hint}`));
            process.exit(1);
          }
          if (resolvedRecoveryTarget && healed !== launchTarget) {
            console.error(chalk.red(
              `agents: session recovery target ${agent}@${launchTarget} became unavailable on ` +
              `${resolvedResumeSource?.machine ?? 'this device'}; refusing to resume through another version home. ` +
              `Retry the command so recovery can select a healthy ${agent} version.`,
            ));
            process.exit(1);
          }
          // Always adopt the healed version explicitly. In the version-undefined
          // path a fallback re-pins the GLOBAL default, but `resolveVersion`
          // prefers a PROJECT pin — so leaving `version` undefined would let the
          // shim re-resolve the still-broken project pin and crash anyway. Pinning
          // the runnable version here is a no-op when nothing changed.
          version = healed;
        }
      }
      bootMark('ensure-runnable:done');

      // The harness may simply not be on this machine. The self-heal above only
      // runs when a managed version resolved, so with nothing installed we used
      // to fall through and spawn the bare `cliCommand`, which dies as
      // `exec: cursor-agent: not found` (exit 127) after a misleading
      // "looks logged out" banner (RUSH-2339). Probe the executable
      // buildExecCommand will actually spawn and fail loud instead.
      //
      // This is an EXISTENCE probe, not "does agents-cli manage a version". A
      // harness the user installed themselves (Homebrew, a vendor `curl | sh`, a
      // distro package) has no version home and MUST still launch — the PATH
      // branch of resolveLaunchBinary is what keeps that working.
      {
        const { resolveLaunchBinary } = await import('../lib/exec.js');
        // `version` already carries the self-heal's resolution above (it assigns
        // `version = healed` whenever a version resolved at all), so re-deriving
        // it with resolveVersion here would be dead.
        if (!resolveLaunchBinary(agent, version)) {
          const target = version ? `${agent}@${version}` : agent;
          console.error(chalk.red(`agents: ${target} is not installed on this machine.`));
          console.error(chalk.yellow(`Install it with: agents add ${target}`));
          process.exit(1);
        }
      }

      const defaultVersion = version ?? resolveVersion(agent, cwd);

      // Re-apply the active rules preset before every launch (issue: preset
      // changes via `setActiveRulesPreset` only took effect after an explicit
      // `agents rules switch` / `agents sync`). Version-scoped, skip-fast when
      // nothing changed — see lib/rules/run-sync.ts. Placed here (immediately
      // after the resolved version is known, before ACP/loop/fallback branch
      // off) so every downstream dispatch path for this agent+version sees a
      // fresh rules file, not just the plain execAgent path. `defaultVersion`
      // is null when nothing is installed yet — execAgent handles that error
      // path itself; there's no version home to sync into.
      if (defaultVersion) {
        applyActiveRulesPresetAtRun(agent, defaultVersion, getVersionHomePath(agent, defaultVersion));
        applySystemResourcesAtRun(agent, defaultVersion, getVersionHomePath(agent, defaultVersion));
      }
      bootMark('rules-sync:done');

      // Login preflight (advisory, warn + continue). On a local INTERACTIVE
      // launch, probe whether this agent's account has a credential and print a
      // one-line warning if it looks logged out — so you find out BEFORE the TUI
      // opens, not after typing a prompt and getting "/login" back. Inspect the
      // selected account home, not an unrelated global login. This file-based
      // read makes no Keychain ACL prompt. It can still false-negative for opaque
      // credentials, so this NEVER blocks — it warns and launches anyway. Skipped
      // for --json/--quiet, when a rotation already picked a signed-in account,
      // and via --no-auth-check / AGENTS_NO_AUTH_CHECK=1. (--device/--lease return
      // earlier.)
      {
        const { shouldCheckLoginBeforeLaunch, loginHint } = await import('../lib/signin-badge.js');
        const preflight = shouldCheckLoginBeforeLaunch({
          interactive: options.interactive,
          forceInteractive, // a resumed interactive session (e.g. `run kimi --resume`) opens the TUI too
          headless: options.headless,
          hasPrompt: prompt !== undefined,
          json: options.json,
          quiet: options.quiet,
          authCheckDisabled: options.authCheck === false || process.env.AGENTS_NO_AUTH_CHECK === '1',
          // `signInLaunch` means the zero-healthy path already reported this exact
          // account as logged out and named the login command, so re-probing here
          // only prints a second, near-identical warning.
          rotated: !!rotationResult || accountPickerRequested || signInLaunch || spawnAccount?.kind === 'provider',
        });
        if (preflight) {
          try {
            const { getAccountInfo } = await import('../lib/agents.js');
            // Probe the account that will ACTUALLY spawn: the resolved slot home
            // when this launch has one, else the version home (PHNX-3940).
            // Attributing to the version home mis-reads a slot account's login.
            const authVersion = accountConfigVersion ?? version;
            const authHome = execHome ?? (authVersion ? getVersionHomePath(agent, authVersion) : undefined);
            const info = await getAccountInfo(agent, authHome);
            // Claude authenticates interactively from a per-version setup-token on a
            // keychain-less worker (the shim's .oauth_token fallback), which the
            // native-credential probe above can't see — so don't warn "logged out" when
            // a setup-token resolves for this version. No-op on macOS, where the
            // credential lives in the keychain and resolveClaudeSetupToken returns null.
            let authedViaSetupToken = false;
            if (!info.signedIn && agent === 'claude' && version) {
              const { resolveClaudeSetupToken } = await import('../lib/claude-account-token.js');
              const { getVersionHomePath } = await import('../lib/installations/versions.js');
              authedViaSetupToken = resolveClaudeSetupToken(getVersionHomePath('claude', version)) !== null;
            }
            if (!info.signedIn && !authedViaSetupToken) {
              const { addSupported } = await import('../lib/accounts/add.js');
              const hint = spawnAccount?.kind === 'native'
                ? `agents accounts login ${agent}#${spawnAccount.name}`
                : addSupported(agent)
                  ? `agents accounts add ${agent} <name>`
                  : loginHint(agent);
              process.stderr.write(
                chalk.yellow(`${agent} looks logged out — sign in with: ${hint}. Launching anyway...\n`),
              );
            }
          } catch {
            // Advisory only — a probe failure must never block a launch.
          }
        }
      }

      const runDefaults: ResolvedRunDefaults = fromProfile
        ? { sources: {} }
        : resolveRunDefaults(agent, defaultVersion, cwd);

      // Accept the four canonical modes plus 'full' as a permanent silent
      // alias for 'skip' (rewritten downstream by normalizeMode in exec.ts).
      let mode = options.mode as ExecMode;
      const modeSource = runCmd.getOptionValueSource('mode');
      const modeFromRunDefault = modeSource === 'default' && !!runDefaults.mode;
      if (modeFromRunDefault) {
        mode = runDefaults.mode as ExecMode;
      }
      if (!['plan', 'edit', 'auto', 'skip', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use plan, edit, auto, or skip ('full' accepted as alias for skip).`));
        process.exit(1);
      }

      // Default CLI mode is the generic 'plan'. Agents without a read-only
      // mode (antigravity, …) degrade via resolveMode to their
      // safest native mode (modes[0], typically edit). That covers both the
      // implicit default and an explicit `--mode plan`, so multi-agent
      // scripts can pass a uniform plan flag without per-agent branching.
      // Mode degradation is never silent: buildExecCommand emits one stderr
      // warning for the requested-to-resolved transition unless --quiet is set.
      // `skip` still hard-fails when unsupported — pretending we bypassed
      // permissions would be unsafe.
      const modeIsDefault = modeSource === 'default';
      let requestedMode = normalizeMode(mode);
      // Codex's intrinsic omitted-mode default is safe writable: workspace plus
      // common caches, network enabled, approvals on request. An explicit
      // --mode plan and a configured run default remain read-only.
      const { modeWasImplicit } = await import('../lib/codex-policy.js');
      const wasModeImplicit = modeWasImplicit(modeSource, modeFromRunDefault);
      if (wasModeImplicit) requestedMode = implicitModeFor(agent);
      let resolvedMode: ReturnType<typeof resolveMode>;
      try {
        resolvedMode = resolveMode(agent, requestedMode);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      mode = resolvedMode as ExecMode;

      // Fail fast on the headless-plan stall footgun: a slash command run
      // headless under the implicit default 'plan' mode hangs forever at
      // ExitPlanMode (no TTY to approve the plan). Tell the user how to fix it
      // instead of leaving them staring at a frozen process. Explicit
      // `--mode plan` is respected for genuine read-only command runs.
      const stallCmd = headlessPlanStallCommand({
        prompt,
        interactive: options.interactive,
        mode: resolvedMode as ExecMode,
        modeIsDefault,
      });
      if (stallCmd) {
        console.error(
          chalk.red(`Refusing to run ${stallCmd} headless in read-only 'plan' mode — it would hang at ExitPlanMode (no TTY to approve the plan).`)
        );
        console.error(
          chalk.yellow(`Re-run with an explicit mode: --mode auto (recommended — auto-approves safe ops, blocks risky ones), --mode edit, or --mode full.`)
        );
        console.error(
          chalk.gray(`Pass --mode plan explicitly if you really want a read-only run.`)
        );
        process.exit(1);
      }

      const effortSource = runCmd.getOptionValueSource('effort');
      const effort = (effortSource === 'default' && runDefaults.effort ? runDefaults.effort : options.effort) as ExecEffort;
      if (!['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(effort)) {
        console.error(chalk.red(`Invalid effort: ${effort}. Use 'low', 'medium', 'high', 'xhigh', 'max', or 'auto'`));
        process.exit(1);
      }

      let userEnv: Record<string, string> | undefined;
      try {
        userEnv = parseExecEnv(options.env);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }

      // Resolve --secrets bundles in flag order. Later bundles override earlier
      // ones. Any resolution failure (missing keychain item, blocked exec ref)
      // aborts before spawn so the agent never sees a partial env.
      const secretsKeysSubset = options.secretsKeys
        ? options.secretsKeys.split(',').map((k: string) => k.trim()).filter(Boolean)
        : undefined;
      let secretsEnv: Record<string, string> = {};
      // Resource-profile scoping (CTX-1): agents-cli computes which bundle
      // names the active profile allows and forwards it as the client's
      // `allowedBundles` on every local resolution — the standalone has no
      // concept of a profile. undefined (no active profile) is full trust.
      const secretsContext = await resolveSecretsContextForRun(agent);
      for (const bundleRef of options.secrets) {
        try {
          const { bundle: bundleName, host } = splitBundleRef(bundleRef);
          if (host) {
            // Least-privilege flags (--secrets-keys / --allow-expired) do not
            // yet cross the SSH resolver — silently applying them would inject
            // the full remote env or an expired key. Fail loud so the user
            // can drop the flag or resolve locally instead.
            assertRemoteBundleFlagsUnsupported(
              bundleName,
              host,
              { keys: secretsKeysSubset, allowExpired: options.allowExpired },
              { keysFlag: '--secrets-keys', allowExpiredFlag: '--allow-expired' },
            );
            // Remote bundle (`bundle@host`): resolve over SSH and inject
            // ephemerally — values never touch this machine's keychain or disk.
            const target = await resolveHostSshTarget(host);
            const bundleEnv = await remoteResolveEnv(target, bundleName, { osLookupName: host });
            console.log(chalk.gray(`[secrets] Resolved ${bundleName}@${host}: ${Object.keys(bundleEnv).length} keys (remote, ephemeral)`));
            secretsEnv = { ...secretsEnv, ...bundleEnv };
          } else {
            const { bundle, env: bundleEnv } = await readAndResolveBundleEnv(bundleName, {
              caller: `agent ${agent}`,
              agent,
              keys: secretsKeysSubset,
              allowExpired: options.allowExpired,
              // The harness identity scopes any cached grant. An agent launch
              // resolves broker-only and fails fast naming
              // `agents secrets unlock <bundle>` (bundles.ts:interactiveUnlock) — it
              // MUST NOT raise a Touch ID sheet regardless of tty (SEC-13). Gating on
              // isHeadlessSecretsContext() left `--interactive` launches (the watchdog's
              // `agents run auto --interactive`) able to prompt, piling up helper sheets.
              agentOnly: true,
            }, secretsContext);
            const entries = await describeBundle(bundle, secretsContext);
            const counts: Record<string, number> = {};
            for (const e of entries) {
              counts[e.kind] = (counts[e.kind] || 0) + 1;
            }
            const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
            console.log(chalk.gray(`[secrets] Resolved ${bundleName}: ${entries.length} keys (${breakdown})`));
            secretsEnv = { ...secretsEnv, ...bundleEnv };
          }
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

      const autoShareEnv = options.autoSecrets !== false
        ? shareRuntimeEnv()
        : undefined;

      // Merge order (later wins): profile env < selected account < auto share token < secrets bundles < --env K=V.
      // Profile carries provider auth; secrets bundles carry user-defined
      // values; --env is the per-invocation override. The share token is
      // best-effort: if it is not already in env or an unlocked bundle, unrelated
      // runs keep working, and `agents artifacts share` itself still fails loudly on use.
      const hasOverrides = profileEnv || accountEnv || autoShareEnv || options.secrets.length > 0 || userEnv;
      const env: Record<string, string> | undefined = hasOverrides
        ? { ...(profileEnv ?? {}), ...(accountEnv ?? {}), ...(autoShareEnv ?? {}), ...secretsEnv, ...(userEnv ?? {}) }
        : undefined;

      const modelSource = runCmd.getOptionValueSource('model');
      let model = options.model
        ?? (!fromProfile && modelSource === undefined
          ? (workflowModel ?? (options.fallback ? undefined : runDefaults.model))
          : undefined);

      // Cost tiers (cheap|default|best|ultra) resolve against a harness's own model
      // catalog. A custom harness's model comes from its endpoint, not the host
      // harness, so a tier here would forward an incompatible host-harness model to a
      // different API. Discard it loudly and let the custom harness's own model stand.
      if (fromProfile && model && isTierToken(model)) {
        process.stderr.write(chalk.yellow(
          `[agents] --model ${model}: cost tiers don't apply to custom harness '${rawAgent}' ` +
          `(its model comes from the endpoint) — ignoring the tier, using the custom harness's configured model\n`,
        ));
        model = undefined;
      }

      const execOptions: ExecOptions = {
        agent,
        harnessName: profileName,
        version,
        configVersion: accountConfigVersion,
        execHome,
        // Safe identity + selected candidate for this attempt, so the spawn and
        // any rate-limit failover attribute the account that actually ran, never
        // the binary version (PHNX-3940). The explicit `--account` path carries
        // its account through execHome above; these cover the rotation/picker
        // branches and seed the failover chain's primary entry.
        account: resolvedLaunchAccount,
        accountCandidate: selectedCandidate,
        prompt,
        interactive: options.interactive || forceInteractive,
        mode: requestedMode,
        modeWasImplicit: wasModeImplicit,
        effort,
        cwd: options.cwd,
        model,
        addDirs: options.addDir,
        json: options.json,
        headless: options.headless,
        sessionId: resumeSessionId ?? options.sessionId,
        name: options.name,
        resume: resumeNative,
        verbose: options.verbose,
        modeWarningState: { quiet: options.quiet },
        // --raw, --no-tmux (commander negation → options.tmux === false), and
        // --disable-tmux all bypass the interactive tmux wrapper. AGENTS_NO_TMUX=1
        // does the same via the env check in exec.ts.
        raw: options.raw || options.tmux === false || options.disableTmux === true,
        timeout: options.timeout,
        env,
        toolsRestrict: workflowToolsRestrict,
        mcpConfigPath: workflowMcpConfigPath,
        passthroughArgs,
        // Set only on the REMOTE side of a `--device` dispatch (the launcher
        // forwards `--emit-session-id`): print the resolved session id as a
        // stdout sentinel so the launcher captures the id this run coined.
        emitSessionId: options.emitSessionId === true,
        // Observability-only: carried onto the pre-launch `run.launch` event so
        // the stream records HOW this version was chosen. Neither affects the
        // spawn. `resolvedVia` attributes the version source cheaply — an
        // explicit @version pin, a strategy rotation, or the pinned default.
        strategy,
        resolvedVia: rawVersion
          ? 'explicit-pin'
          : rotationResult
            ? 'rotated'
            : 'pinned-default',
        // Launchable-signed-in verdict for the ACTUAL launched candidate, set per
        // resolution branch above (auto-pick from rotation.picked; interactive
        // picker from the user's `selected`, which may be logged out). Undefined
        // for a pinned-default / explicit-pin launch, where spawnAgent probes the
        // version home itself.
        launchSignedIn,
        launchEmail,
      };

      if (options.interactive && options.headless) {
        console.error(chalk.red('--interactive and --headless are mutually exclusive. Pass one, or neither (mode is inferred from prompt presence).'));
        process.exit(1);
      }

      if (options.interactive) {
        if (options.fallback) {
          console.error(chalk.red('--interactive is not compatible with --fallback. Fallback only works for headless prompt runs.'));
          process.exit(1);
        }
        if (options.acp) {
          console.error(chalk.red('--interactive is not compatible with --acp. ACP is a headless protocol.'));
          process.exit(1);
        }
      }

      const fallback: FallbackEntry[] = [];
      if (options.fallback) {
        if (prompt === undefined) {
          console.error(chalk.red('--fallback requires a prompt. Fallback hands off headless runs only — interactive sessions can\'t be resumed on a different CLI.'));
          process.exit(1);
        }
        const entries = options.fallback.split(',').map(s => s.trim()).filter(Boolean);
        const { fuzzyMatch: fuzzyFb, FUZZY_PRESETS: PRESETS_FB } = await import('../lib/fuzzy.js');
        for (const entry of entries) {
          const [rawFbAgent, fbVersion] = entry.split('@');
          let fbAgent: AgentId;
          if (isValidAgent(rawFbAgent)) {
            fbAgent = rawFbAgent;
          } else {
            const suggested = fuzzyFb(rawFbAgent, ALL_AGENT_IDS, PRESETS_FB.agents);
            if (suggested && isValidAgent(suggested)) {
              process.stderr.write(chalk.gray(`Resolved fallback '${rawFbAgent}' -> '${suggested}' (single-edit match)\n`));
              fbAgent = suggested;
            } else {
              console.error(chalk.red(`Unknown fallback agent: ${rawFbAgent}`));
              console.error(chalk.gray(`Available: ${ALL_AGENT_IDS.join(', ')}`));
              process.exit(1);
            }
          }
          if (fbAgent === agent) {
            console.error(chalk.red(`Fallback cannot include the primary agent (${agent}). Rate-limit fallback only helps when switching providers.`));
            process.exit(1);
          }
          fallback.push({ agent: fbAgent, version: resolveVersionAlias(fbAgent, fbVersion || undefined) });
        }
      }

      // Profile-declared same-host model swap (issue #325). Inserted BEFORE any
      // user --fallback entries so a rate limit first tries the cheaper/backup
      // model on the same provider (auth + base URL preserved via envOverride);
      // only if THAT still rate-limits do we cascade to a different agent CLI.
      // Requires a prompt for the same reason --fallback does — headless-only.
      if (fromProfile && profileFallbackModel && prompt !== undefined && !options.interactive) {
        fallback.unshift({
          agent,
          version,
          envOverride: { [profileFallbackModel.envKey]: profileFallbackModel.model },
        });
      }

      // Mid-run rate-limit failover (issue #348). When a pre-flight rotation
      // picked an account and there are OTHER healthy accounts for the same
      // agent, synthesize a same-agent fallback chain from them so a 429 mid-run
      // re-dispatches on the next healthy account via the SAME runWithFallback
      // path (continuing the session via /continue). Because this injects into
      // the same `fallback` array `--fallback` uses, it must only arm for run
      // shapes that accept a fallback chain — shouldArmRotationFailover excludes
      // acp/loop/resume-checkpoint (which reject a non-empty fallback below)
      // and interactive/no-prompt runs. Pinned/single-account runs stay
      // unchanged because rotationResult is null or rotationFailoverChain
      // returns []. version is set here because rotationResult is only
      // populated when resolveRunVersion picked one.
      //
      // Composes with an explicit --fallback chain: the same-agent accounts are
      // UNSHIFTED ahead of the user's cross-agent entries, so a rate limit
      // first tries the other accounts of the same agent (cheapest recovery —
      // same CLI, session continues) and only then cascades to codex/gemini/etc.
      // Profiles never compose: strategy is skipped for them, rotationResult
      // stays null. (fromProfile's model-swap unshift above is therefore never
      // displaced by this one.)
      if (
        shouldArmRotationFailover({
          hasRotation: !!rotationResult,
          hasVersion: !!version,
          hasPrompt: prompt !== undefined,
          interactive: !!options.interactive,
          acp: !!options.acp,
          loop: !!options.loop,
          resumeCheckpoint: !!options.resumeCheckpoint,
        })
      ) {
        // Exclude the account that ACTUALLY launched — the interactive picker
        // may have chosen one other than rotation.picked (PHNX-3940) — so the
        // failover net never re-tries the primary account.
        const failover = rotationFailoverChain(rotationResult!, selectedCandidate ?? version!);
        if (failover.length > 0) {
          fallback.unshift(...failover);
          if (!options.quiet) {
            const accounts = failover.map(f => `${f.agent}@${f.version}`).join(', ');
            process.stderr.write(chalk.gray(`[agents] rate-limit failover armed: ${accounts}\n`));
          }
        }
      }

      if (options.acp) {
        if (prompt === undefined) {
          console.error(chalk.red('--acp requires a prompt. ACP is a programmatic protocol; interactive TUI sessions still use the native CLI.'));
          process.exit(1);
        }
        if (fallback.length > 0) {
          console.error(chalk.red('--acp is not compatible with --fallback yet. Drop one.'));
          process.exit(1);
        }
        const { supportsAcp } = await import('../lib/acp/harnesses.js');
        if (!supportsAcp(agent)) {
          console.error(chalk.red(`Agent '${agent}' does not support ACP. Drop --acp to use direct exec.`));
          process.exit(1);
        }
        const { runAcpHeadless } = await import('../lib/acp/run.js');
        try {
          const exitCode = await runAcpHeadless({
            agent,
            prompt,
            cwd: options.cwd ?? process.cwd(),
            mode,
            json: options.json ?? false,
          });
          // Governance chokepoint (#347): the --acp path exits here, bypassing
          // the normal finalize below — record its one audit entry.
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode });
          // ACP headless run always has a prompt; surface any unpushed commits
          // and any open PR left unattended (RUSH-2394).
          if (shouldWarnUnpushed(mode, false)) {
            await warnUnpushedWork(cwd);
            await warnOrphanedOpenPr(cwd);
          }
          process.exit(exitCode);
        } catch (err) {
          console.error(chalk.red(`ACP run failed for ${agent}: ${(err as Error).message}`));
          process.exit(1);
        }
      }

      // Budget pre-flight gate (issue #346). Estimate the run's cost and, when a
      // cap is configured with on_exceed:block, refuse to launch if it would push
      // a cap over the line — exiting non-zero so CI/headless inherit the block.
      // --yes skips ONLY the interactive confirm threshold, never a hard block.
      {
        const { runPreflightGate } = await import('../lib/budget/preflight.js');
        const { resolveEffectiveModel } = await import('../lib/models.js');
        // Estimate against the model that will ACTUALLY run, not an unpriced
        // `${agent}-default` placeholder (which made estimateCost return $0 and
        // silently neutered the per_run/per_day gate for the common no-`--model`
        // case). When `model` is undefined the spawned CLI uses its built-in
        // default, which we recover from the extracted catalog. If we still can't
        // resolve a concrete model, pass the placeholder — the gate now treats an
        // unpriced estimate under active caps as needing confirmation, so it is
        // never a silent $0 wave-through.
        const effectiveModel = resolveEffectiveModel(agent, version ?? '', model) ?? `${agent}-default`;
        const gate = runPreflightGate({
          agent,
          model: effectiveModel,
          mode,
          prompt,
          project: cwd,
          cwd,
        });
        if (!gate.dormant) {
          if (!options.quiet) {
            process.stderr.write(chalk.gray(gate.banner + '\n'));
          }
          if (!gate.decision.allow) {
            // Hard block. --yes does NOT override (acceptance criterion).
            console.error(chalk.red(`[budget] BLOCKED: ${gate.decision.reason}`));
            console.error(chalk.gray(`Raise the cap in agents.yaml budget: or set on_exceed: warn to proceed.`));
            process.exit(2);
          }
          if (gate.decision.needsConfirm && !options.yes) {
            if (!process.stdin.isTTY) {
              // Non-interactive (CI/headless) and no --yes: cannot confirm — refuse.
              console.error(chalk.red(`[budget] ${gate.decision.reason}`));
              console.error(chalk.gray(`Re-run with --yes to confirm the spend, or lower require_confirm_over.`));
              process.exit(2);
            }
            const { confirm } = await import('@inquirer/prompts');
            const proceed = await confirm({
              message: `${gate.decision.reason}. Proceed?`,
              default: false,
            });
            if (!proceed) {
              console.error(chalk.yellow('[budget] aborted by user.'));
              process.exit(2);
            }
          } else if (gate.decision.blockedCap && gate.decision.allow && !options.quiet) {
            // on_exceed:warn overrun notice (allowed but reported).
            process.stderr.write(chalk.yellow(`[budget] WARN: ${gate.decision.reason}\n`));
          }
        }
      }

      const cmd = buildExecCommand(execOptions);
      if (!options.quiet) {
        process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));
      }

      // Remove the ephemeral mcp-config (and its temp dir) after the run. It is
      // written at mode 0o600 but still embeds server `env` (possibly tokens),
      // so it must not linger in tmp. Synchronous so it completes before exit.
      const cleanupWorkflowMcpConfig = () => {
        if (!workflowMcpConfigPath) return;
        try {
          fs.rmSync(path.dirname(workflowMcpConfigPath), { recursive: true, force: true });
        } catch {
          // best-effort: nothing actionable if the temp dir is already gone.
        }
      };

      // Restore the shared per-agent agents dir after the run (issue #401):
      // remove the workflow subagent files THIS run copied in, so a scoped
      // workflow never leaves definitions behind for the next, unrelated run to
      // inherit. Mirrors cleanupWorkflowMcpConfig — tear down only what we made.
      const cleanupWorkflowSubagents = () => {
        for (const target of workflowSubagentTargets) {
          try {
            fs.rmSync(target, { force: true });
          } catch {
            // best-effort: nothing actionable if the file is already gone.
          }
        }
      };

      // for_each dispatch (issue #343). A workflow that declares `for_each:` is a
      // declarative dynamic fan-out, not a single-agent run: execute the producer,
      // expand one stage teammate per produced item (+ optional verify panel),
      // stage them into a team, then drive the supervisor until the DAG drains.
      // This is mutually exclusive with the single-agent loop/fallback paths — the
      // fan-out IS the run.
      if (workflowForEach) {
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        const exitCode = await runWorkflowForEach(workflowForEach, {
          workflowName: rawAgent,
          cwd,
          effort: options.effort,
        });
        process.exit(exitCode);
      }

      // Loop dispatch (issue #332). Active when --loop is passed OR a workflow
      // declares a `loop:` block. The loop path runs AFTER the #346 pre-flight
      // gate above (which fired once) — the loop's token budget is an ADDITIONAL
      // guard, not a replacement. Composable, not bypassing.
      let loopConfig: import('../lib/loop.js').LoopConfig | undefined;
      try {
        loopConfig = buildLoopConfig(options, workflowLoop);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      if (loopConfig) {
        if (prompt === undefined) {
          console.error(chalk.red('--loop requires a prompt (or a workflow whose loop is paired with a prompt). The loop re-injects the prompt each iteration.'));
          process.exit(1);
        }
        if (options.interactive) {
          console.error(chalk.red('--loop is headless-only. The loop re-injects programmatically; an interactive TUI cannot be re-driven.'));
          process.exit(1);
        }
        if (fallback.length > 0) {
          console.error(chalk.red('--loop is not compatible with --fallback yet. Drop one.'));
          process.exit(1);
        }
        const { runLoop } = await import('../lib/loop.js');
        const { getRunsDir } = await import('../lib/state.js');
        const runId = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const runDir = path.join(getRunsDir(), runId);
        fs.mkdirSync(runDir, { recursive: true });
        process.stderr.write(chalk.gray(`[loop] run ${runId} — max ${loopConfig.maxIterations ?? '∞'}${loopConfig.budget ? `, budget ${loopConfig.budget} tokens` : ''}${loopConfig.until ? `, until ${loopConfig.until}` : ''}${loopConfig.interval ? `, interval ${loopConfig.interval}` : ''}\n`));
        try {
          const result = await runLoop({ ...execOptions, json: true, headless: true }, loopConfig, {
            runId,
            runDir,
            agent,
            version,
          });
          cleanupWorkflowMcpConfig();
          cleanupWorkflowSubagents();
          process.stderr.write(chalk.gray(`[loop] stopped: ${result.stoppedBy} after ${result.iterations} iteration(s), ${result.tokens} tokens (checkpoint: ${path.join(runDir, 'checkpoint.json')})\n`));
          // Governance chokepoint (#347): the --loop path exits here, bypassing
          // the normal finalize below — record its one audit entry.
          const loopExit = loopExitCode(result.stoppedBy);
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode: loopExit });
          // A loop is always headless; surface any commits it left unpushed
          // and any open PR left without a durable lander (RUSH-2394).
          if (shouldWarnUnpushed(mode, false)) {
            await warnUnpushedWork(cwd);
            await warnOrphanedOpenPr(cwd);
          }
          process.exit(loopExit);
        } catch (err) {
          cleanupWorkflowMcpConfig();
          cleanupWorkflowSubagents();
          console.error(chalk.red(`Loop failed for ${agent}: ${(err as Error).message}`));
          process.exit(1);
        }
      }

      // Agent footgun (RUSH-1829): a run with no prompt and no explicit
      // --interactive resolves to interactive intent, but in a non-TTY shell
      // (a headless agent, a pipe, CI) there is no terminal to host the REPL —
      // the TUI attaches to dead stdin and hangs forever. Fail fast with the
      // headless alternatives instead of launching a doomed interactive session.
      if (inferredInteractiveWithoutTty(execOptions, isInteractiveTerminal())) {
        // Tear down the workflow MCP config + subagents staged above before we
        // exit — same as every sibling exit path; requireInteractiveSelection
        // process.exits, so cleanup must happen first or it leaks.
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        requireInteractiveSelection(`Launching ${agent} interactively`, [
          `agents run ${agent} "<your task>"   # headless: prints the agent's result`,
          `agents run ${agent} --headless        # headless: reads the prompt from stdin`,
        ]);
      }

      try {
        let exitCode: number;
        let ranAgent = agent;
        let ranVersion = defaultVersion;
        if (fallback.length > 0 || (rotationResult !== null && prompt !== undefined && !options.interactive)) {
          // Fallback and balanced runs need captured output so a clean-exit
          // session-limit refusal can update account availability.
          // The sink reports which chain entry actually executed (may differ from
          // the primary after a rate-limit handoff) so the audit record is honest.
          const sink: { agent?: AgentId; version?: string } = {};
          exitCode = await runWithFallback({ ...execOptions, prompt: prompt!, fallback, dispatchSink: sink });
          ranAgent = sink.agent ?? agent;
          ranVersion = sink.version ?? defaultVersion;
        } else {
          exitCode = await execAgent(execOptions);
        }
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        // Surface committed-but-unpushed work a headless writable run left
        // behind, so it isn't silently stranded in a worktree. Also warn when
        // the branch still has an OPEN PR (RUSH-2394) — a background
        // `gh pr checks --watch` dies with the agent. Advisory only,
        // never throws; skipped for interactive runs (the human sees the shell)
        // and read-only plan mode (can't commit).
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
          await warnOrphanedOpenPr(cwd);
        }
        // Governance chokepoint (#347): every dispatched run finalizes here.
        // ONE tamper-evident audit record per run — non-fatal by contract.
        recordDispatchedRun({ agent: ranAgent, version: ranVersion ?? 'unknown', mode, cwd, exitCode });
        // First-successful-run star nudge (one-time, non-nagging). Only on a
        // clean run, and never when output is machine-readable/quiet.
        if (exitCode === 0) maybeShowStarNudge({ quiet: options.json || options.quiet });
        process.exit(exitCode);
      } catch (err) {
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        // An agent that committed then crashed is the case where stranded work
        // matters most — warn before exiting the error path too.
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
          await warnOrphanedOpenPr(cwd);
        }
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
