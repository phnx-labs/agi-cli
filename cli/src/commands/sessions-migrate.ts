/**
 * `agents sessions migrate` (alias `relocate`) — relocate a RUNNING agent session
 * from this machine onto another (a fleet worker, a registered device, or a warm
 * ephemeral crabbox box), then stop the source so the interactive machine
 * reclaims its compute (RUSH-1977).
 *
 * This is orchestration glue over primitives that already exist — it does not
 * reinvent transport, resume, or scoring:
 *   - resolve the source session from the current tmux pane via `getActiveSessions()`
 *     (`provenance.mux.pane` matched against $TMUX_PANE);
 *   - pick / verify the target with the pure scorer in
 *     `lib/session/migrate-targets.ts` + `readyProbe()` / `bootstrapAgentsCli()`;
 *   - wrap up a dirty working tree (mechanical WIP-PR by default, or delegate a
 *     wrap-up turn to the running agent with --agent-wrapup);
 *   - ship the transcript with the SAME bundle pipeline as
 *     `sessions export --stdout | sessions import -`, over `sshExec`;
 *   - resume on the target through the SAME `openSurfaces({ backend:'tmux', host })`
 *     path `sessions resume --device` uses;
 *   - only AFTER the target's prompt is confirmed live, kill the source tmux
 *     session (`killSession`). --keep skips the kill (copy, not move).
 *
 * INVARIANT: the source is never killed before the transcript + branch are
 * confirmed on the target.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import simpleGit from 'simple-git';
import type { Command } from 'commander';
import { spawnSync } from 'child_process';

import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';
import { AGENTS } from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { getActiveSessions } from '../lib/session/active.js';
import { discoverSessions, resolveSessionById } from '../lib/session/discover.js';
import { buildResumeCommand } from './sessions.js';
import { injectTargetFromReplyRail } from '../lib/session/inject.js';
import { injectIntoTerminal, iLoginShell, shellQuote as quoteArg } from '../lib/terminal/index.js';
import { killSession } from '../lib/tmux/session.js';
import { getDefaultSocketPath } from '../lib/tmux/paths.js';

import { listAllHosts, resolveHost } from '../lib/hosts/registry.js';
import type { Host } from '../lib/hosts/types.js';
import { sshTargetFor } from '../lib/hosts/types.js';
import { readyProbe, bootstrapAgentsCli, viewHasAgent } from '../lib/hosts/ready.js';
import { sshExec, shellQuote } from '../lib/ssh-exec.js';
import { loadDevices } from '../lib/devices/registry.js';
import { readStatsCache } from '../lib/devices/stats-cache.js';
import type { DeviceStats } from '../lib/devices/health.js';
import {
  crabboxList,
  crabboxWarmup,
  crabboxWaitReady,
  crabboxSshArgv,
  type CrabboxBox,
} from '../lib/crabbox/cli.js';
import { reusableBoxes, boxAddress } from './lease.js';
import {
  pickBestTarget,
  rankTargets,
  enumerateTargets,
  type MigrateTarget,
  type MigrateContext,
} from '../lib/session/migrate-targets.js';
import { itemPicker } from '../lib/picker.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { recordMigration, readMigrations, type MigrationRecord } from '../lib/session/migrations.js';

/** Agents whose sessions cannot be faithfully --resume'd (buildResumeCommand → null). */
type MigrateMode = 'resume' | 'rehydrate';

interface MigrateOptions {
  auto?: boolean;
  device?: string;
  lease?: boolean;
  mode?: MigrateMode;
  keep?: boolean;
  agentWrapup?: boolean;
}

