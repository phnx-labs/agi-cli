
import type { Command } from 'commander';
import fs from 'node:fs';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { gatherLiveTargets, pickLiveTarget, pickLiveTargets, jumpTo, focusEditorTabOf, focusLocalEditorTab, probeAttachRail, refuseFallback, type AttachRailLiveness, type UnreachableFallback } from './go.js';
import { sessionProcessIsLocal, sessionProcessHost, shortIdFromName, type ActiveSession } from '../lib/session/active.js';
import { SESSION_AGENTS, isAgentTmuxAlias, type SessionMeta, type SessionAgentId } from '@phnx-labs/sessions-cli/reader';
import { attachLocalLiveSelector } from '../lib/session/local-tmux-attach.js';
export { looksLikeTmuxAlias, resolveTmuxAliasState, shouldAttachLocalTmuxAliasBeforeFleet, type TmuxAliasState } from '../lib/session/local-tmux-attach.js';
import { buildSessionRecoveryCommand, formatLiveStatusHeadline, formatPickerLabel, isRunningLiveSession, pickerColumnsFor, resumeSessionInPlace } from './sessions.js';
import { filterSessionsByQuery, resolveSessionMetadataValue, resolveSessionAgentName } from '../lib/session/selection.js';
import { requestedLiveStatuses, type LiveStatusFilter } from './ps-roster.js';
import { resolveBackend, CONFIRM_THRESHOLD } from './sessions-resume.js';
import { runOnPeer } from '../lib/session/remote-list.js';
import { discoverSessions, resolveIndexedSessionById } from '../lib/session/discover.js';
import { machineId } from '../lib/session/sync/config.js';
import { collectSessionCandidates, normalizeDeviceSeed } from './sessions-browser.js';
import { buildPreview } from './sessions-picker.js';
import { multiItemPicker } from '../lib/picker.js';
import { sessionRecoveryRunArgs } from '../lib/session/recovery.js';
import { shellQuote, assertValidSshTarget } from '../lib/ssh-exec.js';
import {
  openSurfaces,
  currentContext,
  availableBackends,
  detectCurrentBackend,
  type Backend,
} from '../lib/terminal/index.js';
import { addressabilityRecoveryHint } from '../lib/terminal/resolve.js';
import { isInteractiveTerminal, isPromptCancelled } from './utils.js';
import { setHelpSections } from '../lib/help.js';

interface FocusOptions {
  launchId?: string;
  local?: boolean;
  attachOnly?: boolean;
  device?: string[];
  active?: boolean;
  agent?: string;
  claude?: boolean;
  codex?: boolean;
  kimi?: boolean;
  antigravity?: boolean;
  grok?: boolean;
  opencode?: boolean;
  all?: boolean;
  teams?: boolean;
  inTeam?: string;
  routine?: boolean;
  project?: string;
  skill?: string;
  plugin?: string;
  since?: string;
  until?: string;
  limit?: string;
  bookmarks?: boolean;
  unmanaged?: boolean;
  sort?: string;
  working?: boolean;
  idle?: boolean;
  waiting?: boolean;
  orphan?: boolean;
  orphaned?: boolean;
  crashed?: boolean;
  closed?: boolean;
  abandoned?: boolean;
  queued?: boolean;
  unknown?: boolean;
  reconnectReattach?: boolean;
}

const INHERITED_FOCUS_OPTIONS: Array<keyof FocusOptions> = [
  'local', 'device', 'active', 'agent',
  'claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode',
  'all', 'teams', 'inTeam', 'routine', 'project', 'skill', 'plugin',
  'since', 'until', 'limit', 'bookmarks', 'unmanaged', 'sort',
  'working', 'idle', 'waiting', 'orphan', 'orphaned', 'crashed',
  'closed', 'abandoned', 'queued', 'unknown',
];

export function inheritFocusOptions(child: FocusOptions, parent?: Command): FocusOptions {
  if (!parent) return child;
  const merged = { ...child };
  for (const key of INHERITED_FOCUS_OPTIONS) {
    const source = parent.getOptionValueSource(String(key));
    if (source && source !== 'default') {
      (merged as Record<string, unknown>)[key] = parent.getOptionValue(String(key));
    }
  }
  return merged;
}

