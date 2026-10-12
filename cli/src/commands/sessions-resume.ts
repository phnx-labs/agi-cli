import * as fs from 'fs';
import chalk from 'chalk';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { discoverSessions } from '../lib/session/discover.js';
import { filterTeamSessions } from '@phnx-labs/sessions-cli/reader';
import { multiItemPicker, itemPicker } from '../lib/picker.js';
import { buildPreview } from './sessions-picker.js';
import { formatPickerLabel, pickerColumnsFor } from '../lib/session/presentation.js';
import { parseAgentFilter, sessionMatchesQuery } from '../lib/session/selection.js';
import {
  openSurfaces,
  describeLaunch,
  availableBackends,
  detectCurrentBackend,
  currentContext,
  shellQuote,
  type Backend,
  type SurfaceItem,
  type EngineContext,
  type Packing,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { confirm } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { machineId } from '../lib/session/sync/config.js';
import { sessionOriginDevice, sessionRecoveryDestinationMatches, sessionRecoveryPeer, sessionTranscriptReadable } from '../lib/session/recovery.js';
import { localProjectFolder, toRemotePortable } from '../lib/project-root.js';
import { liveSessionProcesses } from '../lib/session/pid-registry.js';
import { sessionHeadline } from '../lib/session/title.js';
import { stripRoutingFlags, type StripSpec } from '../lib/hosts/remote-cmd.js';

export const CONFIRM_THRESHOLD = 5;

export function stillRunningNotice(shortId: string, pid: number, host: string): string {
  return `An older copy of ${shortId} is still running on ${host} (pid ${pid}). It was left alone.\n`;
}

interface ResumeOptions {
  agent?: string;
  account?: string;
  model?: string;
  mode?: string;
  interactive?: boolean;
  headless?: boolean;
  cwd?: string;
  quiet?: boolean;
  here?: boolean;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  device?: string;
  iterm?: boolean;
  ghostty?: boolean;
  tmux?: boolean;
  vscodium?: boolean;
  terminalApp?: boolean;
  splits?: boolean;
  runArgs: string[];
}

export async function sessionsResumeAction(
  options: ResumeOptions,
): Promise<void> {
  if (!isInteractiveTerminal()) {
    console.error(chalk.red('agents run --resume needs an interactive terminal to pick sessions; pass a session id instead.'));
    process.exitCode = 1;
    return;
  }

  let chosen: SessionMeta[] | null;
  const { agent, version } = parseAgentFilter(options.agent);
  const limit = parseInt(options.limit || '200', 10);
  const since = options.since ?? (options.all ? undefined : '30d');

  let sessions = await discoverSessions({
    agent,
    version,
    all: options.all,
    cwd: process.cwd(),
    since,
    sortBy: 'timestamp',
    limit: options.account ? undefined : limit,
    unbounded: !!options.account,
    excludeTeamOrigin: !options.teams,
  });
  const { visible } = filterTeamSessions(sessions, !!options.teams);
  sessions = visible;
  if (options.account) {
    const { findUnifiedAccount } = await import('../lib/account-registry.js');
    const { readMeta } = await import('../lib/state.js');
    const { sessionMatchesAccount } = await import('../lib/session/recovery.js');
    const account = findUnifiedAccount(options.account, readMeta(), undefined, agent as import('../lib/types.js').AgentId | undefined);
    if (!account) throw new Error(`Unknown account '${options.account}'.`);
    const context = account.kind === 'native'
      ? await (await import('../lib/exec-account-home.js')).resolveNativeSpawnHome(account.agent, account, readMeta(), { readOnly: true }).catch(() => null)
      : null;
    sessions = sessions.filter(session => sessionMatchesAccount(session, account, context?.execHome)).slice(0, limit);
  }

  if (sessions.length === 0) {
    console.log(chalk.gray('No sessions found. Try --all or a different --since window.'));
    return;
  }

  const cols = { ...pickerColumnsFor(sessions), gutter: 6 };
  try {
    chosen = await multiItemPicker<SessionMeta>({
      message: 'Select sessions to resume:',
      items: sessions,
      filter: (q: string) => (q.trim() ? sessions.filter((s) => sessionMatchesQuery(s, q)) : sessions),
      labelFor: (s, q) => formatPickerLabel(s, q, cols),
      keyFor: (s) => s.id,
      buildPreview,
      pageSize: 15,
      emptyMessage: 'No sessions match.',
      enterHint: 'resume',
    });
  } catch (err) {
    if (isPromptCancelled(err)) return;
    throw err;
  }
  if (!chosen || chosen.length === 0) return;

  if (options.device) {
    const requestedHost = options.device;
    const mismatches = chosen
      .map((session) => resumeHostMismatch(session, requestedHost))
      .filter((message): message is string => message !== null);
    if (mismatches.length > 0) {
      for (const message of mismatches) console.error(chalk.red(message));
      process.exitCode = 1;
      return;
    }
  }

  const { resumable, skipped } = partitionResumableSelections(chosen, options);
  for (const s of skipped) {
    console.log(chalk.yellow(`Skipping ${s.shortId} — nothing to resume (no transcript was written).`));
  }
  if (resumable.length === 0) {
    console.error(chalk.red('Nothing to resume — no selected session has a transcript.'));
    process.exitCode = 1;
    return;
  }
  let items = resumable.map((session) => buildSelectedResumeSurface(session, options));

  const ctx = currentContext();
  const backend = await resolveBackend(options, ctx, items.length);
  if (backend === 'cancel') return;

  if (backend === 'vscodium-agent' && !options.device) {
    const pending: typeof items = [];
    for (const it of items) {
      if (!it.project && it.session.project) {
        const { editorFolderNamed, storageJsonFor, vscodiumAgentBackend } = await import('../lib/terminal/backends/vscodium-agent.js');
        const folder = editorFolderNamed(it.session.project, storageJsonFor(vscodiumAgentBackend.variant));
        if (folder) Object.assign(it, { project: folder, cwd: fs.existsSync(it.cwd) && it.cwd !== process.cwd() ? it.cwd : folder });
      }
      if (!it.project) {
        console.error(chalk.red(`Can't open ${sessionLabel(it.session)}: no local folder matches ${it.session.cwd ?? `project "${it.session.project ?? 'unknown'}"`}, so there is no VSCodium window to put it in.`));
        console.error(chalk.gray(`  Resume it in this terminal instead: agents run auto --resume ${it.session.id}`));
        process.exitCode = 1;
        continue;
      }
      await reportLiveProcesses(it.session);
      pending.push(it);
    }
    items = pending;
    if (items.length === 0) return;
  }

  if (items.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({
      message: `Open ${items.length} live sessions at once?`,
      default: false,
    }).catch(() => false);
    if (!proceed) return;
  }

  if (backend === 'inplace') {
    if (items.length > 1) {
      console.log(chalk.gray(`Resuming ${items.length} sessions one at a time (no tab-capable terminal detected).`));
    }
    for (const it of items) await spawnCliInPlace(buildSelectedResumeArgs(it.session.id, options));
    return;
  }

  const packing = resolveResumePacking(options);
  if (backend === 'terminal' && packing === 'two-per-tab') {
    console.log(chalk.yellow('Terminal.app cannot split panes — opening one tab per session instead.'));
  }

  const results = await openSurfaces(
    items.map((it) => ({
      cwd: it.cwd,
      command: it.command,
      agent: it.session.agent || undefined,
      sessionId: it.session.id || undefined,
      title: sessionHeadline(it.session),
      project: it.project,
    })),
    { backend, host: options.device, packing },
  );

  results.forEach((r, i) => {
    const s = items[i].session;
    const line = describeLaunch(r, { verb: 'Resumed', label: sessionLabel(s) });
    if (r.ok) {
      console.log(line);
      return;
    }
    console.error(chalk.red(line));
    console.error(chalk.gray(`  Resume it in this terminal instead: agents run auto --resume ${s.id}`));
    process.exitCode = 1;
  });
}

function sessionLabel(s: SessionMeta): string {
  const headline = sessionHeadline(s);
  return `${s.shortId}${headline ? ` "${headline}"` : ''}${s.machine ? ` (${s.machine})` : ''}`;
}

const RUN_RESUME_PICKER_SPECS: StripSpec[] = [
  { long: 'all', takesValue: false },
  { long: 'teams', takesValue: false },
  { long: 'since', takesValue: true },
  { long: 'limit', short: 'n', takesValue: true },
];

export function buildSelectedResumeArgs(id: string, options: ResumeOptions): string[] {
  const args = stripRoutingFlags(options.runArgs, RUN_RESUME_PICKER_SPECS);
  const boundary = args.indexOf('--');
  const index = args.findIndex((arg, i) => (boundary < 0 || i < boundary) && (arg === '--resume' || arg === '--resume='));
  if (index < 0) throw new Error('The run command did not contain a bare --resume selector.');
  args.splice(index, 1, '--resume', id);
  if (options.device) {
    let remoteCwd: string | undefined;
    let localCwd: string | undefined;
    for (let i = 0; i < args.length && args[i] !== '--'; i++) {
      if (args[i] === '--remote-cwd') {
        remoteCwd = args[i + 1];
        args.splice(i--, 2);
      } else if (args[i].startsWith('--remote-cwd=')) {
        remoteCwd = args[i].slice('--remote-cwd='.length);
        args.splice(i--, 1);
      } else if (args[i] === '--cwd') {
        localCwd = args[i + 1];
        args.splice(i--, 2);
      } else if (args[i].startsWith('--cwd=')) {
        localCwd = args[i].slice('--cwd='.length);
        args.splice(i--, 1);
      } else if (['-D', '--device', '--host', '--where', '--on', '--computer'].includes(args[i])) {
        args.splice(i, 2);
        i--;
      } else if ((/^(?:--(?:device|host|where|on|computer)=|-D.)/.test(args[i]))) {
        args.splice(i, 1);
        i--;
      }
    }
    const effectiveCwd = remoteCwd ?? options.cwd ?? (localCwd ? toRemotePortable(localCwd) : undefined);
    if (effectiveCwd !== undefined) {
      const end = args.indexOf('--');
      args.splice(end < 0 ? args.length : end, 0, '--cwd', effectiveCwd);
    }
  }
  return args;
}

export function partitionResumableSelections(
  chosen: SessionMeta[],
  options: Pick<ResumeOptions, 'here' | 'device'> = {},
): { resumable: SessionMeta[]; skipped: SessionMeta[] } {
  const resumable: SessionMeta[] = [];
  const skipped: SessionMeta[] = [];
  for (const s of chosen) {
    const deferredToPeer = (!options.here || !!options.device) && sessionRecoveryPeer(s);
    (deferredToPeer || sessionTranscriptReadable(s) ? resumable : skipped).push(s);
  }
  return { resumable, skipped };
}

export async function dispatchSessionLifecycleInPlace(
  selector: string,
  hosts: string[] = [],
  attachOnly = false,
  local = false,
): Promise<void> {
  await spawnCliInPlace(buildSessionLifecycleArgs(selector, hosts, attachOnly, local));
}

export function buildSessionLifecycleArgs(
  selector: string,
  hosts: string[] = [],
  attachOnly = false,
  local = false,
): string[] {
  return [
    'ps', 'focus', selector,
    ...hosts.flatMap(host => ['--device', host]),
    ...(attachOnly ? ['--attach-only'] : []),
    ...(local ? ['--local'] : []),
  ];
}

function asyncExitCode(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function spawnCliInPlace(args: string[]): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1], ...args], { stdio: 'inherit' });
  const exitCode = await asyncExitCode(child);
  process.exitCode = exitCode;
}

