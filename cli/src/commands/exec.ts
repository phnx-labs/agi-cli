
import { InvalidArgumentError, Option, type Command } from 'commander';
import chalk from 'chalk';
import type { ExecOptions, ExecMode, ExecEffort, FallbackEntry } from '../lib/exec.js';
import { isTierToken } from '../lib/model-tiers.js';
import type { AgentId } from '../lib/types.js';
import { RUN_AUTO_KEYWORD } from '../lib/types.js';
import type { ResolvedRunDefaults } from '../lib/run-defaults.js';
import type { DeviceAutoApplyResult } from '../lib/smart-launch.js';
import { setHelpSections } from '../lib/help.js';
import { isInteractiveTerminal, isPromptCancelled, requireInteractiveSelection } from './utils.js';
import { isHumanFacingRun } from './run-account-picker.js';
import { getUserAgentsDir, readMeta } from '../lib/state.js';
import type { CrabboxBox } from '../lib/crabbox/cli.js';
import { parseLoopInterval } from '../lib/loop.js';
import type { RotateResult } from '../lib/accounting/rotate.js';
import { AGENTS, resolveAgentName, isAgentHardDeprecated, hardDeprecationError } from '../lib/agents.js';
import { parseAgentVersionSpec } from '../lib/agent-spec/agents.js';
import { recordDispatchedRun } from '../lib/audit/log.js';
import { recordRunAuthOutcome } from '../lib/auth-health.js';
import { maybeShowStarNudge } from '../lib/star-nudge.js';
import { warnUnpushedWork, shouldWarnUnpushed } from '../lib/warn-unpushed.js';
import { warnOrphanedOpenPr } from '../lib/pr-land-detach.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { isSessionTrackedAgent } from '@phnx-labs/sessions-cli/reader';
import { applyActiveRulesPresetAtRun } from '../lib/rules/run-sync.js';
import { applySystemResourcesAtRun } from '../lib/system-run-sync.js';
import { handleBroadcast } from './run-broadcast.js';
import { bootMark } from '../lib/boot-profile.js';

interface ExecCommandActionOptions {
  mode: ExecMode;
  effort: ExecEffort;
  model?: string;
  cwd?: string;
  project?: string;
  addDir: string[];
  env: string[];
  secrets: string[];
  autoSecrets?: boolean;
  json?: boolean;
  quiet?: boolean;
  headless?: boolean;
  interactive?: boolean;
  authCheck?: boolean;
  resume?: string | boolean;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  sessionId?: string;
  name?: string;
  notify?: boolean;
  traceSync?: boolean;
  terminal?: string | boolean;
  verbose?: boolean;
  raw?: boolean;
  tmux?: boolean;
  disableTmux?: boolean;
  timeout?: string;
  fallback?: string;
  balanced?: boolean;
  strategy?: string;
  account?: string;
  /**
   * @deprecated Hidden alias for `--device auto`. Resolved before host dispatch.
   * Remove after one release.
   */
  acp?: boolean;
  yes?: boolean;
  loop?: boolean;
  resumeCheckpoint?: string;
  maxIterations?: string;
  budget?: string;
  until?: string;
  interval?: string;
  where?: string;
  local?: boolean;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  remoteCwd?: string;
  follow?: boolean;
  any?: boolean;
  copyCreds?: boolean;
  lease?: string | boolean;
  box?: string;
  keepBox?: boolean;
  fresh?: boolean;
  reuse?: boolean;
  bare?: boolean;
  tailscale?: boolean;
  cloud?: boolean;
  provider?: string;
  repo?: string[];
  branch?: string;
  cloudEnv?: string;
  secretsKeys?: string;
  allowExpired?: boolean;
  emitSessionId?: boolean;
  broadcast?: boolean;
  task?: string;
  listTasks?: boolean;
  results?: string | true;
  concurrency?: string;
}

export function parseExplicitSessionId(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new InvalidArgumentError(
      'must contain only ASCII letters, digits, dots, underscores, or hyphens',
    );
  }
  return value;
}

export interface RunPickerMarkers {
  accountPicker: boolean;
  devicePicker: boolean;
  normalizedAgentSpec: string;
  valid: boolean;
  reason?: string;
}

export function parseRunPickerMarkers(agentSpec: string): RunPickerMarkers {
  let rest = agentSpec;
  let accountPicker = false;
  let devicePicker = false;
  let reason: string | undefined;
  while (rest.endsWith('#') || rest.endsWith('@')) {
    const marker = rest.endsWith('#') ? '#' : '@';
    if (marker === '#') {
      if (accountPicker && reason === undefined) reason = `the # picker marker may appear at most once in '${agentSpec}'`;
      accountPicker = true;
    } else {
      if (devicePicker && reason === undefined) reason = `the @ picker marker may appear at most once in '${agentSpec}'`;
      devicePicker = true;
    }
    rest = rest.slice(0, -1);
  }
  if (reason === undefined) {
    if (!rest) {
      reason = `'${agentSpec}' names no agent before the picker markers`;
    } else if (accountPicker && (rest.includes('@') || rest.includes('#'))) {
      reason = `an explicit pin in '${rest}' already selects what the # account picker chooses`;
    } else if (devicePicker && rest.includes('@')) {
      reason = `an explicit pin in '${rest}' cannot combine with the @ device picker`;
    }
  }
  return { accountPicker, devicePicker, normalizedAgentSpec: rest, valid: reason === undefined, reason };
}

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

export function pinLocalWhenTargetIsSelf(
  options: { host?: string; device?: string; on?: string; computer?: string; local?: boolean },
  isSelf: (name: string) => boolean,
): boolean {
  const targets = hostTargetGiven(options);
  if (targets.length === 0 || !targets.every(isSelf)) return false;
  options.host = undefined;
  options.device = undefined;
  options.on = undefined;
  options.computer = undefined;
  options.local = true;
  return true;
}