export function mergeFocusHosts(opts: FocusOptions): string[] {
  return [...(opts.device ?? [])];
}

export function focusHeader(statuses: LiveStatusFilter[], hosts: string[]): string {
  const where = hosts.length ? ` on ${hosts.join(', ')}` : '';
  if (statuses.length === 0) return `Focus a live session${where}:`;
  const word = statuses.length === 1 ? statusWord(statuses[0]) : 'filtered';
  return `Focus ${word} sessions${where}:`;
}

function statusWord(status: LiveStatusFilter): string {
  return status === 'orphaned' ? 'orphaned' : status;
}

export function registerFocusCommand(
  program: Command,
  opts: { group?: 'sessions' | 'ps'; hidden?: boolean } = {},
): void {
  const group = opts.group ?? 'sessions';
  const cmd = program
    .command('focus', { hidden: opts.hidden ?? true })
    .argument('[selector]', 'Session id/prefix, agent@version, or topic/path search')
    .option('--launch-id <id>', 'Target the run by its launcher AGENT_LAUNCH_ID instead of a session id (resolved from this machine\'s hook records)')
    .option('--local', 'Only this machine (skip the cross-host sweep)')
    .option('--attach-only', 'Attach only — never open a new tab / resume a copy (the old `go` behavior)')
    .option('--reconnect-reattach', '(internal) Set by the reconnect loop — warns when the expected pane is dead and a fresh copy starts instead', false)
    .option('-D, --device <target...>', 'Scope the picker to live sessions on these devices (device alias from `agents devices`, user@host; repeatable)')
    .option('--active', 'Only sessions present in the live roster')
    .option('-a, --agent <agent>', 'Filter by harness and recorded version (for example claude@latest)')
    .option('--claude', 'Shorthand for --agent claude')
    .option('--codex', 'Shorthand for --agent codex')
    .option('--kimi', 'Shorthand for --agent kimi')
    .option('--antigravity', 'Shorthand for --agent antigravity')
    .option('--grok', 'Shorthand for --agent grok')
    .option('--opencode', 'Shorthand for --agent opencode')
    .option('--all', 'Include every directory and all time')
    .option('--teams', 'Include team-spawned sessions')
    .option('--in-team <name>', 'Only one team lineage')
    .option('--routine', 'Only routine-run sessions')
    .option('-p, --project <name>', 'Only a named project')
    .option('--skill <name>', 'Only sessions that invoked this skill')
    .option('--plugin <name>', 'Only sessions that used this plugin')
    .option('--since <time>', 'Only sessions newer than this (for example 7d)')
    .option('--until <time>', 'Only sessions older than this timestamp')
    .option('-n, --limit <n>', 'Maximum candidates to load', '500')
    .option('--bookmarks', 'Only bookmarked sessions')
    .option('--unmanaged', 'Also include native-home sessions outside managed versions')
    .option('--sort <field>', 'Order candidates by recent, cost, or duration', 'recent')
    .option('--working', 'Only live sessions currently doing work')
    .option('--idle', 'Only live sessions that have stopped between turns')
    .option('--waiting', 'Only live sessions waiting on your input')
    .option('--orphan', 'Only sessions whose process outlived its terminal client')
    .option('--orphaned', 'Alias for --orphan')
    .option('--crashed', 'Only sessions whose terminal disappeared with the process')
    .option('--closed', 'Only recently observed sessions whose process exited normally')
    .option('--abandoned', 'Only sessions with no transcript progress for the abandonment window')
    .option('--queued', 'Only queued sessions that have not started running')
    .option('--unknown', 'Only sessions whose live state cannot be determined')
    .description('Focus sessions by id, harness/version, topic, device, or live state; attach living panes and recover ended ones')
    .action(async (id: string | undefined, opts: FocusOptions, command: Command) => {
      await focusAction(id, inheritFocusOptions(opts, command.parent ?? undefined));
    });

  setHelpSections(cmd, {
    examples: `
      # Focus a session directly (attach a living pane, otherwise recover it)
      agents ${group} focus a1b2c3d4

      # Multi-select live sessions; each opens as a tab in this terminal
      agents ${group} focus

      # Scope the picker to one device's orphaned sessions
      agents ${group} focus --orphan --device yosemite-s0

      # Resolve latest on yosemite-s0, then pick from that version's sessions
      agents ${group} focus claude@latest --device yosemite-s0

      # Attach only — refuse if nothing is joinable
      agents ${group} focus a1b2c3d4 --attach-only

      # Pick from live sessions on this machine only
      agents ${group} focus --local
    `,
    notes: `
      - space toggles a session, enter opens the selected set; a single check + enter opens just one.
      - With no selector/filter, the picker shows the live fleet. An id focuses directly; agent@version and text selectors always show the preview picker.
      - A living tmux pane is JOINED (a second client, no fork). Dead/missing panes recover on the origin device: exact healthy origin uses native resume; otherwise a healthy version of the same harness receives /continue <id>.
      - An id/identity selector resolves across the whole reachable fleet on its own — you do NOT need --device to focus a session that lives on another box (same as resume/preview). --device only narrows the browsable picker and the agent/version resolution.
      - --device and the sessions-browser filters compose. latest/oldest resolve against each selected device's installed versions.
      Lifecycle siblings (not synonyms):
        focus              attach if alive, otherwise recover (default "take me there")
        focus --attach-only  attach only; never fork (replaces go)
        detach / attach    interactive ↔ headless presence
        resume             multi-select history → tabs
        run --resume       single scripted continue
    `,
  });
}