export function resolveResumePacking(options: Pick<ResumeOptions, 'splits'>): Packing {
  return options.splits ? 'two-per-tab' : 'tabs';
}

export function buildSelectedResumeSurface(
  session: SessionMeta,
  options: ResumeOptions,
): SurfaceItem & { session: SessionMeta } {
  const requestedCwd = options.cwd || session.cwd;
  if (options.device && !requestedCwd) {
    throw new Error(`Cannot open ${session.shortId} on ${options.device} without a recorded working directory. Pass --cwd <path>.`);
  }
  const project = options.device ? undefined : localProjectFolder(requestedCwd);
  const cwd = options.device
    ? requestedCwd!
    : requestedCwd && fs.existsSync(requestedCwd) ? requestedCwd : project ?? process.cwd();
  return {
    session,
    cwd,
    project,
    command: ['agents', ...inTabArgs(buildSelectedResumeArgs(session.id, options))].map(shellQuote),
  };
}

async function reportLiveProcesses(session: SessionMeta): Promise<void> {
  const self = machineId();
  const host = session.machine && session.machine !== self ? session.machine : undefined;
  let pids: number[];
  if (!host) {
    pids = liveSessionProcesses(session.id).map((p) => p.pid);
  } else {
    const { gatherRemoteActive } = await import('../lib/session/remote-active.js');
    const remote = await gatherRemoteActive([host], { quiet: true }).catch(() => undefined);
    pids = (remote?.sessions ?? [])
      .filter((a) => a.sessionId === session.id && a.pidAlive !== false && typeof a.pid === 'number')
      .map((a) => a.pid!);
  }
  for (const pid of pids) process.stdout.write(chalk.yellow(stillRunningNotice(session.shortId, pid, host ?? self)));
}