export function runAccountPickerConflicts(options: {
  resume?: string | boolean;
  strategy?: string;
  balanced?: boolean;
  lease?: string | boolean;
  box?: string;
  account?: string;
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
  if (options.account) conflicts.push(`--account ${options.account}`);
  return conflicts;
}

export function runDevicePickerConflicts(options: {
  lease?: string | boolean;
  box?: string;
  host?: string;
  device?: string;
  on?: string;
  computer?: string;
  local?: boolean;
}): string[] {
  const conflicts = hostTargetGiven(options).map((h) => `--device ${h}`);
  if (options.local) conflicts.push('--local');
  if (options.lease) conflicts.push('--lease');
  if (options.box) conflicts.push('--box');
  return conflicts;
}

function isValidAgent(agent: string): agent is AgentId {
  return agent in AGENTS;
}

export { RUN_AUTO_KEYWORD };

export function runAutoDefaultsToAffinity(
  options: { host?: string; device?: string; on?: string; computer?: string; local?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.local) return false;
  if (hostTargetGiven(options).length > 0) return false;
  if (env.AGENTS_RUN_AUTO_HOST_RESOLVED === '1') return false;
  return env.AGENTS_REMOTE_INTERACTIVE !== '1';
}

export function bareInteractiveRunDefaultsToDeviceAuto(
  options: {
    host?: string;
    device?: string;
    on?: string;
    computer?: string;
    resume?: string | boolean;
    lease?: string | boolean;
    box?: string;
    cloud?: boolean;
    local?: boolean;
  },
  run: { prompt?: string; devicePickerRequested?: boolean },
  surface: { tty: boolean; json?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (run.prompt !== undefined) return false;
  if (!isHumanFacingRun({ tty: surface.tty, json: surface.json === true })) return false;
  if (run.devicePickerRequested) return false;
  if (options.resume !== undefined || options.lease || options.box || options.cloud) return false;
  return runAutoDefaultsToAffinity(options, env);
}

export function hostInteractiveNeedsCorrelationId(
  runAgent: string,
  hostSessionId: string | undefined,
  resumeId: string | undefined,
): boolean {
  if (resumeId) return false;
  if (runAgent === RUN_AUTO_KEYWORD) return true;
  return !hostSessionId && isSessionTrackedAgent(runAgent);
}

function formatRotationBanner(result: RotateResult, verb: string = 'balanced'): string {
  const { picked, healthy, excluded } = result;
  const label = picked.email ? `${picked.email} · ${picked.agent}@${picked.version}` : `${picked.agent}@${picked.version}`;
  const ratio = `${healthy.length} of ${healthy.length + excluded.length} healthy`;
  const caveat = result.usageUnverified ? ', usage unverified — no account could be refreshed' : '';
  return `[agents] ${verb} picked ${label} (${ratio}${caveat})`;
}

export function isInsideGitWorkTree(cwd: string): boolean {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf-8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

export function gitToplevel(cwd: string): string | null {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function computeNetMode(opts: { tailscale?: boolean; reuseContext: boolean }): 'public' | 'tailscale' {
  if (opts.tailscale === false) return 'public';
  if (opts.tailscale === true) return 'tailscale';
  return opts.reuseContext ? 'tailscale' : 'public';
}


export function isAlwaysFreshRepo(repos: string[], repoRoot: string): boolean {
  return repos.includes(repoRoot);
}

export function addAlwaysFreshRepo(repos: string[], repoRoot: string): string[] {
  return repos.includes(repoRoot) ? repos : [...repos, repoRoot];
}

export function leaseFreshReposPath(): string {
  return path.join(getUserAgentsDir(), 'lease-fresh-repos.json');
}

export function readAlwaysFreshRepos(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(leaseFreshReposPath(), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function writeAlwaysFreshRepos(repos: string[]): void {
  try {
    const p = leaseFreshReposPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(repos, null, 2));
  } catch {
  }
}

export function buildLoopConfig(
  flags: { loop?: boolean; maxIterations?: string; budget?: string; until?: string; interval?: string },
  workflowLoop?: import('../lib/workflows.js').LoopConfigRaw,
): import('../lib/loop.js').LoopConfig | undefined {
  const active = flags.loop === true || workflowLoop !== undefined;
  if (!active) return undefined;

  const cfg: import('../lib/loop.js').LoopConfig = {};

  const until = flags.until ?? workflowLoop?.until;
  if (until !== undefined) {
    if (until !== 'signal') {
      throw new Error(`Invalid --until '${until}'. Only 'signal' is supported.`);
    }
    cfg.until = 'signal';
  }

  if (flags.maxIterations !== undefined) {
    const n = Number(flags.maxIterations);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid --max-iterations '${flags.maxIterations}'. Use a positive integer.`);
    }
    cfg.maxIterations = n;
  } else if (workflowLoop?.max_iterations !== undefined) {
    cfg.maxIterations = workflowLoop.max_iterations;
  }

  if (flags.budget !== undefined) {
    const b = Number(flags.budget);
    if (!Number.isFinite(b) || b <= 0) {
      throw new Error(`Invalid --budget '${flags.budget}'. Use a positive token count.`);
    }
    cfg.budget = b;
  } else if (workflowLoop?.budget !== undefined) {
    cfg.budget = workflowLoop.budget;
  }

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

export function loopExitCode(stoppedBy: import('../lib/loop.js').LoopStoppedBy): number {
  switch (stoppedBy) {
    case 'condition-met':
    case 'max':
      return 0;
    case 'budget':
      return 7;
    case 'signal':
      return 130;
    case 'stalled':
    case 'error':
    default:
      return 1;
  }
}

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

  const cap = runSpec.max_items ?? DEFAULT_FOR_EACH_CAP;
  const { truncated } = expandForEach(runSpec, items);
  if (truncated > 0) {
    process.stderr.write(chalk.yellow(
      `[for_each] producer emitted ${items.length} items; capping at ${cap} (${truncated} dropped). Raise \`max_items\` to fan out more.\n`,
    ));
  }
  process.stderr.write(chalk.gray(`[for_each] ${Math.min(items.length, cap)} stage teammate(s) from ${items.length} produced item(s)\n`));

  const team = `foreach-${opts.workflowName.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
  await createTeam(team, { description: `for_each fan-out from workflow '${opts.workflowName}'` });
  const mgr = new AgentManager();
  const { teammates } = await runForEach(mgr, team, runSpec, items, {
    cwd: opts.cwd,
    effort: opts.effort,
    concurrency: runSpec.concurrency,
  });

  const result = await runSupervisor(mgr, {
    team,
    onWave: (s) => {
      const ts = s.timestamp.slice(11, 19);
      process.stderr.write(
        `[${ts}] [for_each] wave ${s.wave}  launched=${s.launched.length}  running=${s.running}  pending=${s.pending}  done=${s.completed}  failed=${s.failed}\n`,
      );
    },
  });

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

export async function resolveRunCwd(
  options: Pick<ExecCommandActionOptions, 'cwd' | 'project' | 'remoteCwd' | 'addDir'>,
  opts: { forRemote: boolean },
): Promise<string | undefined> {
  if (!options.project) {
    if (!options.cwd || opts.forRemote) return options.cwd;
    const { expandLocalHome } = await import('../lib/project-root.js');
    return expandLocalHome(options.cwd);
  }
  if (options.cwd || options.remoteCwd) {
    console.error(chalk.red('Pass --project alone — not with --cwd or --remote-cwd.'));
    process.exit(1);
  }
  const { resolveProjectDirs } = await import('../lib/project-root.js');
  try {
    const { cwd, extraDirs } = await resolveProjectDirs(options.project, {
      forRemote: opts.forRemote,
    });
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

  const rawTarget = parseRunPickerMarkers(agentSpec).normalizedAgentSpec.split('#')[0].split('@')[0];
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
  if (hostTargetGiven(options).length) {
    const { RUN_OPTION_REJECT_MESSAGES } = await import('../lib/hosts/remote-cmd.js');
    console.error(chalk.red(RUN_OPTION_REJECT_MESSAGES.terminal));
    process.exit(1);
  }
  const streamFlag = options.json ? '--json' : options.emitSessionId ? '--emit-session-id' : undefined;
  if (streamFlag) {
    console.error(chalk.red(
      `${streamFlag} streams to stdout, but --terminal moves the run into a tab where you cannot read it. Drop one.`,
    ));
    process.exit(1);
  }

  const cwd = await resolveRunCwd(options, { forRemote: false });

  const { getActiveSessions } = await import('../lib/session/active.js');
  let sessions: Awaited<ReturnType<typeof toHostSamples>> = [];
  try {
    sessions = await toHostSamples(await getActiveSessions());
  } catch {
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

export function resumePickerOptionConflict(
  options: Pick<ExecCommandActionOptions, 'resume' | 'all' | 'teams' | 'since' | 'limit'>,
): string | undefined {
  const used = [
    options.all && '--all',
    options.teams && '--teams',
    options.since !== undefined && '--since',
    options.limit !== undefined && '--limit',
  ].filter(Boolean);
  if (used.length === 0 || options.resume === true || options.resume === '') return undefined;
  return `${used.join(', ')} only filter the session picker, so pass them with a bare --resume (no id), e.g. agents run claude --resume --all --since 7d.`;
}

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
    .option('--resume [id]', 'Resume a conversation with its account on the origin device. Omit the id for the shared session picker; #account filters the history. Pair an id with a prompt to continue headlessly.')
    .option('--all', 'With a bare --resume: list sessions from every directory, not just this project (also lifts the 30d window)')
    .option('--teams', 'With a bare --resume: include team-spawned sessions')
    .option('--since <time>', 'With a bare --resume: only sessions newer than this (default 30d; e.g. 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'With a bare --resume: maximum sessions loaded into the picker (default 200)')
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
      '--local',
      'Run on this machine. A bare interactive run otherwise places itself like --device auto; --local pins it here. Same as --where local or --device <this machine>.',
    )
    .option(
      '-D, --device <name>',
      'Offload this run onto another machine over SSH — a registered device, or user@host. Pass "auto" to pick the least-loaded reachable device where the requested agent is installed and signed in, keeping the run local when no remote is better, or "interactive" for the machine pinned as interactive.host (the box a human is sitting at). Naming this machine runs locally, no SSH. Same as --where device:<name>. See `agents devices`.',
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

  runCmd.addOption(new Option('--on <name>', 'Alias of --device.').hideHelp());
  runCmd.addOption(new Option('--computer <name>', 'Alias of --device.').hideHelp());

  runCmd.addOption(new Option('--emit-session-id', 'internal: print the resolved session id for a --device launcher to capture').hideHelp());

  runCmd.allowExcessArguments(true);

  setHelpSections(runCmd, {
    examples: `
      # Headless, read-only: investigate or summarize without writing files
      agents run claude "summarize recent git commits" --mode plan

      # Headless, can edit: have the agent make changes
      agents run claude "fix lint errors in src/" --mode edit

      # Interactive (TUI): a bare run places itself like --device auto (a fleet
      # worker, TUI forwarded over SSH); --local keeps it on this machine
      agents run claude
      agents run claude --local            # stay local (or pick this machine in claude@)

      # Pick a signed-in account/version for only this run (# = account picker)
      agents run claude#

      # Pick the device this run lands on (@ = device picker); this machine
      # first, offline rows disabled, fleet state aged in the prompt
      agents run claude@

      # Ask both, account first, then device — the run dispatches with the
      # picked account to the picked device
      agents run claude#@

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

      Pickers: a trailing # opens the account picker (agents run claude#) to
        choose one installed account for this run — rows show identity, login
        state, plan, and available limits; unsafe accounts stay visible but
        disabled. A trailing @ opens the device picker (agents run claude@);
        #@ asks both, account first, then device. The pickers cannot combine
        with an explicit pin of the same thing (--account, --device/--on/
        --computer/--host) or with --strategy/--balanced/--resume/--lease/--box.

      Interactive placement: a bare 'agents run <harness>' (no prompt, real TTY)
        places itself like --device auto — a fleet worker runs it, with the TUI
        forwarded over SSH. Headless runs (any prompt, --json, no TTY) are
        unchanged: they run in place. To stay on this machine, pass --local
        (--device <this machine> means the same), or pick this machine (listed
        first) in the '<harness>@' device picker. When placement finds no
        healthy device the run fails loud and names the local spelling.

      Fallback: --fallback codex,antigravity retries on rate-limit failure via /continue handoff. Each entry accepts @version.

      Cloud placement: --cloud sends the run to the agent's native vendor cloud
        (claude→rush, codex→codex, droid→factory, antigravity→antigravity) — the
        same dispatch as agents cloud run --agent <agent>, tracked by agents
        cloud list/status/logs/cancel/message. --provider overrides the routing;
        --repo/--branch/--cloud-env refine the task. Agents without a native
        cloud (kimi, grok, cursor, opencode, …) fail loud unless --provider is
        given. --cloud is mutually exclusive with --device/--lease and with
        local-run flags (--loop, --resume, --secrets, --terminal, …).

      Resume: --resume <id> resolves full IDs locally first, then fleet-wide, and recovers on the source device with its cwd/mode. Resume preserves the conversation account and uses the installed binary; starting a new conversation from archived context requires an explicit choice. agents sessions resume <id> infers the harness too. A bare --resume opens the session picker for the last 30 days of this project (up to 200 rows); --all widens it to every directory and lifts the 30d window, --teams adds team-spawned sessions, --since <time> and -n/--limit <n> set the window and row cap. These four only filter the picker: they are refused next to --resume <id> or without --resume.

      Passthrough: everything after -- is forwarded verbatim to the underlying agent CLI.
        agents run kimi -- --plan --some-native-flag value
    `,
  });

  runCmd.action(async (agentSpec: string | undefined, prompt: string | undefined, options: ExecCommandActionOptions, command: Command) => {
      bootMark('run-action:enter');
      const rawArgs: string[] = process.argv;
      const pickerConflict = resumePickerOptionConflict(options);
      if (pickerConflict) {
        console.error(chalk.red(pickerConflict));
        process.exit(1);
      }
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
        prompt = undefined;
      }

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

      if (options.terminal) {
        await handleTerminalHandoff(agentSpec, options, prompt);
        return;
      }

      {
        const { placementFromRunFlags, expandPlacementToRunFlags, PlacementError } =
          await import('../lib/placement.js');
        try {
          const placement = placementFromRunFlags(options);
          if (placement.kind === 'local' && placement.source !== 'default') options.local = true;
          if (options.where) {
            const expanded = expandPlacementToRunFlags(placement);
            if (expanded.host !== undefined) options.host = expanded.host;
            if (expanded.device !== undefined) options.device = expanded.device;
            if (expanded.lease !== undefined) options.lease = expanded.lease;
            if (expanded.box !== undefined) options.box = expanded.box;
            if (expanded.cloud !== undefined) options.cloud = expanded.cloud;
            if (expanded.provider !== undefined) options.provider = expanded.provider;
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

      {
        const { isSelfHost } = await import('../lib/devices/self-host.js');
        const { isDeviceInteractive, resolveInteractiveDevice } = await import('../lib/devices/interactive-host.js');
        pinLocalWhenTargetIsSelf(options, (name) =>
          isSelfHost(isDeviceInteractive(name) ? resolveInteractiveDevice() ?? name : name));
      }

      if (!options.cloud) {
        const { cloudFlagsWithoutCloud } = await import('./run-cloud.js');
        const stray = cloudFlagsWithoutCloud(options as unknown as Record<string, unknown>);
        if (stray.length > 0) {
          console.error(chalk.red(`${stray.join(', ')} ${stray.length > 1 ? 'require' : 'requires'} --cloud (vendor cloud placement).`));
          process.exit(1);
        }
      }

      if (options.cloud) {
        const { handleRunCloud } = await import('./run-cloud.js');
        await handleRunCloud(agentSpec, prompt, options as unknown as Record<string, unknown>, command);
        return;
      }

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

      const pickerMarkers = parseRunPickerMarkers(agentSpec);
      const accountPickerRequested = pickerMarkers.accountPicker;
      const devicePickerRequested = pickerMarkers.devicePicker;
      let normalizedAgentSpec = pickerMarkers.normalizedAgentSpec;
      if (!pickerMarkers.valid) {
        console.error(chalk.red(
          `Invalid run picker target: ${agentSpec}. ` +
          `${pickerMarkers.reason ?? 'unrecognized picker markers'}. ` +
          'Use agents run <agent># to pick an account, <agent>@ to pick a device, <agent>#@ for both.',
        ));
        process.exit(1);
      }
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

      if (options.resume === true || options.resume === '') {
        if (options.sessionId || options.loop || options.fallback || options.resumeCheckpoint || options.lease) {
          throw new Error('--resume cannot be combined with --session-id, --loop, --fallback, --resume-checkpoint, or --lease.');
        }
        const { sessionsResumeAction } = await import('./sessions-resume.js');
        const { toRemotePortable } = await import('../lib/project-root.js');
        const device = options.host || options.device || options.on || options.computer;
        await sessionsResumeAction(undefined, prompt, {
          agent: normalizedAgentSpec.split('#')[0] === RUN_AUTO_KEYWORD ? undefined : normalizedAgentSpec.split('#')[0],
          account: options.account,
          model: options.model,
          mode: command.getOptionValueSource('mode') === 'default' ? undefined : options.mode,
          interactive: options.interactive,
          headless: options.headless,
          cwd: device ? options.remoteCwd ?? (options.cwd ? toRemotePortable(options.cwd) : undefined) : options.cwd,
          quiet: options.quiet,
          device,
          all: options.all,
          teams: options.teams,
          since: options.since,
          limit: options.limit,
          runArgs: rawArgs.slice(2),
        });
        return;
      }

      const runBaseAgentName = normalizedAgentSpec.split('#')[0].split('@')[0];
      const runBaseAgentId = resolveAgentName(runBaseAgentName);
      const { profileExists: runProfileExists } = await import('../lib/profiles.js');
      if (runBaseAgentId && !runProfileExists(runBaseAgentName) && isAgentHardDeprecated(runBaseAgentId)) {
        console.error(chalk.red(hardDeprecationError(runBaseAgentId)));
        process.exit(1);
      }

      if (accountPickerRequested) {
        const conflicts = runAccountPickerConflicts(options);
        if (conflicts.length > 0) {
          console.error(chalk.red(
            `Account selection with ${agentSpec} cannot be combined with ${conflicts.join(', ')}. ` +
            'Remove the conflicting selector, or pin the target explicitly (agent@version or agent#label).',
          ));
          process.exit(1);
        }
      }
      if (devicePickerRequested) {
        const conflicts = runDevicePickerConflicts(options);
        if (conflicts.length > 0) {
          console.error(chalk.red(
            `Device selection with ${agentSpec} cannot be combined with ${conflicts.join(', ')}. ` +
            'Remove one — the picker already chooses where the run lands.',
          ));
          process.exit(1);
        }
      }

      if (normalizedAgentSpec.split('#')[0].split('@')[0] === RUN_AUTO_KEYWORD && normalizedAgentSpec !== RUN_AUTO_KEYWORD) {
        console.error(chalk.red(
          `agents run auto picks the harness itself — a @version pin does not apply. ` +
          `Pin a concrete harness instead: agents run <harness>@<version>.`,
        ));
        process.exit(1);
      }
      let autoHarnessRequested = normalizedAgentSpec === RUN_AUTO_KEYWORD;
      let resolvedResumeSource: import('@phnx-labs/sessions-cli/reader').SessionMeta | undefined;
      let resolvedRecoveryTarget: import('../lib/session/recovery.js').SessionRecoveryTarget | undefined;

      if (typeof options.resume === 'string' && options.resume.trim()) {
        const selector = options.resume.trim();
        const injectedSource = (() => {
          try {
            const parsed = JSON.parse(process.env.AGENTS_RESUME_SOURCE_JSON ?? 'null');
            return parsed?.id === selector ? parsed as import('@phnx-labs/sessions-cli/reader').SessionMeta : undefined;
          } catch {
            return undefined;
          }
        })();
        delete process.env.AGENTS_RESUME_SOURCE_JSON;
        const outcome = injectedSource
          ? { kind: 'resolved' as const, session: injectedSource }
          : await (await import('./sessions.js')).resolveSessionMetadataValue(selector, { agent: runBaseAgentId ?? undefined });
        if (outcome.kind === 'partial') {
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

        const [requestedAgent] = normalizedAgentSpec.split('#')[0].split('@');
        if (!autoHarnessRequested && requestedAgent !== resolvedResumeSource.agent) {
          console.error(chalk.red(
            `Session ${resolvedResumeSource.shortId} belongs to ${resolvedResumeSource.agent}, not ${requestedAgent}. ` +
            `Use: agents sessions resume ${resolvedResumeSource.id}`,
          ));
          process.exit(1);
        }


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
        const explicitPlacement = hostTargetGiven(options).length > 0 || options.local === true;
        if (sourcePeer && !explicitPlacement) {
          options.host = sourcePeer;
        } else if (sourcePeer && explicitPlacement && !hostTargetGiven(options).some((host) =>
          sessionRecoveryDestinationMatches(resolvedResumeSource!, host))) {
          console.error(chalk.red(
            `Session ${resolvedResumeSource.shortId} must recover on ${sourcePeer}, where its conversation state is stored; ` +
            `the requested device was ${hostTargetGiven(options).join(', ') || 'this machine'}.`,
          ));
          process.exit(1);
        }

        const sourceAgent = resolvedResumeSource.agent as AgentId;
        if (!sourcePeer) {
          try {
            const { resolveSessionRecovery } = await import('../lib/session/recovery.js');
            resolvedRecoveryTarget = await resolveSessionRecovery(resolvedResumeSource, undefined, { account: options.account, model: options.model ?? resolvedResumeSource.model });
          } catch (err) {
            console.error(chalk.red((err as Error).message));
            process.exit(1);
          }
          normalizedAgentSpec = `${resolvedRecoveryTarget.agent}@${resolvedRecoveryTarget.version}`;
          autoHarnessRequested = false;
          if (!options.quiet) process.stderr.write(chalk.gray(
            `[agents] session recovery → ${resolvedRecoveryTarget.mode} ${resolvedRecoveryTarget.agent} on ${sourceMachine ?? machineId()} · ${resolvedRecoveryTarget.reason}\n`,
          ));
        } else if (autoHarnessRequested) {
          normalizedAgentSpec = sourceAgent;
          autoHarnessRequested = false;
        }
      }
      if (autoHarnessRequested) {
        if (RUN_AUTO_KEYWORD in AGENTS) {
          console.error(chalk.red(
            `'${RUN_AUTO_KEYWORD}' is now a registered harness and collides with the reserved 'run auto' keyword. ` +
            `Run the harness by name instead.`,
          ));
          process.exit(1);
        }
        if (accountPickerRequested) {
          console.error(chalk.red(
            `agents run auto picks the harness and account itself — the trailing-# account picker needs a concrete harness (agents run <harness>#).`,
          ));
          process.exit(1);
        }
        if (devicePickerRequested) {
          console.error(chalk.red(
            `agents run auto picks the harness and its placement itself — the trailing-@ device picker needs a concrete harness (agents run <harness>@).`,
          ));
          process.exit(1);
        }
        if (!resolvedResumeSource && runAutoDefaultsToAffinity(options)) options.device = 'auto';
      }

      let upFrontAccountPick: import('../lib/accounting/rotate.js').RotateCandidate | null = null;
      if (accountPickerRequested && devicePickerRequested) {
        const baseName = normalizedAgentSpec.split('#')[0].split('@')[0];
        const baseAgentId = resolveAgentName(baseName);
        const { profileExists: baseProfileExists } = await import('../lib/profiles.js');
        if (!baseAgentId || baseProfileExists(baseName)) {
          console.error(chalk.red(
            baseProfileExists(baseName)
              ? `Account selection is not available for custom harness '${baseName}'. Run its concrete host agent with # instead.`
              : `Account selection is not available for '${baseName}'. Run a concrete agent with # instead.`,
          ));
          process.exit(1);
        }
        const { supportsAccountInspection: baseSupportsInspection, agentLabel: baseAgentLabel, ACCOUNT_INSPECTION_AGENT_IDS: inspectionAgentIds } = await import('../lib/agents.js');
        if (!baseSupportsInspection(baseAgentId)) {
          console.error(chalk.red(
            `${baseAgentLabel(baseAgentId)} does not expose local account state, so agents-cli cannot safely select an account.`,
          ));
          console.error(chalk.gray(
            `Supported account pickers: ${inspectionAgentIds.join(', ')}`,
          ));
          process.exit(1);
        }
        const { pickRunAccountCandidate } = await import('./run-account-picker.js');
        const selected = await pickRunAccountCandidate(baseAgentId);
        if (!selected) return;
        if (selected.nativeAccount) options.account = selected.nativeAccount;
        upFrontAccountPick = selected;
        if (!options.quiet) {
          const identity = selected.accountLabel || 'signed-in account';
          process.stderr.write(chalk.gray(
            `[agents] selected ${identity} · ${baseAgentId}@${selected.version} for this run\n`,
          ));
        }
      }
      if (devicePickerRequested) {
        const impliedHost = hostTargetGiven(options);
        if (impliedHost.length > 0) {
          console.error(chalk.red(
            `Device selection with ${agentSpec} cannot be combined with the placement --resume already chose (${impliedHost.join(', ')}). ` +
            'Remove one — both pick where the run lands.',
          ));
          process.exit(1);
        }
        const { pickRunDevice } = await import('./run-device-picker.js');
        const baseName = normalizedAgentSpec.split('#')[0].split('@')[0];
        const pickedDevice = await pickRunDevice({
          agent: (resolveAgentName(baseName) ?? baseName) as AgentId,
          accountLabel: options.account,
        });
        if (pickedDevice === null) return;
        const { isSelfHost } = await import('../lib/devices/self-host.js');
        if (!isSelfHost(pickedDevice)) options.device = pickedDevice;
      }

      const defaultPlacement = bareInteractiveRunDefaultsToDeviceAuto(
        options,
        { prompt, devicePickerRequested },
        { tty: isInteractiveTerminal(), json: options.json },
      );
      if (defaultPlacement) options.device = 'auto';

      {
        const { applyDeviceAutoToOptions } = await import('../lib/smart-launch.js');
        let result: DeviceAutoApplyResult;
        try {
          result = await applyDeviceAutoToOptions(options, {
            accountPickerRequested,
            agent: normalizedAgentSpec.split('#')[0].split('@')[0] === RUN_AUTO_KEYWORD
              ? undefined
              : (resolveAgentName(normalizedAgentSpec.split('#')[0].split('@')[0]) ?? undefined),
          });
        } catch (err) {
          if (!defaultPlacement) throw err;
          console.error(chalk.red((err as Error).message));
          console.error(chalk.gray(
            `Run here instead: agents run ${runBaseAgentName} --local`,
          ));
          process.exit(1);
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

        const { resolveLeaseBundle } = await import('../lib/crabbox/cli.js');
        if (options.lease && !resolveLeaseBundle()) {
          const { runLeaseSetup } = await import('./lease.js');
          const ok = await runLeaseSetup({ provider: backend ?? 'hetzner' });
          if (!ok) {
            console.error(chalk.yellow('Leasing needs a cloud provider set up. Run `agents devices lease setup` and retry.'));
            process.exit(1);
          }
        }

        const leaseSecretsBundle = process.env.AGENTS_LEASE_SECRETS_BUNDLE;
        const nowSecs = Math.floor(Date.now() / 1000);
        let reuseSlug: string | undefined = options.box;

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
            warm = [];
          }

          const alwaysFresh = repoRoot ? isAlwaysFreshRepo(readAlwaysFreshRepos(), repoRoot) : false;

          if (warm.length > 0 && !alwaysFresh) {
            if (options.reuse) {
              reuseSlug = warm[0].slug;
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
          } else if (options.reuse && warm.length > 0) {
            reuseSlug = warm[0].slug;
          }
        }

        const reuseContext = !!reuseSlug || !!options.reuse;
        let netMode = computeNetMode({ tailscale: options.tailscale, reuseContext });
        const copySetup = !options.bare;

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
        assertNoNativeOAuthTransfer(credentialRuntimes, detected);

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

        const { createLeaseOutputRouter, createSpinner, renderStepLine } = await import('../lib/crabbox/progress.js');
        const spinner = createSpinner({ stream: process.stderr });
        let warmupTimer: ReturnType<typeof setInterval> | undefined;
        const stopTimer = () => { if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = undefined; } };

        const jsonMode = options.json === true;
        const stepsTty = Boolean(process.stderr.isTTY) && !jsonMode;
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
          onSetupLine: () => {},
          onStep: (step) => {
            flushStep(step.elapsedMs);
            activeStep = step;
            if (stepsTty) spinner.start(renderStepLine(step));
          },
          onAgentChunk: (chunk) => {
            flushStep();
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

      const hostGiven = hostTargetGiven(options);

      if (
        prompt !== undefined &&
        hostGiven.length === 0 &&
        !options.lease &&
        !options.box
      ) {
        const { armRunFinishTraceSync } = await import('../lib/run-trace-sync.js');
        armRunFinishTraceSync({ disabled: options.traceSync === false });
      }

      options.cwd = await resolveRunCwd(options, { forRemote: hostGiven.length > 0 });

      if (hostGiven.length > 0) {
        if (new Set(hostGiven).size > 1) {
          console.error(chalk.red('Conflicting --device values values — pass just one.'));
          process.exit(1);
        }
        const hostName = hostGiven[0];
        const { resolveHostRunTarget, resolveHostSessionId, dispatchPromptToHost, HostResolutionError } = await import('../lib/hosts/run-target.js');
        const { runInteractiveOnHost } = await import('../lib/hosts/dispatch.js');
        const { registerInteractiveHostSession } = await import('../lib/hosts/session-index.js');
        const { RUN_OPTION_REJECT_MESSAGES } = await import('../lib/hosts/remote-cmd.js');
        const { normalizeRunStrategy, RUN_STRATEGIES } = await import('../lib/accounting/rotate.js');

        const hostRejects: string[] = [];
        if (options.secrets.length > 0) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.secrets);
        if (options.secretsKeys) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.secretsKeys);
        if (options.allowExpired) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.allowExpired);
        if (options.resumeCheckpoint) hostRejects.push(RUN_OPTION_REJECT_MESSAGES.resumeCheckpoint);
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
          const runVersion = rawRunVersion || undefined;

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

          const { toRemotePortable } = await import('../lib/project-root.js');
          const { deriveMirroredCwd } = await import('../lib/hosts/dispatch.js');
          const explicitHostCwd = options.remoteCwd ?? (options.cwd ? toRemotePortable(options.cwd) : undefined);
          const hostCwd = explicitHostCwd ?? deriveMirroredCwd(process.cwd());
          const mirrorHostCwd = explicitHostCwd === undefined;
          const hostAddDirs = options.addDir.length > 0 ? options.addDir.map(toRemotePortable) : undefined;
          const resumeId = typeof options.resume === 'string' ? options.resume : undefined;

          let hostCopyCreds: undefined;

          if (options.interactive && options.headless) {
            console.error(chalk.red('--interactive and --headless are mutually exclusive. Pass one, or neither (mode is inferred from prompt presence).'));
            process.exit(1);
          }
          const interactiveHost = options.interactive === true || (prompt === undefined && options.headless !== true);

          if (accountPickerRequested && !upFrontAccountPick && !interactiveHost) {
            console.error(chalk.red(
              `Account selection with ${agentSpec} requires an interactive host run. ` +
              `Use agents run ${runAgent}# --device ${host.name} --interactive.`,
            ));
            process.exit(1);
          }

          if (interactiveHost) {
            if (options.follow === false) {
              console.error(chalk.red('--no-follow is not compatible with interactive host runs. Interactive runs are attached by definition.'));
              process.exit(1);
            }
            const hostSessionId = resolveHostSessionId(runAgent, resumeId, options.sessionId);
            const correlationLaunchId =
              hostInteractiveNeedsCorrelationId(runAgent, hostSessionId, resumeId) ? randomUUID() : undefined;
            const hostEnv = correlationLaunchId
              ? [...options.env, `AGENT_LAUNCH_ID=${correlationLaunchId}`]
              : options.env;
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
              accountPicker: accountPickerRequested && !upFrontAccountPick,
              strategy: resumeId ? undefined : runStrategy,
              account: options.account,
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
            let resolvedRemoteId: string | undefined;
            if (correlationLaunchId) {
              const { resolveRemoteSessionId } = await import('../lib/hosts/remote-session-id.js');
              const { sshTargetFor } = await import('../lib/hosts/types.js');
              try {
                resolvedRemoteId = resolveRemoteSessionId(sshTargetFor(host), correlationLaunchId);
              } catch {
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
            const { pickReconnectTarget, reconnectInteractiveSession, afterInteractiveRemoteExit, SSH_CONN_FAILURE } = await import('../lib/hosts/reconnect.js');
            const reconnectTarget = pickReconnectTarget({
              agent: runAgent,
              sessionId: hostSessionId,
              resolvedId: resolvedRemoteId,
              resumeId,
              launchId: correlationLaunchId,
            });
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

          if (prompt === undefined) {
            console.error(chalk.red('A prompt is required for headless host runs: agents run <agent> "<task>" --device <name>'));
            process.exit(1);
          }
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
            account: options.account,
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
            const handle = task.name ?? task.id;
            console.log(
              chalk.green(`Dispatched to ${host.name}${task.name ? ` as "${task.name}"` : ''}.`) + '\n' +
              chalk.gray(`  Status:  agents sessions ${handle}`) + chalk.gray('   (compact digest — use this)') + '\n' +
              chalk.gray(`  Raw log: agents logs ${handle} -f`) + chalk.gray('   (heavy, only if needed)'),
            );
            process.exit(0);
          }
          if (exitCode === -1) process.exit(0);
          process.exit(exitCode ?? 1);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
      }

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
        const resumeExit = loopExitCode(result.stoppedBy);
        recordDispatchedRun({
          agent: cp.agent,
          version: cp.version ?? 'unknown',
          mode: resumeExec.mode ?? 'auto',
          cwd: resumeExec.cwd ?? process.cwd(),
          exitCode: resumeExit,
        });
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
        { readAndResolveBundleEnv, describeBundle, remoteResolveEnv },
        { assertRemoteBundleFlagsUnsupported, splitBundleRef, resolveSecretsContextForRun },
        { resolveHostSshTarget },
        { getConfiguredRunStrategy, normalizeRunStrategy, resolveRunVersion, rotationFailoverChain, DEFAULT_ROTATION_FAILOVER_LIMIT, shouldArmRotationFailover, preflightFallbackHandoff, preflightHandoffEligible, RUN_STRATEGIES, collectHarnessCandidates, pickHarnessWeighted, classifyHarnessCandidates, formatHarnessPickBanner, formatNoHealthyHarnessError, formatNoHealthyAccountError, formatNoVerifiedUsageError, signInRecoverableCandidates },
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
        import('../lib/share-runtime.js'),
      ]);
      bootMark('run-deps:imported');
      const isValidAgent = (agent: string): agent is AgentId => ALL_AGENT_IDS.includes(agent as AgentId);

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
      let profileProvider: string | undefined;
      let fromProfile = false;
      let profileName: string | undefined;
      let profileFallbackModel: { envKey: string; model: string } | undefined;
      let workflowModel: string | undefined;
      let workflowToolsRestrict: string[] | undefined;
      let workflowMcpConfigPath: string | undefined;
      const workflowSubagentTargets: string[] = [];
      let workflowLoop: import('../lib/workflows.js').LoopConfigRaw | undefined;
      let workflowForEach: import('../lib/workflows.js').ForEachSpec | undefined;
      let workflowHasSubagents = false;
      const cwd = options.cwd ?? process.cwd();

      if (accountPickerRequested && profileExists(rawAgent)) {
        console.error(chalk.red(
          `Account selection is not available for custom harness '${rawAgent}'. Run its concrete host agent with # instead.`,
        ));
        process.exit(1);
      }
      if (accountPickerRequested && !isValidAgent(rawAgent)) {
        if (resolveWorkflowRef(rawAgent, cwd)) {
          console.error(chalk.red(
            `Account selection is not available for workflow '${rawAgent}'. Run a concrete agent with # instead.`,
          ));
          process.exit(1);
        }
      }

      if (autoHarnessRequested) {
        const byHarness = await collectHarnessCandidates();
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
        if (options.sessionId && agent !== 'claude' && !options.quiet) {
          process.stderr.write(chalk.yellow(`[agents] --session-id ignored: auto picked ${agent} (only claude accepts a forced session id)\n`));
        }
      } else if (profileExists(rawAgent)) {
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

        // allowedAgents copies only named definitions; an explicit empty list means none, and pruning touches only managed copies.
        const subagentsDir = path.join(workflowDir, 'subagents');
        const allowedAgents = workflowFrontmatter?.allowedAgents;
        if (fs.existsSync(subagentsDir)) {
          fs.mkdirSync(claudeAgentsDir, { recursive: true });
          const allFiles = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md'));
          const { allowedStems, missing } = resolveAllowedSubagents(allFiles, allowedAgents);
          const allowStemSet = new Set(allowedStems);
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
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] allowedAgents not found in subagents/: ${missing.join(', ')}\n`));
            }
            process.stderr.write(chalk.gray(`[workflow] subagents restricted to allowedAgents: copied ${copied}, withheld ${skipped}\n`));
          }
        }

        const workflowMd = path.join(workflowDir, 'WORKFLOW.md');
        const orchestratorBody = fs.existsSync(workflowMd)
          ? fs.readFileSync(workflowMd, 'utf-8').replace(/^---[\s\S]*?---\n/, '').trim()
          : '';
        if (orchestratorBody && prompt !== undefined) {
          prompt = `${orchestratorBody}\n\n---\n\n${prompt}`;
        }

        const workflowSkillsDir = path.join(workflowDir, 'skills');
        if (fs.existsSync(workflowSkillsDir)) {
          const skillsTarget = path.join(claudeAgentsDir, '..', 'skills');
          fs.mkdirSync(skillsTarget, { recursive: true });
          for (const entry of fs.readdirSync(workflowSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            fs.cpSync(path.join(workflowSkillsDir, entry.name), path.join(skillsTarget, entry.name), { recursive: true });
          }
        }

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
            workflowToolsRestrict = ensureSubagentDispatchTool(tools, workflowHasSubagents);
            process.stderr.write(chalk.gray(`[workflow] restricting available tools to: ${workflowToolsRestrict.join(', ')} (Write/Bash/Edit unavailable unless listed)\n`));
            if (workflowToolsRestrict.length !== tools.length) {
              process.stderr.write(chalk.gray(`[workflow] kept Task tool: workflow ships subagents to dispatch\n`));
            }
          }
          // Named MCP scope always writes strict config, even when no name resolves, so ambient servers cannot leak into the workflow.
          if (mcpServerNames && mcpServerNames.length > 0) {
            const servers = getMcpServersByName(mcpServerNames, { cwd });
            const found = new Set(servers.map(s => s.name));
            const missing = mcpServerNames.filter(n => !found.has(n));
            if (missing.length > 0) {
              process.stderr.write(chalk.yellow(`[workflow] mcpServers not found in registry, skipped: ${missing.join(', ')}\n`));
            }
            const mcpConfig = buildWorkflowMcpConfig(servers);
            const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-workflow-mcp-'));
            workflowMcpConfigPath = path.join(configDir, 'mcp-config.json');
            fs.writeFileSync(workflowMcpConfigPath, mcpConfig, { mode: 0o600 });
            if (servers.length > 0) {
              process.stderr.write(chalk.gray(`[workflow] scoping MCP servers to ONLY: ${servers.map(s => s.name).join(', ')}\n`));
            } else {
              process.stderr.write(chalk.yellow(`[workflow] no declared mcpServers resolved — scoping run to NO MCP servers (fail-closed)\n`));
            }
          }
        }

        const subagentCount = fs.existsSync(subagentsDir)
          ? resolveAllowedSubagents(
              fs.readdirSync(subagentsDir).filter(f => f.endsWith('.md')),
              allowedAgents,
            ).allowedStems.length
          : 0;
        process.stderr.write(chalk.gray(`Workflow '${rawAgent}' → claude (${subagentCount} subagents)\n`));
      } else {
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

      if (accountPickerRequested && !upFrontAccountPick) {
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
      if (upFrontAccountPick) {
        version = upFrontAccountPick.version;
        if (upFrontAccountPick.slotDir) execHome = upFrontAccountPick.slotDir;
      }

      version = resolveVersionAlias(agent, version);

      const { resolveSpawnAccount } = await import('../lib/account-registry.js');
      let spawnAccount: import('../lib/account-registry.js').SpawnAccount | null = null;
      let launchAccount: import('../lib/accounting/account-launch.js').ResolvedLocalAccountLaunch | undefined;
      if (resolvedRecoveryTarget) {
        const { resolveLocalAccountLaunch } = await import('../lib/accounting/account-launch.js');
        launchAccount = await resolveLocalAccountLaunch({
          agent,
          executableVersion: resolvedRecoveryTarget.version,
          candidate: resolvedRecoveryTarget.candidate,
          useDefault: false,
        });
        execHome = resolvedRecoveryTarget.mode === 'native' ? (resolvedRecoveryTarget.execHome ?? launchAccount.execHome) : launchAccount.execHome;
        accountConfigVersion = resolvedRecoveryTarget.mode === 'native' ? (resolvedRecoveryTarget.configVersion ?? launchAccount.configVersion) : launchAccount.configVersion;
        accountEnv = { ...accountEnv, ...launchAccount.env };
      } else {
        const bindingTarget = fromProfile ? rawAgent : (version ? `${agent}@${version}` : `${agent}@${getGlobalDefault(agent) ?? ''}`);
        try {
          spawnAccount = resolveSpawnAccount(options.account, agent, version, readMeta(), { useDefault: !fromProfile, provider: profileProvider, target: bindingTarget });
        } catch (err) { console.error(chalk.red((err as Error).message)); process.exit(1); }
        if (spawnAccount) {
          if (options.cloud || options.provider || options.lease) {
            console.error(chalk.red('--account selects a device-local credential and cannot be combined with cloud or lease placement.'));
            process.exit(1);
          }
          if (spawnAccount.kind === 'native') {
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
                const durable = durableSlotEnv(agent, spawnAccount, resolved, meta);
                if (Object.keys(durable).length > 0) accountEnv = { ...accountEnv, ...durable };
                if (resolved.source === 'legacy-home') {
                  accountConfigVersion = resolved.label;
                  if (!version && !fromProfile && resolved.label) version = resolved.label;
                }
              } catch (err) {
                console.error(chalk.red((err as Error).message));
                process.exit(1);
              }
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

      }
      const configuredAccount = launchAccount?.account?.name ?? spawnAccount?.name;

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

        const { buildContinuePrompt } = await import('../lib/loop.js');
        const session = resolvedResumeSource;
        if (!session || !resolvedRecoveryTarget) {
          throw new Error('Session recovery did not resolve a conversation on this device.');
        }
        if (!options.cwd) options.cwd = resolvedRecoveryTarget.mode === 'native'
          ? resolvedRecoveryTarget.cwd ?? session.cwd
          : session.cwd;
        forceInteractive = resolveInteractive({ interactive: options.interactive, headless: options.headless, prompt });
        if (resolvedRecoveryTarget.agent !== agent) {
          console.error(chalk.red(
            `Session ${session.shortId} belongs to ${resolvedRecoveryTarget.agent}, not ${agent}. ` +
            `Use: agents run auto --resume ${session.id}`,
          ));
          process.exit(1);
        }
        version = resolvedRecoveryTarget.version;
        if (resolvedRecoveryTarget.mode === 'native') {
          resumeNative = true;
          resumeSessionId = session.id;
          if (!options.cwd && resolvedRecoveryTarget.cwd) options.cwd = resolvedRecoveryTarget.cwd;
          if (!options.quiet) process.stderr.write(chalk.gray(
            `Resuming ${agent} ${session.shortId} (native) in ${options.cwd ?? cwd}\n`,
          ));
        } else {
          if (!isInteractiveTerminal() || options.headless) {
            console.error(chalk.red(`Native resume is unavailable: ${resolvedRecoveryTarget.reason}. To start a new conversation with this context, explicitly run: agents run ${agent} "/continue ${session.id}"`));
            process.exit(1);
          }
          const { confirm } = await import('@inquirer/prompts');
          const replay = await confirm({ message: `${resolvedRecoveryTarget.reason}. Start a new conversation using this transcript?`, default: false }).catch(() => false);
          if (!replay) return;
          prompt = buildContinuePrompt(session.id, prompt);
          if (prompt.trim() === `/continue ${session.id}`) forceInteractive = true;
          if (!options.quiet) process.stderr.write(chalk.gray(`Resuming ${agent} ${session.shortId} (/continue replay)\n`));
        }
      }

      const configuredStrategy = getConfiguredRunStrategy(agent, cwd);
      const explicitStrategy = options.strategy ? normalizeRunStrategy(options.strategy) : null;
      let rotationResult: import('../lib/accounting/rotate.js').RotateResult | null = null;
      let handoffRunDefaults: ResolvedRunDefaults | undefined;
      let launchSignedIn: boolean | null | undefined;
      let launchEmail: string | null | undefined;
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

      const applyPickedCandidate = async (candidate: import('../lib/accounting/rotate.js').RotateCandidate): Promise<void> => {
        if (!candidate.nativeAccount || options.host || options.device) return;
        const { resolveLocalAccountLaunch } = await import('../lib/accounting/account-launch.js');
        try {
          launchAccount = await resolveLocalAccountLaunch({
            agent,
            executableVersion: version ?? candidate.version,
            candidate,
            useDefault: false,
          });
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          process.exit(1);
        }
        if (launchAccount.execHome) execHome = launchAccount.execHome;
        if (launchAccount.configVersion) accountConfigVersion = launchAccount.configVersion;
        if (Object.keys(launchAccount.env).length > 0) accountEnv = { ...accountEnv, ...launchAccount.env };
      };
      preflight: for (;;) {
      if (!accountPickerRequested && !configuredAccount && (!version || strategy !== 'pinned' || options.balanced || explicitStrategy)) {
        if (version) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: version ${version} is pinned\n`));
        } else if (fromProfile) {
          process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} ignored: custom harness pins its own version/auth\n`));
        } else {
          try {
            const { collectRunCandidatesForRun } = await import('../lib/accounting/account-pool-collect.js');
            bootMark('resolve-version:start');
            const routingModel = options.model ?? resolvedResumeSource?.model ?? workflowModel
              ?? (options.fallback ? undefined : resolveRunDefaults(agent, resolveVersion(agent, cwd), cwd).model);
            const resolved = await resolveRunVersion(agent, strategy, cwd, collectRunCandidatesForRun, routingModel);
            bootMark('resolve-version:done');
            if (resolved.exhausted) {
              const recoverable = signInRecoverableCandidates(resolved.exhausted);
              const { signInLaunchDecision } = await import('./run-account-picker.js');
              const decision = signInLaunchDecision({
                recoverable: recoverable.length,
                tty: isInteractiveTerminal(),
                json: options.json === true,
              });
              if (decision === 'launch') {
                const { pickSignInLaunchVersion } = await import('./run-account-picker.js');
                const signInVersion = await pickSignInLaunchVersion(agent, recoverable, !!options.quiet);
                if (!signInVersion) return;
                version = signInVersion;
                signInLaunch = true;
              } else {
                const handoff = preflightHandoffEligible({
                  hasPrompt: prompt !== undefined,
                  interactive: options.interactive === true,
                  acp: options.acp === true,
                  loop: options.loop === true,
                  resumeCheckpoint: !!options.resumeCheckpoint,
                  resume: !!options.resume,
                  workflowScoped: !!workflowToolsRestrict || !!workflowMcpConfigPath,
                })
                  ? preflightFallbackHandoff(options.fallback, agent, resolved.exhausted)
                  : null;
                if (handoff) {
                  process.stderr.write(chalk.yellow(
                    `[agents] every ${agent} account is exhausted — handing off to ${handoff.agent}${handoff.version ? `@${handoff.version}` : ''}\n`,
                  ));
                  handoffRunDefaults ??= fromProfile ? undefined : resolveRunDefaults(agent, version ?? resolveVersion(agent, cwd), cwd);
                  agent = handoff.agent;
                  version = resolveVersionAlias(agent, handoff.version);
                  options.fallback = handoff.remainingSpec;
                  rotationResult = null;
                  continue preflight;
                }
                console.error(chalk.red(formatNoHealthyAccountError(agent, strategy, resolved.exhausted)));
                if (recoverable.length > 0) {
                  const { loginHint } = await import('../lib/signin-badge.js');
                  console.error(chalk.gray(
                    `To sign in: ${loginHint(agent)} — or run \`agents run ${agent}\` from a terminal.`,
                  ));
                }
                process.exit(1);
              }
            } else if (resolved.noVerifiedUsage) {
              const { noVerifiedUsageDecision, pickRunAccountCandidate } = await import('./run-account-picker.js');
              const decision = noVerifiedUsageDecision({
                tty: isInteractiveTerminal(),
                json: options.json === true,
                headless: options.headless === true,
              });
              if (decision === 'picker') {
                const selected = await pickRunAccountCandidate(agent);
                if (!selected) return;
                version = selected.version;
                launchSignedIn = selected.signedIn;
                launchEmail = selected.email;
                rotationResult = resolved.rotation;
                await applyPickedCandidate(selected);
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
              if (resolved.rotation) {
                launchSignedIn = resolved.rotation.picked.signedIn;
                launchEmail = resolved.rotation.picked.email;
                await applyPickedCandidate(resolved.rotation.picked);
              }
              const pickedProviderAccount = resolved.rotation?.picked.providerAccount;
              if (pickedProviderAccount) {
                try {
                  const picked = resolveSpawnAccount(pickedProviderAccount, agent, resolved.version, readMeta(), { useDefault: false });
                  if (picked?.kind === 'provider') accountEnv = picked.env;
                } catch (err) {
                  console.error(chalk.red((err as Error).message));
                  process.exit(1);
                }
              }
              if (resolved.rotation && !options.quiet) {
                const banner = formatRotationBanner(resolved.rotation, strategy);
                process.stderr.write(chalk.gray(banner + '\n'));
              }
            } else if (!options.quiet) {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} found no usable ${agent} version; falling back to defaults\n`));
            }
          } catch (err) {
            if (!options.quiet) {
              process.stderr.write(chalk.yellow(`[agents] strategy ${strategy} skipped: ${(err as Error).message}\n`));
            }
          }
        }
      }
      break;
      }

      {
        const launchTarget = version ?? resolveVersion(agent, cwd) ?? undefined;
        if (launchTarget) {
          const healed = await ensureAgentRunnable(
            agent,
            launchTarget,
            options.quiet ? undefined : (m) => process.stderr.write(chalk.yellow(`[agents] ${m}\n`)),
          );
          if (healed === null) {
            const { isVersionIsolated } = await import('../lib/installations/versions.js');
            const hint = isVersionIsolated(agent, launchTarget)
              ? `agents add ${agent}@${launchTarget} --isolated`
              : `agents add ${agent}@latest`;
            console.error(chalk.red(`agents: ${agent}@${launchTarget} is not runnable and could not be repaired. Try: ${hint}`));
            process.exit(1);
          }
          version = healed;
        }
      }
      bootMark('ensure-runnable:done');

      {
        const { resolveLaunchBinary } = await import('../lib/exec.js');
        if (!resolveLaunchBinary(agent, version)) {
          const target = version ? `${agent}@${version}` : agent;
          console.error(chalk.red(`agents: ${target} is not installed on this machine.`));
          console.error(chalk.yellow(`Install it with: agents add ${target}`));
          process.exit(1);
        }
      }

      const defaultVersion = version ?? resolveVersion(agent, cwd);

      if (defaultVersion) {
        applyActiveRulesPresetAtRun(agent, defaultVersion, getVersionHomePath(agent, defaultVersion));
        applySystemResourcesAtRun(agent, defaultVersion, getVersionHomePath(agent, defaultVersion));
      }
      bootMark('rules-sync:done');

      {
        const { shouldCheckLoginBeforeLaunch, loginHint } = await import('../lib/signin-badge.js');
        const preflight = shouldCheckLoginBeforeLaunch({
          interactive: options.interactive,
          forceInteractive,
          headless: options.headless,
          hasPrompt: prompt !== undefined,
          json: options.json,
          quiet: options.quiet,
          authCheckDisabled: options.authCheck === false || process.env.AGENTS_NO_AUTH_CHECK === '1',
          rotated: !!rotationResult || accountPickerRequested || signInLaunch || (launchAccount?.account?.kind ?? spawnAccount?.kind) === 'provider',
        });
        if (preflight) {
          try {
            const { getAccountInfo } = await import('../lib/agents.js');
            const authVersion = accountConfigVersion ?? version;
            const info = await getAccountInfo(agent, execHome ?? (authVersion ? getVersionHomePath(agent, authVersion) : undefined));
            let authedViaSetupToken = false;
            if (!info.signedIn && agent === 'claude' && version) {
              const { resolveClaudeSetupToken } = await import('../lib/claude-account-token.js');
              const { getVersionHomePath } = await import('../lib/installations/versions.js');
              authedViaSetupToken = resolveClaudeSetupToken(getVersionHomePath('claude', version)) !== null;
            }
            if (!info.signedIn && !authedViaSetupToken) {
              const { addSupported } = await import('../lib/accounts/add.js');
              const hint = (launchAccount?.account?.kind ?? spawnAccount?.kind) === 'native'
                ? `agents accounts login ${agent}#${configuredAccount}`
                : addSupported(agent)
                  ? `agents accounts add ${agent} <name>`
                  : loginHint(agent);
              process.stderr.write(
                chalk.yellow(`${agent} looks logged out — sign in with: ${hint}. Launching anyway...\n`),
              );
            }
          } catch {
          }
        }
      }

      const runDefaults: ResolvedRunDefaults = fromProfile
        ? { sources: {} }
        : resolveRunDefaults(agent, defaultVersion, cwd);

      let mode = options.mode as ExecMode;
      const modeSource = runCmd.getOptionValueSource('mode');
      const configuredMode = handoffRunDefaults?.mode ?? runDefaults.mode;
      const modeFromRunDefault = modeSource === 'default' && !!configuredMode;
      if (modeFromRunDefault) {
        mode = configuredMode as ExecMode;
      }
      if (!['plan', 'edit', 'auto', 'skip', 'full'].includes(mode)) {
        console.error(chalk.red(`Invalid mode: ${mode}. Use plan, edit, auto, or skip ('full' accepted as alias for skip).`));
        process.exit(1);
      }

      const modeIsDefault = modeSource === 'default';
      let requestedMode = normalizeMode(mode);
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

      const stallCmd = headlessPlanStallCommand({
        prompt,
        interactive: resolveInteractive({ prompt, headless: options.headless, interactive: options.interactive || forceInteractive }),
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
      const configuredEffort = handoffRunDefaults?.effort ?? runDefaults.effort;
      const effort = (effortSource === 'default' && configuredEffort ? configuredEffort : options.effort) as ExecEffort;
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

      const secretsKeysSubset = options.secretsKeys
        ? options.secretsKeys.split(',').map((k: string) => k.trim()).filter(Boolean)
        : undefined;
      let secretsEnv: Record<string, string> = {};
      const secretsContext = await resolveSecretsContextForRun(agent);
      for (const bundleRef of options.secrets) {
        try {
          const { bundle: bundleName, host } = splitBundleRef(bundleRef);
          if (host) {
            assertRemoteBundleFlagsUnsupported(
              bundleName,
              host,
              { keys: secretsKeysSubset, allowExpired: options.allowExpired },
              { keysFlag: '--secrets-keys', allowExpiredFlag: '--allow-expired' },
            );
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

      const hasOverrides = profileEnv || accountEnv || autoShareEnv || options.secrets.length > 0 || userEnv;
      const env: Record<string, string> | undefined = hasOverrides
        ? { ...(profileEnv ?? {}), ...(accountEnv ?? {}), ...(autoShareEnv ?? {}), ...secretsEnv, ...(userEnv ?? {}) }
        : undefined;

      const modelSource = runCmd.getOptionValueSource('model');
      let model = options.model
        ?? resolvedResumeSource?.model
        ?? (!fromProfile && modelSource === undefined
          ? (workflowModel ?? (options.fallback ? undefined : runDefaults.model))
          : undefined);

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
        accountId: launchAccount?.account?.kind === 'legacy-native' ? undefined : (launchAccount?.account?.id ?? spawnAccount?.id),
        version,
        configVersion: accountConfigVersion,
        execHome,
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
        raw: options.raw || options.tmux === false || options.disableTmux === true,
        timeout: options.timeout,
        env,
        toolsRestrict: workflowToolsRestrict,
        mcpConfigPath: workflowMcpConfigPath,
        passthroughArgs,
        emitSessionId: options.emitSessionId === true,
        strategy,
        resolvedVia: rawVersion
          ? 'explicit-pin'
          : rotationResult
            ? 'rotated'
            : 'pinned-default',
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

      if (fromProfile && profileFallbackModel && prompt !== undefined && !options.interactive) {
        fallback.unshift({
          agent,
          version,
          envOverride: { [profileFallbackModel.envKey]: profileFallbackModel.model },
        });
      }

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
        const failover = rotationFailoverChain(
          rotationResult!,
          version!,
          fallback.length > 0 ? (rotationResult!.healthy.length || DEFAULT_ROTATION_FAILOVER_LIMIT) : undefined,
        );
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
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode });
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

      {
        const { runPreflightGate } = await import('../lib/budget/preflight.js');
        const { resolveEffectiveModel } = await import('../lib/models.js');
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
            console.error(chalk.red(`[budget] BLOCKED: ${gate.decision.reason}`));
            console.error(chalk.gray(`Raise the cap in agents.yaml budget: or set on_exceed: warn to proceed.`));
            process.exit(2);
          }
          if (gate.decision.needsConfirm && !options.yes) {
            if (!process.stdin.isTTY) {
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
            process.stderr.write(chalk.yellow(`[budget] WARN: ${gate.decision.reason}\n`));
          }
        }
      }

      const cmd = buildExecCommand(execOptions);
      if (!options.quiet) {
        process.stderr.write(chalk.gray(`Running: ${cmd.join(' ')}\n\n`));
      }

      const cleanupWorkflowMcpConfig = () => {
        if (!workflowMcpConfigPath) return;
        try {
          fs.rmSync(path.dirname(workflowMcpConfigPath), { recursive: true, force: true });
        } catch {
        }
      };

      const cleanupWorkflowSubagents = () => {
        for (const target of workflowSubagentTargets) {
          try {
            fs.rmSync(target, { force: true });
          } catch {
          }
        }
      };

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
          const loopExit = loopExitCode(result.stoppedBy);
          recordDispatchedRun({ agent, version: defaultVersion ?? 'unknown', mode, cwd, exitCode: loopExit });
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

      if (inferredInteractiveWithoutTty(execOptions, isInteractiveTerminal())) {
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
          const sink: { agent?: AgentId; version?: string } = {};
          exitCode = await runWithFallback({ ...execOptions, prompt: prompt!, fallback, dispatchSink: sink });
          ranAgent = sink.agent ?? agent;
          ranVersion = sink.version ?? defaultVersion;
        } else {
          exitCode = await execAgent(execOptions);
        }
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
          await warnOrphanedOpenPr(cwd);
        }
        recordDispatchedRun({ agent: ranAgent, version: ranVersion ?? 'unknown', mode, cwd, exitCode });
        if (exitCode === 0) {
          recordRunAuthOutcome({
            agent: ranAgent,
            accountId: execOptions.accountId ?? null,
            version: ranVersion ?? null,
            home: execHome ?? null,
            outcome: { ok: true },
          });
        }
        if (exitCode === 0) maybeShowStarNudge({ quiet: options.json || options.quiet });
        process.exit(exitCode);
      } catch (err) {
        cleanupWorkflowMcpConfig();
        cleanupWorkflowSubagents();
        if (shouldWarnUnpushed(mode, resolveInteractive(execOptions))) {
          await warnUnpushedWork(cwd);
          await warnOrphanedOpenPr(cwd);
        }
        console.error(chalk.red(`Failed to execute ${agent}: ${(err as Error).message}`));
        process.exit(1);
      }
    });
}