export function registerSessionsMigrateCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('migrate [session-id]')
    .alias('relocate')
    .description('Relocate a running session onto another machine (fleet worker, device, or ephemeral box), then stop the source here.')
    .option('--auto', 'Pick the best target host automatically (idle fleet worker preferred)')
    .option('--device <name>', 'Explicit target: an enrolled host, device, or a warm ephemeral box slug')
    .option('--lease', 'Provision a fresh ephemeral crabbox box as the target')
    .option('--mode <mode>', 'rehydrate (default: the target agent reads the transported transcript) or resume (best-effort native --resume)', 'rehydrate')
    .option('--keep', 'Copy, not move — do NOT stop the source after resuming on the target')
    .option('--agent-wrapup', 'Delegate the dirty-tree wrap-up to the running agent instead of a mechanical WIP-PR');

  setHelpSections(cmd, {
    examples: `
      # Move the session in THIS pane onto the least-busy fleet worker
      agents sessions migrate --auto

      # Move a specific session onto a named host
      agents sessions migrate a1b2c3d4 --device yosemite-s1

      # Spin up a fresh ephemeral box and move onto it
      agents sessions migrate --lease

      # Copy (don't stop the source), letting the agent wrap up its own dirty tree
      agents sessions migrate --device box-a --keep --agent-wrapup
    `,
    notes: `
      - Without a [session-id], migrate resolves the session running in THIS tmux pane ($TMUX_PANE).
      - Default --mode rehydrate: the transcript is shipped to the target and the agent reads it there
        with 'agents sessions <id>' (its own judgment on --last/--include so long tool output can't
        blow context), then continues. Robust across every harness.
      - --mode resume attempts a native '<agent> --resume' on the target — faithful, but best-effort:
        the target agent must have the session registered, so migrate falls back to rehydrate when it can't.
      - The source is stopped only AFTER the target's session is confirmed live; --keep skips the stop (copy).
      - Every migrate appends to the ledger — see 'agents sessions migrations' for where each session went.
    `,
  });

  cmd.action(async (sessionId: string | undefined, options: MigrateOptions) => {
    await sessionsMigrateAction(sessionId, options);
  });
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

/**
 * Resolve the session to migrate. With an explicit id, resolve it from the
 * on-disk index. Without one, match the current tmux pane ($TMUX_PANE) against a
 * live session's `provenance.mux.pane` and resolve that id to its SessionMeta.
 */
async function resolveSourceSession(
  sessionId: string | undefined,
): Promise<{ meta: SessionMeta; active?: ActiveSession }> {
  if (sessionId) {
    const all = await discoverSessions({ all: true, sortBy: 'timestamp', limit: 2000 });
    const matches = resolveSessionById(all, sessionId);
    if (matches.length === 0) fail(`No session matches "${sessionId}".`);
    if (matches.length > 1) {
      fail(`"${sessionId}" is ambiguous (${matches.length} matches). Pass a longer id fragment.`);
    }
    const active = (await getActiveSessions()).find((s) => s.sessionId === matches[0].id);
    return { meta: matches[0], active };
  }

  const pane = process.env.TMUX_PANE;
  if (!pane) {
    fail('Not inside a tmux pane — pass an explicit [session-id] to migrate a specific session.');
  }
  const actives = await getActiveSessions();
  const active = actives.find((s) => s.provenance?.mux?.kind === 'tmux' && s.provenance.mux.pane === pane);
  if (!active || !active.sessionId) {
    fail(`No running session resolves to this pane (${pane}). Pass an explicit [session-id].`);
  }
  const all = await discoverSessions({ all: true, sortBy: 'timestamp', limit: 2000 });
  const matches = resolveSessionById(all, active.sessionId);
  if (matches.length === 0) fail(`This pane's session (${active.sessionId}) is not in the index yet.`);
  return { meta: matches[0], active };
}

/** Live headroom for the scorer: prefer the disk stats-cache (fast, no ssh). */
function statsByName(): Map<string, DeviceStats> {
  const cache = readStatsCache();
  return new Map(Object.entries(cache));
}

