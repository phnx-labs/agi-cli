/**
 * `agents sessions resume` — the one resume surface.
 *
 * - Strict single-session: `sessions resume <id> [prompt]` with optional
 *   --mode/--headless/--interactive/--cwd/--quiet/--here (formerly top-level
 *   `agents resume`). Identity resolution + owner-device hop live in resume.ts.
 * - Multi-select: bare `sessions resume` opens a checkbox picker and fans each
 *   pick into a terminal tab/split via the terminal launch engine.
 * - Direct id/alias always takes the strict path; live-pane attach is
 *   `sessions focus`.
 * - `--device` opens the terminal surface on the session origin only.
 */
import * as fs from 'fs';
import chalk from 'chalk';
import type { Command } from 'commander';
import { isAgentTmuxAlias, type SessionMeta } from '../lib/session/types.js';
import { discoverSessions } from '../lib/session/discover.js';
import { filterTeamSessions } from '../lib/session/team-filter.js';
import { multiItemPicker, itemPicker } from '../lib/picker.js';
import { buildPreview } from './sessions-picker.js';
import {
  formatPickerLabel,
  pickerColumnsFor,
  resolveSessionMetadataValue,
  parseAgentFilter,
} from './sessions.js';
import { sessionMatchesQuery } from './sessions-browser.js';
import {
  openSurfaces,
  availableBackends,
  detectCurrentBackend,
  currentContext,
  type Backend,
  type SurfaceItem,
  type EngineContext,
  type Packing,
} from '../lib/terminal/index.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';
import { confirm } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { looksLikeSessionId } from '../lib/session/discover.js';
import { machineId } from '../lib/session/sync/config.js';
import { sessionOriginDevice, sessionRecoveryDestinationMatches } from '../lib/session/recovery.js';
import { buildResumeRemoteArgs, runStrictResume, wantsStrictResume, type StrictResumeOptions } from './resume.js';
import { attachLocalLiveSelector } from '../lib/session/local-tmux-attach.js';

/** Opening more than this many live sessions at once asks for confirmation first. */
export const CONFIRM_THRESHOLD = 5;

export interface ResumeOptions extends StrictResumeOptions {
  agent?: string;
  all?: boolean;
  teams?: boolean;
  since?: string;
  limit?: string;
  device?: string;
  iterm?: boolean;
  ghostty?: boolean;
  tmux?: boolean;
  vscodium?: boolean;
  /** --terminal-app: force macOS Terminal.app. Named to avoid reading as `run --terminal`. */
  terminalApp?: boolean;
  splits?: boolean;
  attachOnly?: boolean;
  local?: boolean;
  /** Original run argv; only the bare resume selector changes after picking. */
  runArgs?: string[];
}