export function selectFallback(attachOnly: boolean | undefined): UnreachableFallback {
  return attachOnly ? refuseFallback : resumeInNewTab;
}

export async function focusAction(id: string | undefined, opts: FocusOptions): Promise<void> {
  if (opts.launchId) {
    if (id) {
      console.error(chalk.red('Pass a session id or --launch-id, not both — they name the same thing two ways.'));
      process.exitCode = 1;
      return;
    }
    const { loadHookSessionIndex } = await import('../lib/session/hook-sessions.js');
    const resolved = loadHookSessionIndex().byLaunchId.get(opts.launchId)?.session_id;
    if (!resolved) {
      console.error(chalk.red(`No session recorded for launch id ${opts.launchId} on ${machineId()}.`));
      console.error(chalk.gray('  The run may have failed before its SessionStart hook fired.'));
      console.error(chalk.gray('  Look for it:  agents sessions --active'));
      process.exitCode = 1;
      return;
    }
    id = resolved;
  }
  const hosts = mergeFocusHosts(opts);
  const statuses = requestedLiveStatuses(opts);
  const local = !!opts.local && hosts.length === 0;
  const fallback = selectFallback(opts.attachOnly);

  const agentSelector = focusAgentSelector(id, opts);
  let textSelector = id && !agentSelector ? id : undefined;
  const filtered = !!id || hasFocusFilters(opts, statuses);

  if (filtered) {
    if (!isInteractiveTerminal() && !looksLikeIdentitySelector(textSelector)) {
      console.error(chalk.red('focus selectors need an interactive terminal; pass a session id for direct focus.'));
      process.exitCode = 1;
      return;
    }
    const limit = Number.parseInt(opts.limit ?? '500', 10);
    const idLookup = looksLikeIdentitySelector(textSelector);
    const sort = focusSort(opts.sort);
    if (!sort) {
      console.error(chalk.red(`Invalid sort: ${opts.sort}. Use recent, cost, or duration.`));
      process.exitCode = 1;
      return;
    }

    if (await attachLocalLiveSelector(textSelector, hosts)) {
      return;
    }

    if (textSelector && looksLikeIdSelector(textSelector) && await focusLocalEditorTab(textSelector)) {
      return;
    }

    if (idLookup && hosts.length === 0 && looksLikeIdSelector(textSelector)) {
      const self = machineId();
      const localMatch = dedupeSessionsByLogicalId(
        await resolveIndexedSessionById(textSelector),
        self,
      );
      if (localMatch.length === 1 && !sessionProcessHost(localMatch[0], self)) {
        const { activeById } = await gatherLiveTargets(true, { statuses: [] });
        await focusResolvedSession(localMatch[0], activeById, self, fallback, opts.attachOnly === true, opts.reconnectReattach === true);
        return;
      }
    }

    const { sessions, liveById, self, unreachable } = await collectSessionCandidates({
      running: opts.active === true || statuses.length > 0,
      statuses,
      agent: agentSelector ?? focusOptionAgent(opts),
      teams: opts.teams === true,
      team: opts.inTeam,
      bookmarks: opts.bookmarks === true,
      projectScope: opts.all || hosts.length > 0 || !!opts.project || idLookup ? 'all' : 'repo',
      project: opts.project,
      window: opts.since ?? (opts.all || idLookup ? undefined : '30d'),
      until: opts.until,
      routine: opts.routine === true,
      skill: opts.skill,
      plugin: opts.plugin,
      limit: idLookup && limit === 500 ? 5000 : (Number.isFinite(limit) && limit > 0 ? limit : 500),
      unmanaged: opts.unmanaged === true,
      sort,
      device: hosts.length === 1 ? normalizeDeviceSeed(hosts[0]) : undefined,
    }, { local, hosts, includeLive: true });

    if (unreachable.length > 0) {
      console.error(chalk.yellow(`Unavailable devices: ${unreachable.join(', ')}`));
    }

    const idSelector = textSelector && looksLikeIdSelector(textSelector) ? textSelector.toLowerCase() : undefined;
    let exact = idSelector
      ? dedupeSessionsByLogicalId(
          sessions.filter((session) => session.id.toLowerCase().startsWith(idSelector)),
          self,
        )
      : [];
    if (textSelector && isAgentTmuxAlias(textSelector)) {
      const short = shortIdFromName(textSelector);
      if (short) {
        textSelector = short;
        exact = dedupeSessionsByLogicalId(
          sessions.filter((session) => session.id.toLowerCase().startsWith(short)),
          self,
        );
      }
    }

    if (exact.length === 0 && textSelector && looksLikeIdentitySelector(textSelector)) {
      const outcome = await resolveSessionMetadataValue(textSelector, { local, hosts });
      if (outcome.kind === 'partial') {
        const offline = outcome.failedPeers;
        console.error(chalk.yellow(`Warning: ${offline.length} device(s) unreachable, not checked: ${offline.join(', ')}`));
        console.error(chalk.red(`No session matching "${textSelector}" on any reachable device (${offline.length} unreachable, not checked).`));
        console.error(chalk.gray('  If it lives on an offline box, wake it (agents devices) or run there: agents ssh <device>'));
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === 'ambiguous') {
        console.error(chalk.red(`"${textSelector}" matches ${outcome.candidates.length} sessions. Pass a longer id or alias.`));
        process.exitCode = 1;
        return;
      }
      if (outcome.kind === 'not-found') {
        console.error(chalk.red(`No session matching "${textSelector}".`));
        process.exitCode = 1;
        return;
      }
      const filteredMatch = sessions.find((session) => session.id === outcome.session.id);
      exact = [focusTargetForResolved(filteredMatch, outcome.session)];
    }
    if (exact.length === 1) {
      await focusResolvedSession(exact[0], liveById, self, fallback, opts.attachOnly === true, opts.reconnectReattach === true);
      return;
    }
    if (exact.length > 1) {
      console.error(chalk.red(`"${textSelector}" is ambiguous (${exact.length} sessions). Use more of the id.`));
      process.exitCode = 1;
      return;
    }

    if (!isInteractiveTerminal()) {
      console.error(chalk.red(`No session matching "${textSelector}" in the selected scope.`));
      process.exitCode = 1;
      return;
    }

    const chosen = await pickFocusCandidates(sessions, liveById, textSelector);
    if (chosen.length === 0) return;
    await openFocusTabs(
      chosen.map((meta) => liveById.get(meta.id) ?? activeFromMeta(meta)),
      self,
      { metas: chosen, attachOnly: opts.attachOnly === true },
    );
    return;
  }

  const { self, activeById } = await gatherLiveTargets(local, { hosts, statuses });

  if (!isInteractiveTerminal()) {
    console.error(chalk.red('focus needs an interactive terminal, or pass a session id.'));
    process.exitCode = 1;
    return;
  }
  if (activeById.size === 0) {
    const scope = describeScope(statuses, hosts);
    console.log(chalk.gray(`No live sessions to focus${scope}. To resume a past one: agents sessions resume`));
    return;
  }

  const header = focusHeader(statuses, hosts);

  if (opts.attachOnly) {
    const target = await pickLiveTarget(activeById, self, header, 'focus');
    if (!target) return;
    await jumpTo(target, self, fallback);
    return;
  }

  const targets = await pickLiveTargets(activeById, self, header);
  if (targets.length === 0) return;
  await openFocusTabs(targets, self);
}