/** Enumerate + rank targets, honoring --device / --auto / --lease. */
async function resolveTarget(
  options: MigrateOptions,
  source: SessionMeta,
): Promise<MigrateTarget> {
  const selfHostname = os.hostname();
  const ctx: MigrateContext = {
    selfHostname,
    sourceHostname: source.machine ?? selfHostname,
    sourceOs: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux',
  };

  if (options.lease) {
    return await provisionEphemeralTarget();
  }

  const hosts = await listAllHosts();
  await loadDevices(); // ensure device registry is warmed (listAllHosts folds it in)
  let warm: CrabboxBox[] = [];
  try {
    warm = reusableBoxes(crabboxList(), Math.floor(Date.now() / 1000));
  } catch {
    warm = []; // crabbox not configured — fleet-only targets
  }
  const stats = statsByName();

  if (options.device) {
    // Explicit target: a fleet host/device, or a warm box slug.
    const box = warm.find((b) => b.slug === options.device);
    if (box) {
      return { name: box.slug, kind: 'ephemeral', os: 'linux', headroom: 'unknown', box };
    }
    const host = await resolveHost(options.device);
    if (!host) fail(`No host, device, or warm box named "${options.device}".`);
    if (host.name.toLowerCase() === selfHostname.toLowerCase()) {
      fail(`"${options.device}" is this machine — migrate needs a different target.`);
    }
    return { name: host.name, kind: 'fleet', os: host.os, headroom: 'unknown', host };
  }

  if (options.auto) {
    const best = pickBestTarget(hosts, warm, stats, ctx);
    if (!best) {
      fail('No eligible target found (no reachable, dispatchable host that isn\'t this machine or the source). Try --lease to provision a fresh box.');
    }
    console.log(chalk.gray(`Auto-selected ${best.name} (${best.kind}, ${best.headroom}).`));
    return best;
  }

  // Interactive: rank the candidates and let the user pick.
  if (!isInteractiveTerminal()) {
    fail('Pass --auto, --device <name>, or --lease to choose a target (no interactive picker without a tty).');
  }
  const ranked = rankTargets(enumerateTargets(hosts, warm, stats, ctx), ctx);
  if (ranked.length === 0) {
    fail('No eligible target found. Try --lease to provision a fresh box.');
  }
  try {
    const picked = await itemPicker<MigrateTarget>({
      message: 'Migrate this session to which machine?',
      items: ranked,
      filter: () => ranked,
      labelFor: (t) => `${chalk.bold(t.name.padEnd(20))}${chalk.gray(`${t.kind} · ${t.headroom}${t.os ? ' · ' + t.os : ''}`)}`,
      shortIdFor: (t) => t.name,
      enterHint: 'migrate',
    });
    if (!picked) fail('Cancelled.');
    return picked.item;
  } catch (err) {
    if (isPromptCancelled(err)) fail('Cancelled.');
    throw err;
  }
}

/** Provision a fresh ephemeral crabbox box (tailnet) and wait for it to be ready. */
async function provisionEphemeralTarget(): Promise<MigrateTarget> {
  console.log(chalk.gray('Provisioning a fresh ephemeral box (crabbox)…'));
  const leased = await crabboxWarmup({ netMode: 'tailscale' });
  const ready = await crabboxWaitReady(leased.slug).catch(() => leased);
  console.log(chalk.green(`Leased box ${ready.slug}.`));
  return { name: ready.slug, kind: 'ephemeral', os: 'linux', headroom: 'idle', box: ready };
}

/** Resolve the SSH target string for a migrate target (host alias or box address). */
function sshTargetForTarget(target: MigrateTarget): string {
  if (target.kind === 'fleet' && target.host) return sshTargetFor(target.host);
  if (target.kind === 'ephemeral' && target.box) {
    const addr = boxAddress(target.box);
    if (!addr) fail(`Ephemeral box ${target.box.slug} has no reachable address.`);
    return addr!;
  }
  fail(`Cannot resolve an SSH target for ${target.name}.`);
}

/**
 * Harness-parity gate (pure, testable). `buildResumeCommand` returns null for the
 * non-resumable agents (gemini, antigravity, openclaw, rush, hermes, grok, kimi,
 * droid) — for those a faithful --resume is impossible, so a requested `resume`
 * transparently becomes `rehydrate`. A resumable agent honors the request.
 * Returns the effective mode plus whether it was downgraded, so the caller can
 * print the notice.
 */
export function effectiveMode(source: SessionMeta, requested: MigrateMode): { mode: MigrateMode; downgraded: boolean } {
  const resumable = buildResumeCommand(source) !== null;
  if (!resumable && requested === 'resume') return { mode: 'rehydrate', downgraded: true };
  return { mode: requested, downgraded: false };
}

/**
 * Verify the target can run the session's agent+version. Returns the effective
 * mode: a non-resumable agent (buildResumeCommand → null) forces rehydrate; a
 * missing agents-cli triggers a bootstrap; a missing agent (in rehydrate) is a
 * printed notice, not a failure.
 */
