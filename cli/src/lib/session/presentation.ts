import * as fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import {
  computeSummaryStats,
  filterEvents,
  inferSessionState,
  linearIssueUrl,
  linkUrl,
  parseRoleList,
  parseSession,
  renderConversationMarkdown,
  renderJson,
  renderSummary,
  renderSummaryHeader,
  sessionDisplayAgent,
  type FilterOptions,
  type SessionMeta,
  type ViewMode,
} from '@phnx-labs/sessions-cli/reader';
import { colorAgent } from '../agents.js';
import { renderMarkdown } from '../markdown.js';
import { redactSecrets } from '../redact.js';
import type { ActiveSession } from './active.js';
import { readArchivedSessionPreview, readSessionContent } from './db.js';
import { formatRelativeTime } from './relative-time.js';
import { sessionHeadline } from './title.js';

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