export function isAttachableLiveSession(session: ActiveSession): boolean {
  return isRunningLiveSession(session);
}

const FOCUS_AGENT_SHORTHANDS = ['claude', 'codex', 'kimi', 'antigravity', 'grok', 'opencode'] as const;

function focusOptionAgent(opts: FocusOptions): string | undefined {
  if (opts.agent) return opts.agent;
  return FOCUS_AGENT_SHORTHANDS.find((agent) => opts[agent] === true);
}

function focusAgentSelector(selector: string | undefined, opts: FocusOptions): string | undefined {
  const candidate = selector ?? focusOptionAgent(opts);
  if (!candidate) return undefined;
  const [name, version] = candidate.split('@', 2);
  const agent = resolveSessionAgentName(name);
  if (!agent) return undefined;
  return version === undefined ? agent : `${agent}@${version}`;
}

function looksLikeIdSelector(selector: string | undefined): selector is string {
  return !!selector && /^[0-9a-f][0-9a-f-]{5,}$/i.test(selector);
}

function looksLikeIdentitySelector(selector: string | undefined): selector is string {
  return !!selector && (
    /^[0-9a-f][0-9a-f-]{5,}$/i.test(selector) ||
    isAgentTmuxAlias(selector)
  );
}

function sessionRowRank(s: SessionMeta, self?: string): number {
  return (s.filePath ? 4 : 0) + (self && s.machine === self ? 2 : 0) + (s._remote ? 0 : 1);
}