function ensureTargetReady(
  target: MigrateTarget,
  sshTarget: string,
  source: SessionMeta,
  requested: MigrateMode,
): MigrateMode {
  // buildResumeCommand gates faithful resume: null → only rehydrate is possible.
  const gated = effectiveMode(source, requested);
  let mode = gated.mode;
  if (gated.downgraded) {
    console.log(chalk.yellow(`  ${source.agent} sessions can't be faithfully resumed — using --mode rehydrate.`));
  }

  const remoteOs = target.host?.os;
  let probe = readyProbe(sshTarget, remoteOs);
  if (!probe.reachable) {
    fail(`Target ${target.name} is not reachable over SSH (${sshTarget}).`);
  }
  if (!probe.version) {
    console.log(chalk.gray(`  agents-cli not found on ${target.name} — bootstrapping…`));
    const boot = bootstrapAgentsCli(sshTarget, null, remoteOs);
    if (!boot.ok) fail(`Failed to bootstrap agents-cli on ${target.name}: ${boot.output.split('\n').pop()}`);
    probe = readyProbe(sshTarget, remoteOs);
  }

  if (!viewHasAgent(probe.view, source.agent)) {
    if (mode === 'resume') {
      console.log(chalk.yellow(`  ${source.agent} isn't installed on ${target.name} — falling back to --mode rehydrate.`));
      mode = 'rehydrate';
    } else {
      console.log(chalk.gray(`  Note: ${source.agent} isn't installed on ${target.name}; the rehydrated session will read the transcript with whatever agent runs there.`));
    }
  }
  return mode;
}

/**
 * Wrap up the working tree so no local edits are stranded when the source stops.
 * Dirty → commit to a fresh branch + push + open a draft (WIP) PR. Clean-but-ahead
 * → push. --agent-wrapup instead injects a wrap-up turn into the running agent.
 * Returns the branch name to check out on an ephemeral target (or undefined).
 */
async function wrapUpWorkingTree(
  source: SessionMeta,
  active: ActiveSession | undefined,
  options: MigrateOptions,
): Promise<string | undefined> {
  const cwd = source.cwd;
  if (!cwd || !fs.existsSync(cwd)) return undefined;
  const git = simpleGit(cwd);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (!isRepo) return undefined;

  const status = await git.status();
  const dirty = status.files.length > 0;
  const ahead = status.ahead ?? 0;

  if (!dirty && ahead === 0) {
    return status.current || undefined;
  }

  if (options.agentWrapup) {
    await delegateWrapupToAgent(source, active);
    // The agent handles the commit/push; report its current branch for checkout.
    const after = await git.status();
    return after.current || undefined;
  }

  if (dirty) {
    const branch = status.current && status.current !== 'main' && status.current !== 'master'
      ? status.current
      : `migrate/${source.shortId}`;
    // Only create the branch when we're on the default branch (don't strand edits on main).
    if (status.current === 'main' || status.current === 'master') {
      console.log(chalk.gray(`  Working tree dirty on ${status.current} — committing to a new branch ${branch}.`));
      await git.checkoutLocalBranch(branch);
    } else {
      console.log(chalk.gray(`  Working tree dirty on ${branch} — committing before migrate.`));
    }
    await git.add('-A');
    await git.commit(`wip: migrate ${source.agent} session ${source.shortId}`);
    await git.push(['-u', 'origin', branch]).catch((e) => {
      console.log(chalk.yellow(`  push failed: ${(e as Error).message}`));
    });
    openWipPr(cwd, branch);
    return branch;
  }

  // Clean but ahead — push what's committed.
  console.log(chalk.gray(`  ${ahead} local commit(s) ahead — pushing before migrate.`));
  await git.push().catch((e) => console.log(chalk.yellow(`  push failed: ${(e as Error).message}`)));
  return status.current || undefined;
}

/** Open a draft (WIP) PR for the wrap-up branch. Best-effort; a failure is a notice. */
function openWipPr(cwd: string, branch: string): void {
  const r = spawnSync(
    'gh',
    ['pr', 'create', '--draft', '--fill', '--head', branch],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status === 0) {
    const url = (r.stdout || '').trim().split('\n').pop();
    console.log(chalk.green(`  WIP PR: ${url}`));
  } else {
    console.log(chalk.yellow(`  Could not open a WIP PR (${(r.stderr || '').trim().split('\n').pop() || 'gh error'}). Branch ${branch} is pushed.`));
  }
}