export function registerSessionsResumeCommand(sessionsCmd: Command): void {
  const cmd = sessionsCmd
    .command('resume')
    .argument('[query]', 'Session id/tmux alias/label for strict resume, or text that filters the picker')
    .argument('[prompt]', 'Optional follow-up prompt (same conversation, account and origin device)')
    .description('Resume a session by id (strict), or multi-select history into terminal tabs/splits.')
    .option('-a, --agent <agent>', 'Filter by agent type and version (e.g., claude, codex@0.116.0)')
    .option('--account <account>', 'Filter by the account that owns the conversation')
    .option('--model <model>', 'Override the resumed session model')
    .option('--all', 'Include sessions from every directory (not just current project)')
    .option('--teams', 'Include team-spawned sessions (hidden by default)')
    .option('--since <time>', 'Only sessions newer than this (e.g., 2h, 7d, 4w, or ISO date)')
    .option('-n, --limit <n>', 'Maximum number of sessions to load into the picker', '200')
    .option('--device <alias>', 'Open on the session origin device over SSH; the device must match every selected session')
    .option('--iterm', 'Force the iTerm backend')
    .option('--ghostty', 'Force the Ghostty backend')
    .option('--tmux', 'Force the tmux backend')
    .option('--vscodium', 'Force the VSCodium agent-terminal backend (swarm-ext)')
    .option('--terminal-app', 'Force macOS Terminal.app (no split support — panes become tabs)')
    .option('--splits', 'Pack two sessions side by side per tab (default: one tab per session)')
    .option('-m, --mode <mode>', 'Strict resume: override the recorded launch mode')
    .option('-i, --interactive', 'Strict resume: interactive even when a prompt is provided')
    .option('--headless', 'Strict resume: headless (a prompt is required)')
    .option('--cwd <path>', 'Strict resume: override the recorded working directory')
    .option('-q, --quiet', 'Strict resume: suppress routing banners')
    .option('--here', 'Strict resume: run on this machine even if the session belongs to another device')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .option('--attach-only', 'With an id/alias: attach a living pane only — never resume a copy');

  setHelpSections(cmd, {
    examples: `
      # Strict resume by full id (former top-level agents resume)
      agents sessions resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897
      agents sessions resume 019fd0c8-b3e9-77a2-a1a4-444698c4d897 "finish the tests"
      agents sessions resume ag-codex-c1f3d813 --mode edit

      # Pick several sessions; each opens in its own tab
      agents sessions resume

      # Pre-filter the pool before selecting (space in the filter → use [query])
      agents sessions resume "auth middleware"

      # Reopen one session from any device by UUID prefix or tmux alias
      agents sessions resume 019fd114
      agents sessions resume ag-codex-c1f3d813

      # Attach a living pane only — never resume a copy (the old go)
      agents sessions resume 019fd114 --attach-only

      # Force a backend / side-by-side splits / a remote host
      agents sessions resume --ghostty
      agents sessions resume --vscodium
      agents sessions resume --splits
      agents sessions resume --device zion --tmux
    `,
    notes: `
      - Strict path (id/tmux alias/label + optional prompt/--mode/--headless/--here): restores the harness, device, account, cwd, model, and mode using the installed binary. Searches the fleet; a local full-id hit resumes with zero SSH. Replaces the former top-level agents sessions resume.
      - Attach a live pane without forking: agents sessions focus <id>.
      - This is the ONE verb for getting back in. It detects the state: a live tmux pane is attached, a headless session comes to the foreground, an ended one recovers on its owning device.
      - A UUID/prefix or ag-<agent>-<suffix> alias bypasses the picker. A live alias attaches by name even when the session index cannot attribute it.
      - Retired spellings still work for one release and print the replacement: sessions attach, sessions go, reconnect.
      - Going the other way (foreground -> background) is 'agents sessions detach <id>'.
      - With no identity selector, space toggles a session, enter confirms, and tab toggles the preview pane.
      - Layout: one tab per session by default. --splits packs session pairs side by side in each tab.
      - Backend: auto-detected from the terminal you're in (iTerm / Ghostty / tmux); override with --iterm/--ghostty/--tmux/--vscodium.
      - --vscodium opens each session as an agent terminal tab in VSCodium via the swarm-ext extension (works with --device too).
      - --device <alias> opens the terminal surface on that device only when it is the selected sessions' origin; recovery never migrates a session to another device.
      - Recovery uses the installed harness and the conversation's account on its origin device. Context replay requires an explicit choice.
      - agents run claude --resume opens this same picker; claude#work filters it with --account work.
    `,
  });

  cmd.action(async (query: string | undefined, prompt: string | undefined, options: ResumeOptions) => {
    await sessionsResumeAction(query, prompt, options);
  });
}

