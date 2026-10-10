import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import {
  computeSummaryStats,
  filterEvents,
  inferSessionState,
  linearIssueUrl,
  linkPath,
  linkUrl,
  parseRoleList,
  parseSession,
  renderConversationMarkdown,
  renderJson,
  renderSummary,
  renderSummaryHeader,
  safeTeamText,
  sessionDisplayAgent,
  shortenModel,
  type FilterOptions,
  type SessionMeta,
  type TodoProgress,
  type ViewMode,
} from '@phnx-labs/sessions-cli/reader';
import { colorAgent } from '../agents.js';
import { padRight, truncate } from '../format.js';
import { renderMarkdown } from '../markdown.js';
import { homeDir, toComparablePath } from '../platform/index.js';
import { redactSecrets } from '../redact.js';
import type { ActiveSession } from './active.js';
import { listBookmarks } from './bookmarks.js';
import { readArchivedSessionPreview, readSessionContent } from './db.js';
import { formatRelativeTime, sessionAgeParts, type SessionAgeParts } from './relative-time.js';
import { ticketLabel } from './selection.js';
import { sessionHeadline } from './title.js';
import { padToWidth, stringWidth, terminalWidth, truncateToWidth } from './width.js';

export function signalBadges(s: Pick<ActiveSession, 'awaitingReason' | 'pr' | 'worktree' | 'ticket'>): string {
  const parts: string[] = [];
  if (s.awaitingReason === 'plan_review') parts.push(chalk.yellow('plan'));
  else if (s.awaitingReason === 'question') parts.push(chalk.yellow('ask'));
  else if (s.awaitingReason === 'permission') parts.push(chalk.yellow('perm'));
  if (s.ticket) {
    const url = linearIssueUrl(s.ticket.id);
    parts.push(chalk.cyan(url ? linkUrl(url, s.ticket.id) : s.ticket.id));
  }
  if (s.pr) {
    const label = `PR#${s.pr.number ?? '?'}`;
    parts.push(chalk.blue(s.pr.url ? linkUrl(s.pr.url, label) : label));
  }
  if (s.worktree) parts.push(chalk.magenta(`wt:${s.worktree.slug}`));
  return parts.join(' ');
}

export interface TranscriptRenderOptions {
  json?: boolean;
  markdown?: boolean;
  redact?: boolean;
  include?: string;
  exclude?: string;
  first?: string;
  last?: string;
}

export function metaSignals(s: SessionMeta): Parameters<typeof signalBadges>[0] {
  return {
    pr: s.prUrl ? { url: s.prUrl, number: s.prNumber } : undefined,
    worktree: s.worktreeSlug ? { path: s.cwd ?? '', slug: s.worktreeSlug } : undefined,
    ticket: s.ticketId ? { id: s.ticketId } : undefined,
  };
}