/** --agent-wrapup: inject a wrap-up turn into the running agent's tmux pane. */
async function delegateWrapupToAgent(source: SessionMeta, active: ActiveSession | undefined): Promise<void> {
  const rail = active?.provenance?.reply;
  if (!rail) {
    console.log(chalk.yellow('  --agent-wrapup: no addressable reply rail for the running agent; committing mechanically instead is not possible here — the tree stays as-is.'));
    return;
  }
  const target = injectTargetFromReplyRail(rail);
  if (!target) {
    console.log(chalk.yellow('  --agent-wrapup: reply rail is not injectable; tree stays as-is.'));
    return;
  }
  const text =
    'Before this session is migrated to another machine, commit the current working changes to a branch, push it, and open a draft WIP PR. Then reply "wrapped up".';
  const res = await injectIntoTerminal(target, text, { enter: true });
  if (res.ok) {
    console.log(chalk.gray('  Asked the running agent to wrap up its working tree (draft PR).'));
  } else {
    console.log(chalk.yellow(`  --agent-wrapup injection failed: ${res.error ?? 'unknown'}.`));
  }
}

/**
 * Ship the transcript to the target so `<agent> --resume` can find it there.
 *
 * The live transcript (`SessionMeta.filePath`) is copied to the SAME absolute
 * path on the target: claude/codex/opencode resolve a resumable session by the
 * cwd-derived project dir under $HOME, which is identical across the shared fleet
 * home, so a same-path copy is exactly what `--resume` reads. (`sessions import`
 * deliberately lands bundles in the browsable history mirror, not the agent's
 * live dir — right for reading a transcript on another box, wrong for resuming
 * it.) Reuses the same `sshExec` transport, streaming the file over stdin.
 */
function shipTranscript(sshTarget: string, source: SessionMeta): void {
  const file = source.filePath;
  if (!file || !fs.existsSync(file)) {
    fail(`Cannot locate the local transcript for ${source.shortId} to ship (${file ?? 'no path'}).`);
  }
  const content = fs.readFileSync(file, 'utf8');
  const parent = path.dirname(file);
  const remoteCmd = `mkdir -p ${shellQuote(parent)} && cat > ${shellQuote(file)}`;
  const res = sshExec(sshTarget, remoteCmd, { input: content, timeoutMs: 120000 });
  if (res.code !== 0) {
    fail(`Failed to ship the transcript to ${sshTarget}: ${res.stderr.trim().split('\n').pop() || `ssh exited ${res.code}`}`);
  }
  console.log(chalk.green(`  Transcript shipped to the target (${file}).`));
}

/** Git-clone + checkout the (WIP) branch on an ephemeral box so the cwd resolves. */
function prepareEphemeralCwd(sshTarget: string, source: SessionMeta, branch: string | undefined): string | undefined {
  const remote = spawnSync('git', ['-C', source.cwd || '.', 'remote', 'get-url', 'origin'], { encoding: 'utf-8' });
  const url = (remote.stdout || '').trim();
  if (remote.status !== 0 || !url) {
    console.log(chalk.yellow('  Ephemeral target: the source cwd has no origin remote to clone; the resumed session will start in $HOME.'));
    return undefined;
  }
  const dir = `~/migrated/${source.shortId}`;
  const checkout = branch ? ` && git checkout ${shellQuote(branch)}` : '';
  const script = `mkdir -p ~/migrated && (test -d ${dir}/.git || git clone ${shellQuote(url)} ${dir})${' && cd ' + dir + checkout}`;
  const res = sshExec(sshTarget, `bash -lc ${shellQuote(script)}`, { timeoutMs: 300000 });
  if (res.code !== 0) {
    console.log(chalk.yellow(`  Clone on the box failed (${res.stderr.trim().split('\n').pop() || 'git error'}); the resumed session will start in $HOME.`));
    return undefined;
  }
  return dir;
}

/**
 * Pure. The remote shell commands that create the target's tmux session on the
 * SAME socket its reaper queries, and that probe its liveness afterward.
 *
 * `homeRelSocketPath` is `getDefaultSocketPath()` expressed relative to the
 * LOCAL home dir (`path.relative(os.homedir(), getDefaultSocketPath())`) — a
 * portable suffix, not a resolved absolute path, because the local and remote
 * HOME can differ (different user, different OS). It is spliced in after a
 * literal, unquoted `$HOME/` so the REMOTE shell resolves it; `$HOME` MUST
 * NEVER be resolved locally (see AGENTS.md's remote-path guidance).
 *
 * Extracted as a pure function so the "does the migrated session land on the
 * agents socket, not tmux's bare default socket" invariant is unit-testable
 * without an SSH round-trip (RUSH-2521 review — a bare `tmux` here made the
 * migrated agent's helpers invisible to `readAllPaneOwners`, so the reaper's
 * next tick killed the still-live, just-migrated agent as `tmux-session-gone`).
 */