export function dedupeSessionsByLogicalId(rows: SessionMeta[], self?: string): SessionMeta[] {
  const byId = new Map<string, SessionMeta>();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    const held = byId.get(key);
    if (!held || sessionRowRank(row, self) > sessionRowRank(held, self)) byId.set(key, row);
  }
  return [...byId.values()];
}

function hasFocusFilters(opts: FocusOptions, statuses: LiveStatusFilter[]): boolean {
  return statuses.length > 0 || !!(
    opts.active || opts.local || opts.device?.length || focusOptionAgent(opts) ||
    opts.all || opts.teams || opts.inTeam || opts.routine || opts.project || opts.skill || opts.plugin ||
    opts.since || opts.until || opts.bookmarks || opts.unmanaged || (opts.sort && opts.sort !== 'recent')
  );
}

function focusSort(value: string | undefined): 'timestamp' | 'cost' | 'duration' | null {
  if (!value || value === 'recent') return 'timestamp';
  return value === 'cost' || value === 'duration' ? value : null;
}

async function pickFocusCandidates(
  sessions: SessionMeta[],
  liveById: Map<string, ActiveSession>,
  initialSearch?: string,
): Promise<SessionMeta[]> {
  if (sessions.length === 0) {
    console.log(chalk.gray('No sessions match the focus filters.'));
    return [];
  }
  const cols = {
    ...pickerColumnsFor(sessions),
    gutter: 6,
    showStatus: liveById.size > 0,
    showHost: liveById.size > 0,
  };
  try {
    const chosen = await multiItemPicker<SessionMeta>({
      message: 'Focus sessions:',
      items: sessions,
      filter: (query) => query.trim() ? filterSessionsByQuery(sessions, query) : sessions,
      labelFor: (session, query) => formatPickerLabel(
        session,
        query,
        cols,
        undefined,
        liveById.get(session.id)?.host,
        false,
        liveById.get(session.id),
      ),
      keyFor: (session) => session.id,
      buildPreview: (session) => {
        const headline = formatLiveStatusHeadline(liveById.get(session.id));
        const preview = buildPreview(session);
        return headline ? `${headline}\n${preview}` : preview;
      },
      pageSize: 15,
      initialSearch,
      emptyMessage: 'No sessions match.',
      enterHint: 'focus',
    });
    return chosen ?? [];
  } catch (err) {
    if (isPromptCancelled(err)) return [];
    throw err;
  }
}