export function buildFilterOptions(options: TranscriptRenderOptions): FilterOptions {
  const opts: FilterOptions = {};
  if (options.include) opts.include = parseRoleList(options.include, '--include');
  if (options.exclude) opts.exclude = parseRoleList(options.exclude, '--exclude');
  if (opts.include && opts.exclude) {
    throw new Error('--include and --exclude are mutually exclusive');
  }
  const parseCount = (raw: string, flag: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} expects a positive integer, got "${raw}"`);
    }
    return n;
  };
  if (options.first !== undefined) opts.first = parseCount(options.first, '--first');
  if (options.last !== undefined) opts.last = parseCount(options.last, '--last');
  if (opts.first !== undefined && opts.last !== undefined) {
    throw new Error('--first and --last are mutually exclusive');
  }
  return opts;
}

export function hasAnyFilter(opts: FilterOptions): boolean {
  return !!(opts.include?.length || opts.exclude?.length || opts.first !== undefined || opts.last !== undefined);
}

export function resolveViewMode(options: TranscriptRenderOptions, filters: FilterOptions): ViewMode {
  if (options.markdown) return 'markdown';
  if (options.json) return 'json';
  if (hasAnyFilter(filters)) return 'markdown';
  return 'summary';
}

export async function renderSessionLog(session: SessionMeta, mode: ViewMode = 'summary'): Promise<void> {
  await renderSession(session, mode, {});
}

export async function renderSessionLogJson(session: SessionMeta): Promise<void> {
  await renderSession(session, 'json', {});
}

function renderArchivedSession(
  session: SessionMeta,
  mode: ViewMode,
  options: { redact?: boolean } = {},
): void {
  const redact = (text: string): string => options.redact !== false ? redactSecrets(text) : text;
  const content = redact((readSessionContent(session.id) ?? '').trim());
  const digestRaw = readArchivedSessionPreview<{ lastAssistant?: string }>(session.id);
  const digest = digestRaw
    ? { ...digestRaw, lastAssistant: redact(digestRaw.lastAssistant ?? '') }
    : undefined;
  if (mode === 'json') {
    console.log(JSON.stringify({
      session: {
        ...session,
        topic: session.topic != null ? redact(session.topic) : session.topic,
        label: session.label != null ? redact(session.label) : session.label,
        plan: session.plan != null ? redact(session.plan) : session.plan,
        archived: true,
      },
      archived: true,
      userContent: content,
      preview: digest ?? null,
    }, null, 2));
    return;
  }
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const absTime = formatAbsoluteTime(session.timestamp);
  const title = sessionHeadline(session);
  console.log('');
  if (title) console.log(chalk.bold.white(title));
  console.log(
    agentColor(shown) +
    (session.version ? chalk.yellow(` ${session.version}`) : '') +
    (session.project ? chalk.cyan(`  ${session.project}`) : '') +
    chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
    (session.account ? chalk.gray(` · ${session.account}`) : '')
  );
  console.log(chalk.yellow('archived — transcript file removed; user turns served from the local DB'));
  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.cyan('User:'));
  console.log(content);
  if (digest?.lastAssistant?.trim()) {
    console.log('');
    console.log(chalk.magenta('Last assistant:'));
    console.log(digest.lastAssistant.trim());
  }
}

export async function renderSession(
  session: SessionMeta,
  mode: ViewMode,
  filters: FilterOptions,
  options: { redact?: boolean } = {},
): Promise<void> {
  const { hydrateSessionTranscript } = await import('./discover.js');
  session = await hydrateSessionTranscript(session);
  const realPath = session.filePath.split('#')[0];
  if (!fs.existsSync(realPath)) {
    const archivedContent = readSessionContent(session.id);
    if (archivedContent && archivedContent.trim() !== '') {
      renderArchivedSession(session, mode, options);
      return;
    }
    process.exitCode = 1;
    console.log(chalk.yellow('Session transcript is unavailable after checking its recorded home and the session index.'));
    console.log(chalk.gray(`Path: ${session.filePath}`));
    if (session.version) console.log(chalk.gray(`Version: ${sessionDisplayAgent(session)} ${session.version}`));
    if (session.project) console.log(chalk.gray(`Project: ${session.project}`));
    if (session.account) console.log(chalk.gray(`Account: ${session.account}`));
    console.log(chalk.gray(`Time: ${session.timestamp}`));
    return;
  }

  const spinner = ora(`Parsing ${sessionDisplayAgent(session)} session...`).start();
  const parsedEvents = parseSession(session.filePath, session.agent);
  spinner.stop();

  let events = filterEvents(parsedEvents, filters);

  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  console.log('');

  if (mode === 'summary') {
    const stats = computeSummaryStats(events);
    const modelStr = stats.models.length > 0 ? chalk.yellow(`  ${stats.models.join(', ')}`) : '';
    const branchStr = session.gitBranch ? chalk.gray(` (${session.gitBranch})`) : '';
    const absTime = formatAbsoluteTime(session.timestamp);

    const title = sessionHeadline(session);
    if (title) {
      const badges = signalBadges(metaSignals(session));
      console.log(chalk.bold.white(title) + (badges ? '  ' + badges : ''));
    }
    console.log(
      agentColor(shown) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      modelStr +
      (session.project ? chalk.cyan(`  ${session.project}`) + branchStr : branchStr) +
      chalk.gray(`  ${absTime} (${formatRelativeTime(session.timestamp)})`) +
      (session.account ? chalk.gray(` · ${session.account}`) : '')
    );
    const statsLine = renderSummaryHeader(stats);
    if (statsLine) console.log(chalk.gray(statsLine));
    console.log(chalk.gray('─'.repeat(60)));

    process.stdout.write(renderSummary(events, session.cwd));
    return;
  }

  if (mode === 'markdown') {
    console.log(
      agentColor(shown) +
      (session.version ? chalk.yellow(` ${session.version}`) : '') +
      (session.project ? chalk.cyan(` ${session.project}`) : '') +
      chalk.gray(` ${formatRelativeTime(session.timestamp)}`) +
      (session.account ? chalk.gray(` (${session.account})`) : '')
    );
    console.log(chalk.gray('─'.repeat(60)));
    process.stdout.write(renderMarkdown(renderConversationMarkdown(events, { redact: options.redact !== false })));
    return;
  }

  const todos = inferSessionState(parsedEvents, { cwd: session.cwd }).todos;
  process.stdout.write(
    renderJson(events, todos ? { ...session, todos } : session, { redact: options.redact !== false }),
  );
}

function formatAbsoluteTime(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
}

export function formatTodoCompact(todos?: Pick<TodoProgress, 'done' | 'total' | 'activeForm'> | null): string {
  if (!todos || !Number.isFinite(todos.total) || todos.total < 1) return '';
  const done = Number.isFinite(todos.done) ? Math.max(0, todos.done) : 0;
  const tally = `✓${done}/${todos.total}`;
  const step = todos.activeForm?.replace(/\s+/g, ' ').trim();
  return step ? `${tally} · ${step}` : tally;
}

export function statusColor(status: ActiveSession['status']): (s: string) => string {
  switch (status) {
    case 'running': return chalk.green;
    case 'idle': return chalk.gray;
    case 'queued': return chalk.blue;
    case 'input_required': return chalk.yellow;
    case 'closed': return chalk.dim;
    case 'abandoned': return chalk.red;
    case 'crashed': return chalk.redBright;
    case 'orphaned': return chalk.yellow;
    case 'unknown': return chalk.magenta;
  }
}

export function cleanPreview(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/<\/?(?:local-command-stdout|command-name|command-message|command-args|task-notification|system-reminder)>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildSessionDescription(s: ActiveSession): string {
  const todo = formatTodoCompact(s.todos);
  if (s.context === 'cloud') {
    const base = s.preview || `${s.cloudProvider ?? ''}${s.cloudTaskId ? ` · ${s.cloudTaskId.slice(0, 12)}` : ''}`;
    return cleanPreview([todo, base].filter(Boolean).join(' · '));
  }
  if (s.context === 'teams') {
    const parts = [s.teamName];
    if (s.label && s.label !== s.teamName) parts.push(s.label);
    const orch = s.orchestratorLabel || (s.orchestratorSessionId ? s.orchestratorSessionId.slice(0, 8) : '');
    if (orch) parts.push(`by ${orch}`);
    if (todo) parts.push(todo);
    const target = s.preview || s.assignedTask || s.topic;
    if (target) parts.push(target);
    return cleanPreview(parts.filter(Boolean).join(' · '));
  }

  // ladder-exempt: compact live preview base, not the row's headline.
  const base = s.preview || s.label || s.topic || '';
  return cleanPreview([todo, base].filter(Boolean).join(' · '));
}

export function liveGlyphAndPreview(a: ActiveSession | undefined): { glyph: string; preview: string } {
  if (!a) return { glyph: '', preview: '' };
  if (a.status === 'abandoned') return { glyph: statusColor(a.status)('⊘'), preview: buildSessionDescription(a) };
  if (a.status === 'closed') return { glyph: statusColor(a.status)('×'), preview: buildSessionDescription(a) };
  if (a.status === 'crashed') return { glyph: statusColor(a.status)('✗'), preview: buildSessionDescription(a) };
  if (a.status === 'orphaned') return { glyph: statusColor(a.status)('◍'), preview: buildSessionDescription(a) };

  const waiting = a.status === 'input_required' || a.activity === 'waiting_input';
  const running = a.status === 'running' || a.activity === 'working';
  const unknown = a.status === 'unknown';
  const shape =
    waiting ? '◐'
      : running ? '●'
        : unknown ? '◌'
          : '○';
  return { glyph: statusColor(a.status)(shape), preview: buildSessionDescription(a) };
}

export function liveStatusWord(a: ActiveSession | undefined): string {
  if (!a) return '';
  if (a.status === 'closed' || a.status === 'abandoned') return a.status;
  if (a.status === 'crashed') return 'crashed';
  if (a.status === 'orphaned') return 'orphan';
  if (a.status === 'input_required' || a.activity === 'waiting_input') return 'waiting';
  if (a.status === 'running' || a.activity === 'working') return 'working';
  if (a.status === 'idle' || a.activity === 'idle') return 'idle';
  if (a.status === 'queued') return 'queued';
  return '';
}

export function isAwaitingUser(s: ActiveSession): boolean {
  if (s.status === 'crashed' || s.status === 'closed') return false;

  if (s.status === 'abandoned' && s.pidAlive !== true) return false;
  return s.status === 'input_required' || s.activity === 'waiting_input';
}

export function shortCwd(cwd?: string): string {
  if (!cwd) return '-';
  const home = homeDir();
  return toComparablePath(cwd).startsWith(toComparablePath(home))
    ? '~' + cwd.slice(home.length)
    : cwd;
}

export const LIVE_STATUS_W = 8;

export function liveStatusCell(live: ActiveSession | undefined): { cell: string; width: number } {
  const word = liveStatusWord(live);
  if (!word || !live) return { cell: '', width: 0 };
  return { cell: statusColor(live.status)(padToWidth(word, LIVE_STATUS_W)), width: LIVE_STATUS_W };
}


function ticketUrl(s: Pick<SessionMeta, 'ticketId' | 'prNumber' | 'prUrl'>): string | undefined {
  if (s.ticketId) return linearIssueUrl(s.ticketId);
  return s.prNumber ? s.prUrl : undefined;
}

export function linkTicketCell(s: Pick<SessionMeta, 'ticketId' | 'prNumber' | 'prUrl'>, label: string): string {
  const url = ticketUrl(s);
  return url && label.trim() !== '-' ? linkUrl(url, label) : label;
}

export function linkCwdCell(s: Pick<SessionMeta, 'cwd' | '_remote'>, label: string): string {
  return s.cwd && !s._remote ? linkPath(s.cwd, label) : label;
}

function modelLabel(model?: string): string {
  return model ? shortenModel(model) : '-';
}

export function formatLiveStatusHeadline(live: ActiveSession | undefined, bookmarked = false): string {
  const star = bookmarked ? chalk.yellow('★ ') : '';
  if (!live) return bookmarked ? chalk.yellow('★ bookmarked') : '';
  const { glyph } = liveGlyphAndPreview(live);
  const word = liveStatusWord(live) || live.status;
  const needsYou = isAwaitingUser(live);
  const reason = live.awaitingReason ? ` (${live.awaitingReason.replace('_', ' ')})` : '';
  let suffix = needsYou ? chalk.yellow(`  ← needs you${reason}`) : '';
  if (live.status === 'crashed') {
    suffix = chalk.redBright('  ← the host app or connection went away and took the agent with it');
  } else if (live.status === 'orphaned') {
    suffix = needsYou
      ? chalk.yellow(`  ← waiting on you${reason}, and no client is attached to answer it`)
      : chalk.yellow('  ← still running, but no client is attached — nothing is showing it');
  }
  return `${star}${glyph} ${statusColor(live.status)(word)}${suffix}`;
}

export function teamTag(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (!origin) return '';
  const handle = safeTeamText(origin.handle);
  const team = safeTeamText(origin.team);
  if (team) return `[${team}${handle ? `/${handle}` : ''}] `;
  return handle ? `[${handle}] ` : '[team] ';
}

const TEAM_BADGE_MAX = 10;

export function teamBadge(session: SessionMeta): { plain: string; width: number } {
  const team = safeTeamText(session.spawnedTeam);
  if (!team) return { plain: '', width: 0 };
  const plain = `team:${truncate(team, TEAM_BADGE_MAX)} `;
  return { plain, width: stringWidth(plain) };
}

export function originTag(session: SessionMeta): string {
  if (session.origin !== 'routine') return '';
  return `[routine${session.routineName ? ` · ${session.routineName}` : ''}] `;
}

const MIN_TOPIC_W = 16;

export function timeCell(age: SessionAgeParts, topicSlack: number): { plain: string; text: string; extraW: number } {
  const lastOnly = { plain: age.last, text: chalk.gray(age.last), extraW: 0 };
  if (!age.created) return lastOnly;
  const prefix = `${age.created} → `;
  const extraW = stringWidth(prefix);
  if (topicSlack - extraW < MIN_TOPIC_W) return lastOnly;
  return { plain: prefix + age.last, text: chalk.dim(prefix) + chalk.gray(age.last), extraW };
}

export function flatSessionRow(
  session: SessionMeta,
  live?: ActiveSession,
  showTicket = false,
  cols: PickerColumns = {},
  bookmarked = false,
): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const project = session.project || '-';
  const tag = originTag(session) || teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const topicBase = tag ? `${tag}${session.topic ?? ''}` : session.topic;
  const doing = [restingTodo, preview || topicBase].filter(Boolean).join(' · ') || undefined;
  const wt = session.worktreeSlug ? chalk.magenta(`wt:${session.worktreeSlug}`) : '';
  const team = teamBadge(session);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';

  const machineColW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padToWidth(truncateToWidth((cols.machineLabel?.(session.machine ?? '') ?? session.machine ?? '') || '-', machineColW - 1), machineColW))
    : '';

  const TICKET_W = 10;
  const ticketCell = showTicket
    ? chalk.blue(linkTicketCell(session, padToWidth(truncateToWidth(ticketLabel(session) || '-', TICKET_W), TICKET_W + 1)))
    : '';
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const machineW = cols.showMachine ? machineColW : 0;
  const ticketW = showTicket ? TICKET_W + 1 : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const width = terminalWidth();
  const requestedModelW = cols.showModel ? (cols.modelWidth ?? PICKER_MODEL_MAX) : 0;
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  const fixedW = bookmarkW + (10 + 9 + 8 + 16) + glyphW + statusW + machineW + ticketW + wtW + team.width + stringWidth(age.last) + 1;
  const modelSlack = width - fixedW - MIN_TOPIC_W;
  const modelW = requestedModelW <= modelSlack
    ? requestedModelW
    : modelSlack >= PICKER_MODEL_MIN ? modelSlack : 0;
  const when = timeCell(age, width - fixedW - modelW);
  const topicW = Math.max(MIN_TOPIC_W, width - fixedW - modelW - when.extraW);

  return (
    bookmarkCell +
    chalk.white(padToWidth(truncateToWidth(session.shortId, 9), 10)) +
    agentColor(padToWidth(truncateToWidth(shown, 8), 9)) +
    chalk.yellow(padToWidth(truncateToWidth(session.version || '-', 7), 8)) +
    (modelW ? chalk.yellow(padToWidth(truncateToWidth(modelLabel(session.model), modelW - 1), modelW)) : '') +
    machineCell +
    chalk.cyan(linkCwdCell(session, padToWidth(truncateToWidth(project, 14), 16))) +
    (glyph ? glyph + ' ' : '') +
    statusCell +
    teamSeg +
    renderTopicCell(label, doing, '', topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    when.text
  );
}

export function treeSessionRow(session: SessionMeta, live?: ActiveSession): string {
  const shown = sessionDisplayAgent(session);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(session.timestamp, session.lastActivity);
  const tag = originTag(session) || teamTag(session);
  const label = (session as any).label;
  const { glyph, preview } = liveGlyphAndPreview(live);
  const restingTodo = !live ? formatTodoCompact(session.todos) : '';
  const topicBase = preview || (tag ? `${tag}${session.topic ?? ''}` : session.topic);
  const topic = [restingTodo, topicBase].filter(Boolean).join(' · ') || '-';
  const badges = signalBadges(metaSignals(session));
  const badgeW = badges ? stringWidth(badges) + 1 : 0;
  const team = teamBadge(session);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';
  const head = label ? `${label} · ${topic}` : topic;
  const { cell: statusCell, width: statusW } = liveStatusCell(live);
  const glyphW = glyph ? 2 : 0;
  const baseTopicW = terminalWidth() - (2 + 9 + 8) - glyphW - statusW - badgeW - team.width - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(12, baseTopicW - when.extraW);

  return (
    '  ' +
    chalk.dim(padToWidth(session.shortId, 9)) +
    agentColor(padToWidth(truncateToWidth(shown, 7), 8)) +
    (badges ? badges + ' ' : '') +
    (glyph ? glyph + ' ' : '') +
    statusCell +
    teamSeg +
    padToWidth(chalk.white(truncateToWidth(head, topicW)), topicW) +
    ' ' + when.text
  );
}

export function printSessionTable(sessions: SessionMeta[], hiddenCount = 0, tree = false, liveIndex?: Map<string, ActiveSession>): void {
  if (tree) {
    const byDir = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const key = s.cwd || s.project || 'unknown';
      (byDir.get(key) ?? byDir.set(key, []).get(key)!).push(s);
    }
    const keys = [...byDir.keys()].sort((a, b) => {
      const d = byDir.get(b)!.length - byDir.get(a)!.length;
      return d !== 0 ? d : a.localeCompare(b);
    });
    let first = true;
    for (const key of keys) {
      if (!first) console.log();
      first = false;
      const group = byDir.get(key)!;
      const cwd = group.find((s) => s.cwd && !s._remote)?.cwd;
      const header = cwd ? linkPath(cwd, shortCwd(key)) : shortCwd(key);
      console.log(`${chalk.cyan.bold(header)} ${chalk.gray(`(${group.length})`)}`);
      for (const s of group) console.log(treeSessionRow(s, liveIndex?.get(s.id)));
    }
    const dirWord = keys.length === 1 ? 'directory' : 'directories';
    console.log(chalk.gray(`\n${sessions.length} session${sessions.length === 1 ? '' : 's'} across ${keys.length} ${dirWord}.`));
    if (hiddenCount > 0) console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
    return;
  }

  const showTicket = sessions.some((s) => ticketLabel(s) !== '');
  const cols = pickerColumnsFor(sessions);
  const bookmarks = listBookmarks();
  for (const session of sessions) {
    console.log(flatSessionRow(session, liveIndex?.get(session.id), showTicket, cols, bookmarks.has(session.id)));
  }

  const countLine = `${sessions.length} session${sessions.length === 1 ? '' : 's'}.`;
  console.log(chalk.gray(`\n${countLine}`));
  if (hiddenCount > 0) {
    console.log(chalk.gray(formatTeamHiddenFooter(hiddenCount)));
  }
}

export function renderTopicCell(
  label: string | undefined | null,
  topic: string | undefined | null,
  query: string,
  visibleWidth: number,
  paddedWidth: number,
): string {
  const lbl = (label ?? '').trim();
  const tpc = (topic ?? '').trim();
  const sep = ' · ';
  const raw = lbl && tpc ? `${lbl}${sep}${tpc}` : (lbl || tpc);
  const visible = truncateToWidth(raw, visibleWidth);
  const padding = ' '.repeat(Math.max(0, paddedWidth - stringWidth(visible)));
  const labelEnd = lbl ? Math.min(lbl.length, visible.length) : 0;

  let matchStart = -1, matchEnd = -1;
  const q = query.trim().toLowerCase();
  if (q) {
    const lower = visible.toLowerCase();
    for (const term of q.split(/\s+/).filter(Boolean)) {
      const idx = lower.indexOf(term);
      if (idx !== -1) { matchStart = idx; matchEnd = idx + term.length; break; }
    }
  }

  const cuts = new Set<number>([0, labelEnd, visible.length]);
  if (matchStart >= 0) { cuts.add(matchStart); cuts.add(matchEnd); }
  const boundaries = [...cuts].sort((a, b) => a - b);

  let out = '';
  for (let i = 0; i < boundaries.length - 1; i++) {
    const s = boundaries[i], e = boundaries[i + 1];
    if (s >= e) continue;
    const text = visible.slice(s, e);
    const isLabel = s < labelEnd;
    const isMatch = matchStart >= 0 && s >= matchStart && e <= matchEnd;
    out += (isMatch || isLabel) ? chalk.bold.white(text) : chalk.white(text);
  }
  return out + padding;
}

export interface SshOriginTag {
  device?: string;
}

export interface PickerColumns {
  showMachine?: boolean;
  machineLabel?: (m: string) => string;
  machineWidth?: number;
  showModel?: boolean;
  modelWidth?: number;
  showTicket?: boolean;
  showHost?: boolean;
  showBookmark?: boolean;
  showStatus?: boolean;
  gutter?: number;
}

const PICKER_MACHINE_W = 11;
const PICKER_MACHINE_MIN = 8;
const PICKER_MACHINE_MAX = 18;
const PICKER_MODEL_MIN = 6;
const PICKER_MODEL_MAX = 13;

function machineColumnWidth(machines: string[], label: (m: string) => string): number {
  const widest = machines.reduce((w, m) => Math.max(w, stringWidth(label(m))), 0);
  return Math.min(PICKER_MACHINE_MAX, Math.max(PICKER_MACHINE_MIN, widest + 1));
}

function modelColumnWidth(sessions: SessionMeta[]): number {
  const widest = sessions.reduce((width, session) => (
    Math.max(width, session.model ? stringWidth(modelLabel(session.model)) : 0)
  ), 0);
  return Math.min(PICKER_MODEL_MAX, Math.max(PICKER_MODEL_MIN, widest + 1));
}

export function machineLabeler(machines: string[]): (m: string) => string {
  const uniq = [...new Set(machines.filter(Boolean))];
  if (uniq.length < 2) return (m) => m;
  const parts = uniq.map((m) => m.split('-'));
  const min = Math.min(...parts.map((p) => p.length));
  let shared = 0;
  while (shared < min - 1 && parts.every((p) => p[shared] === parts[0][shared])) shared++;
  if (shared === 0) return (m) => m;
  return (m) => {
    const p = m.split('-');
    return p.length > shared ? p.slice(shared).join('-') : m;
  };
}

export function pickerColumnsFor(sessions: SessionMeta[]): PickerColumns {
  const machines = sessions.map((s) => s.machine).filter((m): m is string => !!m);
  const distinct = [...new Set(machines)];
  const machineLabel = machineLabeler(machines);
  return {
    showMachine: distinct.length > 1,
    machineLabel,
    machineWidth: machineColumnWidth(distinct, machineLabel),
    showModel: sessions.some((s) => !!s.model),
    modelWidth: modelColumnWidth(sessions),
    showTicket: sessions.some((s) => ticketLabel(s) !== ''),
    showBookmark: (() => {
      const bookmarks = listBookmarks();
      return bookmarks.size > 0 && sessions.some((s) => bookmarks.has(s.id));
    })(),
  };
}

const PICKER_HOST_W = 14;

export function liveHostLabel(a: ActiveSession | undefined): string {
  if (!a?.host) return '';
  const viewer = a.viewingIn?.app;
  return viewer && viewer !== a.host ? `${a.host}→${viewer}` : a.host;
}

export function formatPickerLabel(
  s: SessionMeta,
  query: string,
  cols: PickerColumns = {},
  ssh?: SshOriginTag,
  host = '',
  bookmarked = false,
  live?: ActiveSession,
): string {
  const shown = sessionDisplayAgent(s);
  const agentColor = colorAgent(shown);
  const age = sessionAgeParts(s.timestamp, s.lastActivity);
  const project = s.project || '-';
  const sshPlain = ssh ? (ssh.device ? `ssh←${ssh.device} ` : 'ssh ') : '';
  const sshSeg = sshPlain ? chalk.red(sshPlain) : '';
  const sshW = sshPlain ? stringWidth(sshPlain) : 0;
  const team = teamBadge(s);
  const teamSeg = team.plain ? chalk.green(team.plain) : '';
  const tag = originTag(s) || teamTag(s);
  const label = (s as any).label;
  const topic = tag ? `${tag}${s.topic ?? ''}` : s.topic;
  const versionStr = s.version || '-';
  const wt = s.worktreeSlug ? chalk.magenta(`wt:${s.worktreeSlug}`) : '';

  const machineW = cols.machineWidth ?? PICKER_MACHINE_W;
  const machineCell = cols.showMachine
    ? chalk.gray(padRight(truncate((cols.machineLabel?.(s.machine ?? '') ?? s.machine ?? '') || '-', machineW - 1), machineW))
    : '';

  const TICKET_W = 10;
  const ticketCell = cols.showTicket
    ? chalk.blue(padRight(truncate(ticketLabel(s) || '-', TICKET_W), TICKET_W + 1))
    : '';

  const hostCell = cols.showHost
    ? chalk.gray(padRight(truncate(host || '-', PICKER_HOST_W - 1), PICKER_HOST_W))
    : '';

  const gutter = cols.gutter ?? 2;
  const machineColW = cols.showMachine ? machineW : 0;
  const ticketW = cols.showTicket ? TICKET_W + 1 : 0;
  const hostW = cols.showHost ? PICKER_HOST_W : 0;
  const wtW = wt ? stringWidth(wt) + 1 : 0;
  const bookmarkW = cols.showBookmark ? 2 : 0;
  const bookmarkCell = cols.showBookmark ? (bookmarked ? chalk.yellow('★ ') : '  ') : '';
  const status = cols.showStatus ? liveStatusCell(live) : { cell: '', width: 0 };
  const statusW = cols.showStatus ? LIVE_STATUS_W : 0;
  const statusCell = cols.showStatus ? (status.cell || ' '.repeat(LIVE_STATUS_W)) : '';
  const baseTopicW =
    terminalWidth() - gutter - bookmarkW - statusW - (10 + 9 + 8 + 16) - machineColW - hostW - ticketW - wtW - sshW - team.width - stringWidth(age.last) - 1;
  const when = timeCell(age, baseTopicW);
  const topicW = Math.max(MIN_TOPIC_W, baseTopicW - when.extraW);

  return (
    bookmarkCell +
    chalk.white(padRight(truncate(s.shortId, 9), 10)) +
    agentColor(padRight(truncate(shown, 8), 9)) +
    chalk.yellow(padRight(truncate(versionStr, 7), 8)) +
    machineCell +
    hostCell +
    chalk.cyan(padRight(truncate(project, 14), 16)) +
    statusCell +
    sshSeg +
    teamSeg +
    renderTopicCell(label, topic, query, topicW, topicW) +
    ticketCell +
    (wt ? wt + ' ' : '') +
    when.text
  );
}

const PICKER_TIPS: string[] = [
  'Tip: narrow with -a/--agent (e.g. -a codex), or --project <name> for another folder.',
  "Tip: --all searches every directory; -D/--device <machine> folds in another box's sessions.",
  'Tip: just type to fuzzy-search prompts and responses; press space to preview a session.',
  'Tip: --since 2d / --until <date> bound the time window; pass a session id to open it directly.',
];

export function formatPickerTip(sessions: SessionMeta[]): string {
  return chalk.gray(PICKER_TIPS[sessions.length % PICKER_TIPS.length]);
}

export function formatTeamHiddenFooter(hiddenCount: number): string {
  const noun = hiddenCount === 1 ? 'team session' : 'team sessions';
  return `(${hiddenCount} ${noun} hidden — use --teams to show, or \`agents teams status\`)`;
}