export function buildMigrateResumeCommands(opts: {
  sessionName: string;
  homeRelSocketPath: string;
  inner: string;
  cwd?: string;
}): { launchCmd: string; probeCmd: string; socketFlag: string } {
  const socketDirRelToHome = path.dirname(opts.homeRelSocketPath);
  const socketFlag = `-S "$HOME/${opts.homeRelSocketPath}"`;
  const argv = ['set-option', '-g', 'remain-on-exit', 'on', ';', 'new-session', '-d', '-s', opts.sessionName];
  if (opts.cwd && opts.cwd !== '~') argv.push('-c', opts.cwd);
  argv.push(opts.inner);
  // Mirror createSession's second half: keep remain-on-exit on THIS pane (the
  // liveness probe below reads `pane_dead`), then put the server-wide default
  // back to off. Leaving `-g on` set made every later pane on the target — user
  // splits included — retain a corpse when its command finished.
  argv.push(';', 'set-option', '-t', opts.sessionName, '-p', 'remain-on-exit', 'on');
  argv.push(';', 'set-option', '-g', 'remain-on-exit', 'off');
  // Unlike tmux's own scratch dir (auto-created under /tmp), the agents socket's
  // parent may not exist yet on a fresh worker or ephemeral box that never ran a
  // tmux-backed `agents` command — `mkdir -p` it before tmux tries to bind there.
  const launchCmd = `mkdir -p "$HOME/${socketDirRelToHome}" && tmux ${socketFlag} ` + argv.map(shellQuote).join(' ');
  const q = shellQuote(opts.sessionName);
  const probeCmd = `sleep 3; tmux ${socketFlag} has-session -t ${q} 2>/dev/null || exit 3; test "$(tmux ${socketFlag} list-panes -t ${q} -F '#{pane_dead}' 2>/dev/null | head -n1)" = 0 || exit 4`;
  return { launchCmd, probeCmd, socketFlag };
}

/**
 * Resume the session on the target through the SAME host path as
 * `sessions resume --device` (tmux backend). Returns true when the resume launched.
 */
async function resumeOnTarget(
  sshTarget: string,
  source: SessionMeta,
  remoteCwd: string | undefined,
  mode: MigrateMode,
): Promise<boolean> {
  const command = mode === 'resume' ? buildResumeCommand(source) : rehydrateCommand(source);
  if (!command) {
    fail(`Cannot build a resume command for ${source.agent} (mode ${mode}).`);
  }
  // Start a DETACHED tmux session on the target. The generic engine tmux backend
  // uses `new-window`, which needs a live server — a fresh worker or ephemeral
  // box has none ("no server running"), so we create the session (and thus the
  // server) directly with `new-session -d`, mirroring the local `createSession`
  // helper (remain-on-exit keeps the pane inspectable if the agent exits), over
  // the same SSH transport as `sessions resume --device`.
  //
  // Each argv element is quoted BEFORE the zsh -ilc wrapper so a command that
  // carries spaces or backticks (the rehydrate prompt) reaches the agent as one
  // clean argument — an unquoted join would let the target shell split it and
  // run its backticks.
  //
  // The pane exports AGENT_TMUX_SESSION_NAME the way a local `createSession`
  // pane does, so the target's reaper can attribute the helpers this agent
  // spawns and collect them when it exits (RUSH-2521, `lib/tmux/orphan-reap.ts`)
  // — see {@link buildMigrateResumeCommands} for why the session MUST land on
  // the agents socket rather than tmux's bare default socket.
  const sessionName = `migrate-${source.shortId}`;
  const homeRelSocketPath = path.relative(os.homedir(), getDefaultSocketPath());
  const inner = iLoginShell(`export AGENT_TMUX_SESSION_NAME=${sessionName}; exec ${command!.map(quoteArg).join(' ')}`);
  const cwd = remoteCwd ?? source.cwd;
  const { launchCmd, probeCmd } = buildMigrateResumeCommands({ sessionName, homeRelSocketPath, inner, cwd });
  const launch = sshExec(sshTarget, launchCmd, { timeoutMs: 60000 });
  if (launch.code !== 0) {
    console.log(chalk.red(`  Resume on ${sshTarget} failed: ${launch.stderr.trim().split('\n').pop() || `tmux exited ${launch.code}`}`));
    return false;
  }
  // Liveness gate for the invariant: give the agent a moment to boot, then require
  // the pane to be ALIVE (not merely the session to exist) before the caller may
  // stop the source. An agent that dies on launch → we refuse to move.
  const check = sshExec(sshTarget, probeCmd, { timeoutMs: 30000 });
  if (check.code !== 0) {
    const why = check.code === 4 ? 'the agent exited immediately on the target'
      : check.code === 3 ? 'the session did not start'
      : (check.stderr.trim().split('\n').pop() || `liveness probe exited ${check.code}`);
    console.log(chalk.red(`  Resume on ${sshTarget} is not live: ${why}.`));
    return false;
  }
  console.log(chalk.green(`  Resumed on the target in tmux session ${sessionName} (${command!.join(' ')}).`));
  return true;
}