export function focusTargetForResolved(
  poolMatch: SessionMeta | undefined,
  resolved: SessionMeta,
): SessionMeta {
  return poolMatch ?? resolved;
}

export async function focusResolvedSession(
  meta: SessionMeta,
  liveById: Map<string, ActiveSession>,
  self: string,
  fallback: UnreachableFallback,
  attachOnly: boolean,
  reconnectReattach: boolean = false,
): Promise<void> {
  const active = liveById.get(meta.id);
  if (active && isAttachableLiveSession(active)) {
    await jumpTo(active, self, fallback, meta.id);
    return;
  }
  if (active && await focusEditorTabOf(active, self)) return;
  if (attachOnly) {
    console.log(chalk.yellow(`${meta.shortId} has no living process or pane to attach.`));
    process.exitCode = 1;
    return;
  }
  if (reconnectReattach) {
    console.error(chalk.yellow(
      `\nWarning: ${meta.shortId}'s pane is gone (reboot, tmux crash, or agent exited).`
    ));
    console.error(chalk.gray(
      `  Prior context is in the transcript — starting recovery.\n` +
      `  To see what happened: agents sessions preview ${meta.shortId}`
    ));
  }
  const remote = sessionProcessHost(meta, self);
  if (remote) {
    console.log(chalk.gray(`Recovering ${meta.shortId} on ${remote}…`));
    const rc = await runOnPeer(sessionRecoveryRunArgs(meta), remote, { tty: true, sessionId: meta.id });
    if (rc === 'no-target') {
      console.error(chalk.red(`Cannot recover ${meta.shortId}: ${remote} is unreachable.`));
      process.exitCode = 1;
    }
    return;
  }
  await resumeSessionInPlace(meta);
}

export async function focusSelectedSession(
  meta: SessionMeta,
  active: ActiveSession | undefined,
  self: string,
): Promise<void> {
  if (active && !active.sessionId) {
    if (isAttachableLiveSession(active)) {
      await jumpTo(active, self, resumeInNewTab);
      return;
    }
    console.log(chalk.yellow('This live session has no session id or living attach rail to focus.'));
    console.log(chalk.gray(addressabilityRecoveryHint(active, meta.id)));
    process.exitCode = 1;
    return;
  }
  const liveById = active ? new Map([[meta.id, active]]) : new Map<string, ActiveSession>();
  await focusResolvedSession(meta, liveById, self, resumeInNewTab, false);
}

function activeFromMeta(meta: SessionMeta): ActiveSession {
  return {
    context: 'headless',
    kind: meta.agent,
    sessionId: meta.id,
    cwd: meta.cwd,
    project: meta.project,
    topic: meta.topic,
    startedAtMs: Date.parse(meta.timestamp),
    status: 'closed',
    machine: meta.machine,
  };
}