function inTabArgs(args: string[]): string[] {
  if (args.includes('--quiet')) return args;
  const boundary = args.indexOf('--');
  return boundary < 0 ? [...args, '--quiet'] : [...args.slice(0, boundary), '--quiet', ...args.slice(boundary)];
}

export function resumeHostMismatch(
  session: Pick<SessionMeta, 'shortId' | 'machine'>,
  requestedHost: string,
  self = machineId(),
): string | null {
  const origin = sessionOriginDevice(session, self);
  return sessionRecoveryDestinationMatches(session, requestedHost, self)
    ? null
    : `Session ${session.shortId} originated on ${origin}; --device ${requestedHost} cannot move recovery to another device.`;
}

export async function resolveBackend(
  options: Pick<ResumeOptions, 'iterm' | 'ghostty' | 'tmux' | 'vscodium' | 'terminalApp' | 'device'>,
  ctx: EngineContext,
  count: number,
): Promise<Backend | 'inplace' | 'cancel'> {
  const forced: Backend | undefined =
    options.iterm ? 'iterm'
      : options.ghostty ? 'ghostty'
      : options.tmux ? 'tmux'
      : options.vscodium ? 'vscodium-agent'
      : options.terminalApp ? 'terminal'
      : undefined;
  if (forced) return forced;
  if (options.device) return 'tmux';

  const available = availableBackends(ctx);
  if (available.length === 0) return 'inplace';

  const detected = detectCurrentBackend(ctx);
  if (available.length === 1 && (!detected || detected === available[0].id)) return available[0].id;

  interface BackendChoice { id: Backend; label: string; detail: string; }
  const choices: BackendChoice[] = available.map((b) => ({
    id: b.id,
    label: b.label,
    detail: b.id === detected ? "the terminal you're in now" : `open in ${b.label}`,
  }));
  try {
    const picked = await itemPicker<BackendChoice>({
      message: `Resume ${count} session${count === 1 ? '' : 's'} where?`,
      items: choices,
      filter: () => choices,
      labelFor: (c) => `${chalk.bold(c.label.padEnd(10))}${chalk.gray(c.detail)}`,
      shortIdFor: (c) => c.label,
      enterHint: 'open',
    });
    return picked ? picked.item.id : 'cancel';
  } catch (err) {
    if (isPromptCancelled(err)) return 'cancel';
    throw err;
  }
}