/**
 * Rehydrate command: launch a fresh agent that reads the transcript. For a
 * non-resumable agent there is no faithful --resume, so we start the agent with
 * a prompt pointing it at the imported transcript path.
 */
export function rehydrateCommand(source: SessionMeta): string[] {
  // Resolve the real executable — the session-agent id is not always the binary
  // name (antigravity → `agy`), matching versionedAliasIfPresent/buildFallbackCommand.
  const cli = AGENTS[source.agent as AgentId]?.cliCommand ?? source.agent;
  const origin = source.machine ? ` from ${source.machine}` : '';
  const prompt = [
    `You are continuing session ${source.shortId}, migrated to this machine${origin}.`,
    `Its full transcript is here — read it with \`agents sessions ${source.shortId}\`.`,
    `It supports --markdown, role filters (e.g. --include user,assistant), and --last N;`,
    `use them so large tool outputs don't blow your context — skim the recent turns first,`,
    `widen only if you need to, then continue the work where it left off.`,
  ].join(' ');
  return [cli, prompt];
}

async function sessionsMigrateAction(sessionId: string | undefined, options: MigrateOptions): Promise<void> {
  if (options.mode && options.mode !== 'resume' && options.mode !== 'rehydrate') {
    fail(`--mode must be 'resume' or 'rehydrate' (got "${options.mode}").`);
  }

  // 1. Resolve the source session (current-pane unless an id is given).
  const { meta: source, active } = await resolveSourceSession(sessionId);
  console.log(chalk.bold(`Migrating ${source.agent} session ${source.shortId}`) + chalk.gray(` (${source.cwd ?? 'no cwd'})`));

  // 2. Resolve the target host.
  const target = await resolveTarget(options, source);
  const sshTarget = sshTargetForTarget(target);

  // 3. Verify the target can run the agent+version (bootstrap if missing); resolve the mode.
  const mode = ensureTargetReady(target, sshTarget, source, options.mode ?? 'resume');

  // 4. Wrap up the working dir (WIP PR by default, or delegate to the agent).
  const branch = await wrapUpWorkingTree(source, active, options);

  // 5. Transport the transcript to the target's live agent dir (same path) so
  //    `<agent> --resume` finds it.
  shipTranscript(sshTarget, source);

  // 6. For an ephemeral box, clone + checkout the branch so the cwd resolves.
  const remoteCwd =
    target.kind === 'ephemeral' ? prepareEphemeralCwd(sshTarget, source, branch) : source.cwd;

  // 7. Resume on the target.
  const resumed = await resumeOnTarget(sshTarget, source, remoteCwd, mode);

  // Ledger stub shared by the success and failure records (RUSH-1977). `at` is
  // stamped from the CLI's real clock.
  const base: Omit<MigrationRecord, 'status' | 'error'> = {
    sessionId: source.id,
    shortId: source.shortId,
    agent: source.agent,
    mode,
    move: !options.keep,
    from: { host: os.hostname(), cwd: source.cwd, pane: active?.provenance?.mux?.pane },
    to: { host: target.name, cwd: remoteCwd, box: target.box?.slug },
    branch,
    at: new Date().toISOString(),
  };

  if (!resumed) {
    recordMigration({ ...base, status: 'failed', error: 'resume did not launch on the target' });
    fail('Resume on the target did not launch — the source is left running (nothing was stopped).');
  }

  // 8. INVARIANT: only now that the transcript is on the target and the session
  //    is confirmed live, stop the source. --keep skips this (copy, not move).
  if (options.keep) {
    console.log(chalk.gray('--keep: the source session is left running (copy, not move).'));
  } else {
    await stopSource(source, active);
  }

  // 9. Record the handoff so the session stays trackable (agents sessions migrations).
  recordMigration({ ...base, status: 'completed' });
  console.log(
    chalk.green(`\nMigrated ${source.shortId} to ${target.name}${options.keep ? ' (copy)' : ''}.`) +
      chalk.gray(" Tracked in 'agents sessions migrations'."),
  );
}