export async function sessionsResumeAction(
  query: string | undefined,
  prompt: string | undefined,
  options: ResumeOptions,
): Promise<void> {
  if (options.attachOnly && (prompt !== undefined || options.account || options.model || options.mode || options.interactive || options.headless || options.cwd || options.here)) {
    throw new Error('--attach-only cannot be combined with a follow-up prompt or options that change the running session.');
  }
  const strictOpts: StrictResumeOptions = {
    account: options.account,
    model: options.model,
    mode: options.mode,
    interactive: options.interactive,
    headless: options.headless,
    cwd: options.cwd,
    quiet: options.quiet,
    here: options.here,
    local: options.local,
  };

  const explicitSurface = !!(options.iterm || options.ghostty || options.tmux || options.vscodium || options.terminalApp || options.device);
  const direct = !!query && (isDirectResumeSelector(query) || wantsStrictResume(prompt, strictOpts));

  // Direct id/alias (or label with prompt/strict flags) → strict resume
  // (former top-level `agents sessions resume`). `--attach-only` / `--local`
  // must go through sessions focus so they cannot silently fork a copy
  // (AGI EXT still shells `sessions resume <id> --local`).
  if (query && direct && !explicitSurface) {
    const hosts = options.device ? [options.device] : [];
    // PHNX-3292: a live LOCAL tmux pane (the exact alias, or a unique 8-hex
    // short id) attaches immediately, before any fleet SSH — the product rule
    // is "first unique match wins," and a pane already on this box is the
    // fastest possible match. This applies to bare resume too, not just
    // `--attach-only`: a prompt/mode/headless/cwd override still means the
    // caller wants strict resume semantics (a scripted continue), so that
    // case is excluded via wantsStrictResume.
    if (!options.account && !options.model && !wantsStrictResume(prompt, strictOpts) && await attachLocalLiveSelector(query.trim(), hosts)) {
      return;
    }
    if (!options.account && !options.model && resumeUsesLifecycleDispatch(query, prompt, options)) {
      await dispatchSessionLifecycleInPlace(query.trim(), hosts, !!options.attachOnly, !!options.local);
      return;
    }
    await runStrictResume(query.trim(), prompt, strictOpts);
    return;
  }

  if (!direct && !isInteractiveTerminal()) {
    console.error(chalk.red('sessions resume needs an interactive terminal (or pass a session id for strict resume).'));
    process.exitCode = 1;
    return;
  }


  let chosen: SessionMeta[] | null;
  if (query && direct) {
    const outcome = await resolveSessionMetadataValue(query, { local: options.local, hosts: options.device ? [options.device] : undefined, agent: parseAgentFilter(options.agent).agent });
    if (outcome.kind !== 'resolved') {
      console.error(chalk.red(`No session matching "${query}" (${outcome.kind}).`));
      process.exitCode = 1;
      return;
    }
    chosen = [outcome.session];
  } else {
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
      sessions = sessions.filter(session => sessionMatchesAccount(session, account)).slice(0, limit);
    }

    if (sessions.length === 0) {
      console.log(chalk.gray('No sessions found. Try --all or a different --since window.'));
      return;
    }

    // 1. Multi-select the sessions. gutter: 6 = the multi-select cursor + checkbox
    // ('> [x] ') that multiItemPicker prepends, so rows size to fit without wrapping.
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
        initialSearch: query,
        emptyMessage: 'No sessions match.',
        enterHint: 'resume',
      });
    } catch (err) {
      if (isPromptCancelled(err)) return;
      throw err;
    }
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

  // 2. Route every selection through the owning device's recovery resolver.
  const items: Array<SurfaceItem & { session: SessionMeta }> = [];
  for (const s of chosen) {
    const command = ['agents', ...buildSelectedResumeArgs(s.id, prompt, options)];
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    items.push({ session: s, cwd, command });
  }

  // 3. Resolve the backend (and host).
  const ctx = currentContext();
  const backend = await resolveBackend(options, ctx, items.length);
  if (backend === 'cancel') return;

  // 4. Guard against opening a flood of live agents.
  if (items.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({
      message: `Open ${items.length} live sessions at once?`,
      default: false,
    }).catch(() => false);
    if (!proceed) return;
  }

  // 5a. No tab-capable backend (off-macOS, not in tmux, local) — resume in place, sequentially.
  if (backend === 'inplace') {
    if (items.length > 1) {
      console.log(chalk.gray(`Resuming ${items.length} sessions one at a time (no tab-capable terminal detected).`));
    }
    for (const it of items) await spawnCliInPlace(buildSelectedResumeArgs(it.session.id, prompt, options));
    return;
  }

  // 5b. Fan out through the engine. Full-width tabs are the default for batch
  // recovery; callers can explicitly opt into pairs of side-by-side panes.
  const packing = resolveResumePacking(options);
  const where = options.device ? `${backend} on ${options.device}` : backend;
  // Terminal.app has no scriptable split, so its buildSplit opens a tab. Say so
  // when the user actually asked for panes — the layout silently not happening
  // is worse than one line of warning.
  if (backend === 'terminal' && packing === 'two-per-tab') {
    console.log(chalk.yellow('Terminal.app cannot split panes — opening one tab per session instead.'));
  }
  console.log(chalk.gray(`Opening ${items.length} session${items.length === 1 ? '' : 's'} in ${where} (${packing})…`));

  // agent + sessionId ride the SurfaceItem into the vscodium-agent spawn URI
  // so the extension can set the tab chip without process-tree sniffing (#2478).
  const results = await openSurfaces(
    items.map((it) => ({
      cwd: it.cwd,
      command: it.command,
      agent: it.session.agent || undefined,
      sessionId: it.session.id || undefined,
      title: it.session.label || it.session.topic || undefined,
    })),
    { backend, host: options.device, packing },
  );

  let opened = 0;
  results.forEach((r, i) => {
    const s = items[i].session;
    if (r.ok) {
      opened++;
      const shape = r.request.layout === 'tab' ? 'tab' : 'split';
      console.log(chalk.green(`  opened ${s.shortId}`) + chalk.gray(` — ${shape} — ${items[i].command.join(' ')}`));
    } else {
      console.log(chalk.red(`  failed ${s.shortId} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${items.length} in ${where}.`));
}

/** Preserve run options and lifecycle intent when the picker opens its selected rows. */
export function buildSelectedResumeArgs(id: string, prompt: string | undefined, options: ResumeOptions): string[] {
  if (options.runArgs) {
    const args = [...options.runArgs];
    const boundary = args.indexOf('--');
    const index = args.findIndex((arg, i) => (boundary < 0 || i < boundary) && (arg === '--resume' || arg === '--resume='));
    if (index < 0) throw new Error('The run command did not contain a bare --resume selector.');
    args.splice(index, 1, '--resume', id);
    // The outer surface already placed this terminal on the selected device.
    if (options.device) {
      let remoteCwd: string | undefined;
      for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        if (args[i] === '--remote-cwd') {
          remoteCwd = args[i + 1];
          args.splice(i--, 2);
        } else if (args[i].startsWith('--remote-cwd=')) {
          remoteCwd = args[i].slice('--remote-cwd='.length);
          args.splice(i--, 1);
        } else if (['-D', '--device', '--host', '--where', '--on', '--computer'].includes(args[i])) {
          args.splice(i, 2);
          i--;
        } else if ((/^(?:--(?:device|host|where|on|computer)=|-D.)/.test(args[i]))) {
          args.splice(i, 1);
          i--;
        }
      }
      if (remoteCwd !== undefined) {
        const end = args.indexOf('--');
        args.splice(end < 0 ? args.length : end, 0, '--cwd', remoteCwd);
      }
    }
    return args;
  }
  const args = buildResumeRemoteArgs(id, prompt, options);
  if (options.here) args.push('--here');
  if (options.local) args.push('--local');
  if (options.attachOnly) args.push('--attach-only');
  return args;
}

/** IDs and tmux aliases are actions, not picker search text. Human phrases keep
 * the existing pre-filtered picker, while an explicit identity resumes directly. */
export function isDirectResumeSelector(query: string): boolean {
  const selector = query.trim();
  return looksLikeSessionId(selector) || isAgentTmuxAlias(selector);
}

/** Re-enter through sessions resume so fleet routing and harness policy
 * stay centralized. The child inherits this terminal for a real interactive resume. */
export async function resumeSelectorInPlace(selector: string): Promise<void> {
  await spawnCliInPlace(['sessions', 'resume', selector]);
}

/** Direct identities use focus as the lifecycle dispatcher: it rechecks the
 * live fleet, attaches a healthy pane, and falls through to `agents resume`
 * only when the process is no longer attachable. */
/** True when `sessions resume <id> --attach-only|--local` must go through
 *  `sessions focus` instead of `runStrictResume` (which can fork a copy). */
export function resumeUsesLifecycleDispatch(
  query: string | undefined,
  prompt: string | undefined,
  options: Pick<ResumeOptions, 'attachOnly' | 'local' | 'mode' | 'interactive' | 'headless' | 'here'>,
): boolean {
  if (!query || !isDirectResumeSelector(query)) return false;
  if (!options.attachOnly && !options.local) return false;
  return !wantsStrictResume(prompt, {
    mode: options.mode,
    interactive: options.interactive,
    headless: options.headless,
    here: options.here,
    local: options.local,
  });
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
    'sessions', 'focus', selector,
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

/**
 * Decide which backend to launch into. Returns a concrete backend, `'inplace'`
 * (resume in the current process — no GUI/tmux available), or `'cancel'` (the
 * user dismissed the chooser).
 */
export async function resolveBackend(
  options: ResumeOptions,
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
  // Remote defaults to tmux (headless, no GUI session assumptions); override with a backend flag.
  if (options.device) return 'tmux';

  const available = availableBackends(ctx);
  if (available.length === 0) return 'inplace';

  const detected = detectCurrentBackend(ctx);
  // Only one option and it's where we already are → no need to ask.
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