function describeScope(statuses: LiveStatusFilter[], hosts: string[]): string {
  const parts: string[] = [];
  if (statuses.length) parts.push(statuses.map(statusWord).join('/'));
  if (hosts.length) parts.push(`on ${hosts.join(', ')}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

type FocusSurfacePlan =
  | { kind: 'attach'; command: string[]; note: string }
  | { kind: 'resume'; command: string[]; note: string }
  | { kind: 'skip'; note: string };

export function tmuxAttachScript(mux: { socket?: string; pane: string }): string {
  const sock = mux.socket ? `-S ${shellQuote(mux.socket)} ` : '';
  const p = shellQuote(mux.pane);
  return (
    `dead=$(tmux ${sock}display-message -pt ${p} -p '#{pane_dead}' 2>/dev/null) || { echo 'agents: tmux pane is missing'; exit 42; }; ` +
    `[ "$dead" = 0 ] || { echo 'agents: tmux pane is dead'; exit 42; }; ` +
    `sess=$(tmux ${sock}display-message -pt ${p} '#{session_name}' 2>/dev/null); ` +
    `exec tmux ${sock}attach-session -t "\${sess:-${p}}"`
  );
}

export function planFocusSurface(
  s: ActiveSession,
  self: string,
  resumeCommandFor: (s: ActiveSession) => string[] | null,
  rail: AttachRailLiveness = { state: 'alive' },
): FocusSurfacePlan {
  const remote = sessionProcessHost(s, self);
  const mux = s.provenance?.mux;
  const sid = shortId(s);

  if (mux?.kind === 'tmux' && mux.pane && rail.state === 'alive') {
    const script = tmuxAttachScript({ socket: mux.socket, pane: mux.pane });
    if (remote) {
      assertValidSshTarget(remote);
      return {
        kind: 'attach',
        command: ['ssh', '-tt', remote, shellQuote(script)],
        note: `attach ${mux.pane} on ${remote}`,
      };
    }
    return { kind: 'attach', command: ['sh', '-c', shellQuote(script)], note: `attach ${mux.pane}` };
  }

  if (remote) {
    const command = resumeCommandFor(s);
    if (!command) return { kind: 'skip', note: `${sid} has no recovery command` };
    assertValidSshTarget(remote);
    return {
      kind: 'resume',
      command: ['ssh', '-tt', remote, shellQuote(command.map(shellQuote).join(' '))],
      note: `recover on ${remote} (no living tmux pane to join)`,
    };
  }
  const cmd = resumeCommandFor(s);
  if (!cmd) return { kind: 'skip', note: `${sid} — ${s.kind} sessions can't be resumed, and it has no live tmux to join` };
  return { kind: 'resume', command: cmd, note: 'resume a copy (no live tmux to join)' };
}

type OpenSurfacesFn = typeof openSurfaces;

interface OpenFocusTabsDeps {
  open?: OpenSurfacesFn;
  backend?: Backend | 'inplace';
  metas?: SessionMeta[];
  probe?: typeof probeAttachRail;
  attachOnly?: boolean;
}

export async function openFocusTabs(
  targets: ActiveSession[],
  self: string,
  deps: OpenFocusTabsDeps = {},
): Promise<void> {
  const open = deps.open ?? openSurfaces;
  const probe = deps.probe ?? probeAttachRail;
  let byId = new Map<string, SessionMeta>((deps.metas ?? []).map((m) => [m.id, m]));
  if (!deps.metas) {
    try {
      const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
      byId = new Map(metas.map((m) => [m.id, m]));
    } catch {  }
  }
  const metaFor = (s: ActiveSession): SessionMeta => byId.get(s.sessionId ?? '') ?? metaFromActive(s);
  const resumeCommandFor = (s: ActiveSession): string[] | null => {
    if (deps.attachOnly) return null;
    const remote = !sessionProcessIsLocal(s, self);
    return buildSessionRecoveryCommand(metaFor(s), remote);
  };

  const planned = await Promise.all(targets.map(async (s) => {
    const rail = await probe(s, self);
    return { s, plan: planFocusSurface(s, self, resumeCommandFor, rail) };
  }));

  for (const p of planned) if (p.plan.kind === 'skip') console.log(chalk.yellow(`  skip ${p.plan.note}`));
  const openable = planned.filter((p): p is { s: ActiveSession; plan: Exclude<FocusSurfacePlan, { kind: 'skip' }> } => p.plan.kind !== 'skip');
  if (openable.length === 0) {
    console.log(chalk.gray('Nothing to open in the selection.'));
    return;
  }

  const backend = deps.backend ?? (await resolveBackend({}, currentContext(), openable.length));
  if (backend === 'cancel') return;

  if (openable.length > CONFIRM_THRESHOLD) {
    const proceed = await confirm({ message: `Open ${openable.length} sessions at once?`, default: false }).catch(() => false);
    if (!proceed) return;
  }

  if (backend === 'inplace') {
    if (openable.length > 1) {
      console.log(chalk.yellow(`This terminal can't open tabs — jumping to the first; open in Ghostty/iTerm/tmux to focus several at once.`));
    }
    await jumpTo(openable[0].s, self, selectFallback(deps.attachOnly));
    return;
  }

  console.log(chalk.gray(`Opening ${openable.length} session${openable.length === 1 ? '' : 's'} in ${backend} (tabs)…`));
  const results = await open(
    openable.map((p) => ({
      cwd: cwdFor(p.s, byId),
      command: p.plan.command,
      agent: p.s.kind || undefined,
      sessionId: p.s.sessionId || undefined,
    })),
    { backend, packing: 'tabs' },
  );
  let opened = 0;
  results.forEach((r, i) => {
    const p = openable[i];
    if (r.ok) {
      opened++;
      console.log(chalk.green(`  opened ${shortId(p.s)}`) + chalk.gray(` — tab — (${p.plan.note})`));
    } else {
      console.log(chalk.red(`  failed ${shortId(p.s)} — ${r.error}`));
    }
  });
  console.log(chalk.gray(`\nOpened ${opened}/${openable.length} in ${backend}.`));
}

function cwdFor(s: ActiveSession, byId: Map<string, SessionMeta>): string {
  const cwd = byId.get(s.sessionId ?? '')?.cwd ?? s.cwd;
  return cwd && fs.existsSync(cwd) ? cwd : process.cwd();
}

function shortId(s: ActiveSession): string {
  return (s.sessionId ?? '').slice(0, 8) || '-';
}

export function metaFromActive(s: ActiveSession): SessionMeta {
  return {
    id: s.sessionId ?? '',
    shortId: shortId(s),
    agent: s.kind as SessionAgentId,
    timestamp: new Date(s.startedAtMs ?? Date.now()).toISOString(),
    filePath: '',
    cwd: s.cwd,
  };
}

async function richMetaById(id: string): Promise<SessionMeta | undefined> {
  try {
    const metas = await discoverSessions({ all: true, since: '90d', limit: 2000 });
    return metas.find((m) => m.id === id) ?? metas.find((m) => m.id.startsWith(id));
  } catch {
    return undefined;
  }
}

const resumeInNewTab: UnreachableFallback = async (s, remote) => {
  const id = s.sessionId ?? '';
  if (!id) {
    console.log(chalk.yellow('This session has no id to resume.'));
    return;
  }

  if (remote) {
    console.log(chalk.gray(`${shortId(s)} has no live terminal on ${remote} — resuming it there over SSH…`));
    const rc = await runOnPeer(sessionRecoveryRunArgs({ id }), remote, { tty: true, sessionId: id });
    if (rc === 'no-target') {
      console.log(chalk.red(`${remote} isn't reachable as a device. Try: agents devices sync`));
      console.log(chalk.gray(`  recovery must run on ${remote}, where the indexed session originated`));
    }
    return;
  }

  const meta = (await richMetaById(id)) ?? metaFromActive(s);
  const command = buildSessionRecoveryCommand(meta);
  const cwd = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : process.cwd();

  const ctx = currentContext();
  const backend: Backend | undefined = detectCurrentBackend(ctx) ?? availableBackends(ctx)[0]?.id;
  if (!backend) {
    await resumeSessionInPlace(meta);
    return;
  }

  console.log(chalk.gray(`${shortId(s)} has no live terminal to attach — opening a new ${backend} tab and resuming a copy.`));
  const results = await openSurfaces([{ cwd, command }], { backend, packing: 'tabs' });
  const r = results[0];
  if (!r || !r.ok) {
    console.log(chalk.red(`  failed to open — ${r?.error ?? 'unknown error'}`));
    console.log(chalk.gray(`  try: agents sessions resume ${meta.shortId}`));
  }
};