/** Stop the source tmux session (kill its tmux session by name via its socket). */
async function stopSource(source: SessionMeta, active: ActiveSession | undefined): Promise<void> {
  const mux = active?.provenance?.mux;
  // Fail closed: only the SOURCE's own pane, from its active-session provenance.
  // Never fall back to $TMUX_PANE — that is the invoking shell's pane, so a
  // migrate run by explicit id from a different pane (where `active` didn't
  // resolve) would otherwise kill the user's OWN session, not the source.
  const pane = mux?.pane;
  const socket = mux?.socket;
  if (!pane) {
    console.log(chalk.yellow(`  Could not resolve ${source.shortId}'s own tmux pane — leaving it running (won't stop a pane not confirmed to be the source).`));
    return;
  }
  const name = resolveSessionNameForPane(pane, socket);
  if (!name) {
    console.log(chalk.yellow(`  Could not resolve a tmux session name for pane ${pane} — leaving the source running.`));
    return;
  }
  const killed = await killSession(name, socket);
  if (killed) console.log(chalk.gray(`  Stopped the source tmux session (${name}).`));
  else console.log(chalk.yellow(`  Source tmux session ${name} was already gone.`));
}

/**
 * `agents sessions migrations` — the border tracker: the append-only ledger of
 * every session handed off to/from another machine (RUSH-1977).
 */
export function registerSessionsMigrationsCommand(sessionsCmd: Command): void {
  sessionsCmd
    .command('migrations')
    .description('Show the migration ledger — sessions handed off to/from other machines.')
    .option('--json', 'Output the raw ledger as JSON')
    .option('--session <id>', 'Only rows whose session id starts with this fragment')
    .action((options: { json?: boolean; session?: string }) => {
      let recs = readMigrations();
      if (options.session) recs = recs.filter((r) => r.sessionId.startsWith(options.session!) || r.shortId.startsWith(options.session!));
      if (options.json) {
        console.log(JSON.stringify(recs, null, 2));
        return;
      }
      if (recs.length === 0) {
        console.log(chalk.gray('No migrations recorded yet. Move one: agents sessions migrate --auto'));
        return;
      }
      // Newest first — the most recent hop of a session is what you usually want.
      recs.reverse();
      console.log(
        chalk.bold('WHEN'.padEnd(18)) + chalk.bold('SESSION'.padEnd(11)) + chalk.bold('AGENT'.padEnd(9)) +
          chalk.bold('ROUTE'.padEnd(30)) + chalk.bold('MODE'.padEnd(11)) + chalk.bold('STATUS'),
      );
      for (const r of recs) {
        const when = r.at.slice(0, 16).replace('T', ' ');
        const route = `${r.from.host} → ${r.to.box ?? r.to.host}`;
        const kind = r.move ? r.mode : `${r.mode}·copy`;
        const status = r.status === 'completed' ? chalk.green('ok') : chalk.red('failed');
        const pr = r.wipPr ? chalk.gray(`  ${r.wipPr}`) : '';
        console.log(
          when.padEnd(18) + r.shortId.padEnd(11) + r.agent.padEnd(9) +
            route.padEnd(30) + kind.padEnd(11) + status + pr,
        );
      }
    });
}

/** Map a tmux pane id to its session name via the same tmux binary the engine uses. */
function resolveSessionNameForPane(pane: string, socket?: string): string | undefined {
  const args = socket ? ['-S', socket] : [];
  const r = spawnSync('tmux', [...args, 'display-message', '-pt', pane, '-p', '#{session_name}'], { encoding: 'utf-8' });
  if (r.status !== 0) return undefined;
  const name = (r.stdout || '').trim();
  return name || undefined;
}
