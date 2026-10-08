import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ensureFeedPublishHook,
  listAskStats,
  listBlocks,
  recordNotified,
  buildDeclaredBlock,
  deriveBlockState,
  publishBlock,
  type OpenBlock,
} from '../lib/feed/feed.js';

import {
  ensureActivityLogHook,
  readRecentActivity,
  formatActivityLine,
  formatProgressUpdate,
  mergeActivityEvents,
  parseActivityPayload,
  type ActivityEvent,
  type EnrichedActivityEvent,
} from '../lib/feed/activity.js';
import { projectKeyFromCwd } from '../lib/project-key.js';
import { postFeedStatus } from '../lib/feed-post.js';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import {
  parseFeedPostLevel,
  planFeedBroadcast,
  runFeedBroadcast,
  effectiveBroadcastConfig,
  withDesktopNotify,
  blockBroadcastContext,
  blockDeliveryFailure,
  type FeedPostLevel,
  type SinkOutcome,
} from '../lib/feed-broadcast.js';
import { getSessionById, resolveFullSessionId } from '../lib/session/db.js';
import { fireTraceSyncInBackground } from '../lib/run-trace-sync.js';
import { readMeta } from '../lib/state.js';
import type { Meta } from '../lib/types.js';
import {
  enrichBlocksFromSessions,
  groupBlocksByOutcome,
  isUnambiguousOutcomeAnswer,
  openBlocksForOutcome,
  stampBlockOutcomes,
  type OutcomeGroup,
  type SessionOutcomeHint,
} from '../lib/feed-outcome.js';
import {
  classifyBlock,
  filterBlocksForFeed,
  suppressionDigest,
} from '../lib/ask-classifier.js';
import { machineId, normalizeHost } from '../lib/machine-id.js';
import { relTime } from '../lib/format.js';
import { gatherRemoteAgentsJson } from '../lib/remote-agents-json.js';
import { loadPolicy, applyPolicyToBlock, isPhoneUrgent } from '../lib/feed-policy.js';
import { notifyUrgentBlock } from '../lib/notify.js';
import { registerFeedWatchCommand } from './feed-watch.js';
import {
  AnswerError, answerOwnerIsLocal, checkAnswerDelivery, claimAndRouteAttentionAnswer, forwardFeedAnswer,
  parseAttentionKey, type FeedAnswerResult,
} from '../lib/feed/answer.js';
import { gcMailbox } from '../lib/mailbox-gc.js';
import { isValidMailboxId } from '../lib/mailbox.js';
import { getActiveSessions } from '../lib/session/active.js';
import { backfillActiveRowsFromMeta } from './sessions.js';
import { mailboxIdForActiveSession } from '../lib/mailbox-target.js';
import { GLYPH, masthead } from '../lib/comms-render.js';
import { discoverSessions } from '../lib/session/discover.js';
import { resolveProvider } from '../lib/cloud/registry.js';
import {
  buildSessionSignals,
  rankFeedBlocks,
  synthesizeControlCards,
  type FeedSessionSignal,
} from '../lib/feed-ranking.js';

interface PostCliOpts {
  title?: string;
  session?: string;
  attach?: string[];
  level?: string;
  blocked?: boolean;
  option?: string[];
  default?: string;
  notify?: boolean;
  json?: boolean;
}

export const FEED_POST_HELP = `
Examples:
  # Title (subject) + body. Phone broadcasts put title first, body after a
  # blank line, then a "Sent from agent/session on host" footer.
  agents feed post --title "CHANGELOG pushed" "Watching CI and mac-mini E2E"
  agents feed post --title "Cover ready" "render at ./out/cover.png" --attach ./out/cover.png
  agents feed post --title "Ready for review" "PR opened, waiting on prix-cloud" --json

  # Worth interrupting someone over - reaches sinks gated on minLevel: important:
  agents feed post --title "npm token expired" "Cannot publish the release" --level important

  # Also raise a local desktop banner on THIS machine (same notifier as run
  # --notify), on top of any configured broadcast - useful when you are at the box:
  agents feed post --title "Build green" "all checks passed" --notify

  # Stuck: opens a needs-you block and always broadcasts at important:
  agents feed post --title "Force-push denied" "git-guard blocked PR #1749" --blocked
  agents feed post --title "Publish or wait?" "npm publish now or after review" --blocked --option publish --option wait
  agents feed post --title "Delete preview env?" "stale preview still running" --blocked --default "leave it"

  # Exhaust self-serve FIRST. A block is for what you genuinely cannot do:
  # a credential only the user holds, a decision only they can make, an
  # approval only they can give. Not "should I do the obvious next step?".

  # Outside a run, pass the session explicitly:
  agents feed post --title "Manual note" "context for the next agent" --session 00998b0e-2d15-4d2f-a58b-974a886c9b47

Identity (session, agent, host, runtime, pid, launchId) is stamped automatically
and rides the phone footer of feed.broadcast {message}. Domain facts (tickets,
PRs) are not CLI flags - the ticket is joined from the session index at post
time. No em-dashes in title/body - they are scrubbed on the way out.

Configure where a post is mirrored under feed.broadcast in agents.yaml - see
docs/observability.md. A channel sink may set message: with placeholders such
as {message} and {ticket}; a missing placeholder skips that sink. A milestone is always recorded, but it does not reach
the owner when the sink has minLevel: important. Add --level important for a
phone-worthy successful update. Use --blocked only when work cannot continue.
With no sinks configured, an important post or a block reaches the owner through
your account (agents auth login); a block is a needs_you event and bypasses
quiet hours. The account's preferences pick email, Slack or iMessage.
`;

const FEED_NO_FANOUT_ENV = 'AGENTS_FEED_LOCAL';

export function formatFeedMastheadRight(blocks: OpenBlock[]): string {
  const agents = new Set(blocks.map((b) => b.mailboxId)).size;
  return `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`;
}

export function formatFeedReplyHint(mailboxId: string): string {
  return `↳ ag message ${mailboxId} "…"`;
}

export function parseRemoteFeed(stdout: string, machine: string): OpenBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const blocks: OpenBlock[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const block = item as Partial<OpenBlock>;
    if (!block.blockId || !block.sessionId || !block.mailboxId || !block.questions?.length) continue;
    if (!isValidMailboxId(block.mailboxId)) continue;
    blocks.push({ ...block, host: machine } as OpenBlock);
  }
  return blocks;
}

export function mergeFeedBlocks(...groups: OpenBlock[][]): OpenBlock[] {
  const byIdentity = new Map<string, OpenBlock>();
  for (const block of groups.flat()) {
    const key = `${normalizeHost(block.host)}:${block.blockId}`;
    if (!byIdentity.has(key)) byIdentity.set(key, block);
  }
  return [...byIdentity.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

type FeedControlAction = 'pause' | 'kill';

function matchesControlTarget(signal: FeedSessionSignal, target: string): boolean {
  return [
    signal.mailboxId,
    signal.sessionId,
    signal.cloudTaskId,
    signal.pid !== undefined ? String(signal.pid) : undefined,
  ].some((value) => value === target);
}

export async function controlFeedSession(
  action: FeedControlAction,
  target: string,
  signals: FeedSessionSignal[],
): Promise<string> {
  const signal = signals.find((s) => matchesControlTarget(s, target));
  if (!signal) throw new Error(`No live feed session matches '${target}'.`);

  if (signal.cloudProvider && signal.cloudTaskId) {
    const provider = resolveProvider(signal.cloudProvider);
    await provider.cancel(signal.cloudTaskId);
    return `${action === 'pause' ? 'paused' : 'killed'} cloud task ${signal.cloudTaskId}`;
  }

  if (!signal.pid) {
    throw new Error(`Session '${target}' has no local pid or cancellable cloud task.`);
  }

  if (action === 'pause') {
    if (process.platform === 'win32') {
      throw new Error('Pause is not supported for local Windows processes; use --kill.');
    }
    process.kill(signal.pid, 'SIGSTOP');
    return `paused pid ${signal.pid}`;
  }

  process.kill(signal.pid, 'SIGTERM');
  return `killed pid ${signal.pid}`;
}

function hostToken(host: string): string {
  return normalizeHost(host.split('@').pop() || host);
}

export function shouldIncludeLocalFeed(hosts: string[] | undefined, self: string): boolean {
  return !hosts?.length || hosts.some((host) => hostToken(host) === self);
}

export function remoteFeedHostsToDial(hosts: string[] | undefined, self: string): string[] | undefined {
  if (!hosts?.length) return undefined;
  return hosts.filter((host) => hostToken(host) !== self);
}

export function prepareLocalFeedBlocks(
  localBlocks: OpenBlock[],
  opts: { includeLocal: boolean; all?: boolean; dispatch?: boolean },
): { visible: OpenBlock[]; dispatch: OpenBlock[]; filter: ReturnType<typeof filterBlocksForFeed> } {
  const filter = filterBlocksForFeed(localBlocks, {
    apply: opts.includeLocal && (!opts.all || opts.dispatch === true),
  });
  return {
    visible: opts.all ? localBlocks : filter.surfaced,
    dispatch: filter.surfaced,
    filter,
  };
}

function renderBlock(b: OpenBlock, localHost: string, indent = ''): void {
  const host = b.host !== localHost ? chalk.yellow(` [${b.host}]`) : '';
  const runtime = chalk.gray(formatFeedRuntime(b));
  const age = chalk.gray(relTime(b.ts));
  const cls = b.blockClass ? chalk.gray(`(${b.blockClass})`) : '';
  const consequence = b.consequence && b.consequence !== 'normal' ? chalk.red(`[${b.consequence}]`) : '';
  const cost = b.costOfDelay ? chalk.gray(`cost:${b.costOfDelay}`) : '';
  const rank = b.delayRank ? chalk.gray(`rank:${Math.round(b.delayRank.score)}`) : '';
  const marker = deriveBlockState(b) !== 'open'
    ? chalk.green(GLYPH.delivered)
    : b.kind === 'control'
      ? chalk.red('!')
    : !b.parkedAt
      ? chalk.yellow(GLYPH.ask)
      : ' ';
  console.log(`${indent}${marker} ${chalk.cyan(b.mailboxId)}${host}  ${runtime}  ${age}  ${cls} ${consequence} ${cost} ${rank}`.trimEnd());
  for (const question of b.questions) {
    const header = question.header ? chalk.gray(`[${question.header}] `) : '';
    console.log(`${indent}  ${header}${question.text}`);
    if (question.options?.length) {
      for (let i = 0; i < question.options.length; i++) {
        const o = question.options[i];
        const desc = o.description ? chalk.gray(` -- ${o.description}`) : '';
        console.log(`${indent}    ${chalk.dim(`${i + 1}.`)} ${o.label}${desc}`);
      }
    }
  }
  if (b.ticket || b.pr || b.worktreeSlug) {
    const meta = [b.ticket, b.pr, b.worktreeSlug].filter(Boolean).join('  ');
    console.log(`${indent}  ${chalk.gray(meta)}`);
  }

  if (b.answer) {
    const verified = b.answer.verified ? chalk.green(GLYPH.delivered) : chalk.yellow('?');
    const who = b.answer.answeredFrom + (b.answer.answeredBy ? ` (${b.answer.answeredBy})` : '');
    const pending = deriveBlockState(b) === 'open';
    const label = pending ? chalk.yellow('claimed (delivery unconfirmed)') : chalk.green('answered');
    console.log(`${indent}  ${label} by ${who} ${verified}`);
  }
  if (b.parkedAt) {
    console.log(`${indent}  ${chalk.red('hard-parked')} ${relTime(b.parkedAt)}`);
  }
  if (b.defaultedAt) {
    console.log(`${indent}  ${chalk.yellow('defaulted')} ${relTime(b.defaultedAt)}`);
  }
  if (b.receipts && b.receipts.length > 0) {
    const latest = b.receipts[b.receipts.length - 1];
    console.log(`${indent}  ${chalk.dim('delivery:')} ${latest.status}`);
  }
  if (b.continuedAt) {
    console.log(`${indent}  ${chalk.green('continued')} ${relTime(b.continuedAt)}`);
  }
  if (b.notifiedAt) {
    console.log(`${indent}  ${chalk.dim('notified')} ${relTime(b.notifiedAt)}`);
  }
  if (b.runaway) {
    console.log(`${indent}  ${chalk.red('runaway:')} ${b.runaway.reason}`);
    console.log(`${indent}  ${chalk.dim(`control: ag feed --pause ${b.mailboxId}  ·  ag feed --kill ${b.mailboxId}`)}`);
  }
  if (b.needy) {
    console.log(`${indent}  ${chalk.yellow('needy:')} ${b.needy.askCountLastHour}/${b.needy.threshold} asks in the last hour`);
    console.log(`${indent}  ${chalk.dim(`inspect: ag sessions ${b.sessionId}`)}`);
  }

  if (!b.answer && !b.parkedAt && b.kind !== 'control') {
    console.log(`${indent}  ${chalk.dim(formatFeedReplyHint(b.mailboxId))}`);
  }
  console.log();
}

export function formatFeedRuntime(block: Pick<OpenBlock, 'runtime' | 'origin' | 'routineName'>): string {
  const host = ({
    ghostty: 'Ghostty',
    iterm: 'iTerm',
    terminal: 'terminal',
    kitty: 'Kitty',
    codium: 'VSCodium',
    code: 'VS Code',
    cursor: 'Cursor',
  } as Record<string, string>)[block.runtime.toLowerCase()] ?? block.runtime;
  if (block.origin !== 'routine') return host;
  return `${host} · routine${block.routineName ? `:${block.routineName}` : ''}`;
}

export function formatOutcomeHeader(group: OutcomeGroup): string {
  const { agents, open, answered, parked } = group.counts;
  const parts = [
    `${agents} agent${agents === 1 ? '' : 's'}`,
    open > 0 ? `${open} needs you` : null,
    answered > 0 ? `${answered} answered` : null,
    parked > 0 ? `${parked} parked` : null,
  ].filter(Boolean);
  return `${group.outcome.label} · ${parts.join(' · ')}`;
}

function renderOutcomeGroup(group: OutcomeGroup, localHost: string): void {
  console.log(chalk.bold(formatOutcomeHeader(group)));
  if (isUnambiguousOutcomeAnswer(group) && openBlocksForOutcome(group).length > 1) {
    const ids = openBlocksForOutcome(group).map((b) => b.mailboxId).join(', ');
    console.log(chalk.dim(`  same question on ${openBlocksForOutcome(group).length} agents — fan-out safe: ${ids}`));
  }
  for (const b of group.blocks) {
    renderBlock(b, localHost, '  ');
  }
}

export function sessionHintsFromActive(
  sessions: Array<{
    sessionId?: string;
    agentId?: string;
    cwd?: string;
    ticket?: { id?: string };
    pr?: { url?: string; number?: number };
    worktree?: { slug?: string };
    host?: string;
    origin?: 'cli' | 'routine';
    routineName?: string;
  }>,
): SessionOutcomeHint[] {
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    agentId: s.agentId,
    mailboxId: s.agentId ?? s.sessionId,
    ticketId: s.ticket?.id,
    prNumber: s.pr?.number,
    prUrl: s.pr?.url,
    worktreeSlug: s.worktree?.slug,
    project: s.cwd ? projectKeyFromCwd(s.cwd) : undefined,
    host: s.host,
    origin: s.origin,
    routineName: s.routineName,
  }));
}

export function isSqliteBusyError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : '';
  return /SQLITE_BUSY|database is locked/i.test(msg) || /SQLITE_BUSY/i.test(code);
}

export async function loadSessionMetasForFeedEnrichment<T>(
  load: () => Promise<T[]>,
): Promise<{ metas: T[]; skippedLock: boolean }> {
  try {
    return { metas: await load(), skippedLock: false };
  } catch (err) {
    if (isSqliteBusyError(err)) {
      return { metas: [], skippedLock: true };
    }
    throw err;
  }
}

function renderAnswerResult(result: FeedAnswerResult): string {
  switch (result.status) {
    case 'failed':
      return `Not delivered: ${result.reason ?? 'unknown failure'} — answering again is safe.`;
    case 'unknown':
      return `Delivery unconfirmed: ${result.reason ?? 'no rail reported a receipt.'} Run \`agents feed answer ${result.attentionKey} --check\` rather than resending.`;
    case 'already_answered':
      return `Already answered — ${result.receipt?.status ?? 'claimed'}${result.receipt ? ` as ${result.receipt.msgId}` : ''} at ${result.receipt?.at ?? result.attempt}.`;
    default:
      return `Delivered ${result.receipt?.msgId} (${result.receipt?.status}).`;
  }
}

export function registerFeedCommand(program: Command): void {
  const feed = program
    .command('feed')
    .description(
      'Operator inbox + agent status posts. Default is needs-you; agent progress = --filter updates',
    )
    .option('--json', 'Output as JSON (each block stamped with its outcome + ask class)')
    .option('--filter <view>', 'What to show: needs (default) · updates · all', 'needs')
    .option('--flat', 'List one block per agent instead of grouping by outcome')
    .option('--all', 'Include stalls/FYIs that policy would suppress (default: hide them)')
    .option('--local', 'Only this machine -- skip the cross-machine SSH fan-out')
    .option('-D, --device <target...>', 'Scope to remote machine(s) over SSH; repeatable')
    .option('--project <name>', 'Scope the feed to one project/repo (matches cwd basename, case-insensitive)')
    .option('--dispatch', 'Run stall suppression + default-on-no-answer policy and urgent notifications')
    .option('--pause <id>', 'Pause a runaway/needy local process (SIGSTOP) or cancel a cloud task')
    .option('--kill <id>', 'Kill a runaway/needy local process (SIGTERM) or cancel a cloud task');

  registerFeedWatchCommand(feed);

  feed.command('answer <attention-key>')
    .description('Atomically claim and deliver one answer to an open attention item')
    .option('--choice <choice-id>', 'Stable choice id from the attention item')
    .option('--text <answer>', 'Free-text answer')
    .option('--as <operator>', 'Verified operator id for high-consequence answers')
    .option('--check', 'Read-only: report this item\'s delivery state without claiming, routing or resending')
    .option('--attempt <at>', 'With --check: the attempt timestamp being checked, so a newer one is reported as such')
    .option('--json', 'Emit the delivery result as JSON')
    .action(async (attentionKey: string, opts: { choice?: string; text?: string; as?: string; check?: boolean; attempt?: string; json?: boolean }, invoked: Command) => {
      const wantsJson = Boolean(opts.json || (invoked.parent?.opts() as { json?: boolean } | undefined)?.json);
      try {
        const { host: ownerHost } = parseAttentionKey(attentionKey);
        const local = answerOwnerIsLocal(ownerHost);
        if (opts.check && (opts.choice != null || opts.text != null)) {
          throw new AnswerError('--check is read-only; it takes no --choice or --text.', 'empty_answer');
        }
        if (opts.attempt != null && !opts.check) {
          throw new AnswerError('--attempt only applies to --check.', 'empty_answer');
        }
        const result = opts.check
          ? (local
            ? checkAnswerDelivery(attentionKey, undefined, opts.attempt)
            : await forwardFeedAnswer({ host: ownerHost, attentionKey, check: true, attempt: opts.attempt, operatorId: opts.as }))
          : local
            ? await claimAndRouteAttentionAnswer({
              attentionKey, choiceId: opts.choice, text: opts.text,
              operator: { id: opts.as, verified: Boolean(opts.as), label: opts.as },
            })
            : await forwardFeedAnswer({ host: ownerHost, attentionKey, choiceId: opts.choice, text: opts.text, operatorId: opts.as });
        if (wantsJson) console.log(JSON.stringify(result));
        else console.log(renderAnswerResult(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (wantsJson) {
          const failure: FeedAnswerResult = {
            status: 'failed', delivery: 'failed', resolved: false, reason: message,
            code: error instanceof AnswerError ? error.code : 'rail_failed', attentionKey,
          };
          console.log(JSON.stringify(failure));
          process.exitCode = 1;
          return;
        }
        invoked.error(`error: ${message}`);
      }
    });

  feed
    .command('post')
    .description('Post a status update to the fleet activity stream (for agents)')
    .argument('<text...>', 'Body: what just happened (after --title)')
    .requiredOption('--title <title>', 'Short subject, ~4-5 words (phone first line)')
    .option('--session <id>', 'Session id escape hatch (default: auto from env / launch activity / pid registry)')
    .option('--attach <path-or-url...>', 'Attach an artifact (local file or URL); repeatable')
    .option('--level <level>', 'How loudly to broadcast: milestone (default) or important. Configured sinks with minLevel: important only fire on the latter.', 'milestone')
    .option('--blocked', 'You are STUCK and need the user. Opens an answerable block and always broadcasts at important - do not also pass --level.')
    .option('--option <label...>', 'With --blocked: an answer the user can pick; repeatable')
    .option('--default <answer>', 'With --blocked: a safe default policy may apply if nobody answers in time')
    .option('--notify', 'Also raise a local desktop banner on THIS machine (the same notifier as `run --notify`), on top of any configured broadcast. Fires at any level.')
    .option('--json', 'Emit the written event as JSON')
    .addHelpText('after', FEED_POST_HELP)
    .action(async (
      textParts: string[],
      opts: PostCliOpts,
      cmd?: { opts: () => PostCliOpts; parent?: { opts: () => { json?: boolean } } },
    ) => {
      const flags = {
        title: opts?.title ?? cmd?.opts?.()?.title,
        session: opts?.session ?? cmd?.opts?.()?.session,
        attach: opts?.attach ?? cmd?.opts?.()?.attach,
        level: opts?.level ?? cmd?.opts?.()?.level,
        blocked: Boolean(opts?.blocked ?? cmd?.opts?.()?.blocked),
        option: opts?.option ?? cmd?.opts?.()?.option,
        default: opts?.default ?? cmd?.opts?.()?.default,
        notify: Boolean(opts?.notify ?? cmd?.opts?.()?.notify),
        json: Boolean(opts?.json ?? cmd?.opts?.()?.json ?? cmd?.parent?.opts?.()?.json),
      };
      try {
        if (flags.blocked && flags.level && flags.level !== 'milestone') {
          throw new Error('--blocked already broadcasts at important; drop --level.');
        }
        if (!flags.blocked && (flags.option?.length || flags.default)) {
          throw new Error('--option/--default only apply with --blocked.');
        }
        if (!flags.title?.trim()) {
          throw new Error('Missing --title. Usage: agents feed post --title "Short subject" "body text"');
        }
        const level = flags.blocked ? 'important' : parseFeedPostLevel(flags.level);
        const meta = readMeta();

        const { event } = postFeedStatus({
          title: flags.title,
          text: Array.isArray(textParts) ? textParts.join(' ') : String(textParts ?? ''),
          sessionId: flags.session,
          attach: flags.attach,
          blocked: flags.blocked,
        });

        let outcomes: SinkOutcome[];
        if (flags.blocked) {
          const block = buildDeclaredBlock(
            {
              sessionId: event.sessionId,
              mailboxId: event.mailboxId,
              host: event.host,
              runtime: event.runtime,
              cwd: event.cwd,
            },
            {
              text: event.title
                ? (event.detail ? `${event.title}: ${event.detail}` : event.title)
                : (event.detail ?? ''),
              options: flags.option,
              safeDefault: flags.default,
            },
          );
          publishBlock(block);
          outcomes = await broadcastBlock(block, {
            project: event.project,
            agent: event.agent,
            title: event.title,
            body: event.detail,
          }, meta, flags.notify);
        } else {
          outcomes = await broadcastPostedEvent(event, level, meta, flags.notify);
        }

        const undelivered = blockDeliveryFailure(flags.blocked, outcomes);
        if (undelivered) process.exitCode = 1;

        if (flags.json) {
          console.log(JSON.stringify(outcomes.length ? { ...event, broadcast: outcomes } : event, null, 2));
          if (undelivered) console.error(chalk.red(undelivered));
          return;
        }
        console.log(formatProgressUpdate(event));
        reportBroadcast(outcomes);
        if (undelivered) console.error(chalk.red(undelivered));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 1;
      }
    });

  feed.action(async (opts: {
      json?: boolean;
      filter?: string;
      project?: string;
      flat?: boolean;
      all?: boolean;
      local?: boolean;
      device?: string[];
      dispatch?: boolean;
      pause?: string;
      kill?: string;
    }) => {
      const self = machineId();
      const filter = resolveFeedFilter(opts.filter);
      const includeLocal = shouldIncludeLocalFeed(opts.device, self);
      const setupWarnings: string[] = [];
      if (includeLocal) {
        const hookInstall = ensureFeedPublishHook();
        const activityInstall = ensureActivityLogHook();
        if (hookInstall.error) setupWarnings.push(hookInstall.error);
        if (activityInstall.error) setupWarnings.push(activityInstall.error);
        if (!hookInstall.error || !activityInstall.error) {
          const [{ iterHooksCapableVersions, parseHookManifest, registerHooksToSettings }, { getVersionHomePath }] = await Promise.all([
            import('../lib/hooks/install.js'),
            import('../lib/installations/versions.js'),
          ]);
          const manifest = parseHookManifest({ warn: false });
          for (const { agent, version } of iterHooksCapableVersions({ agent: 'claude' })) {
            const result = registerHooksToSettings(agent, getVersionHomePath(agent, version), manifest);
            if (result.errors.length > 0) {
              setupWarnings.push(`${agent}@${version}: ${result.errors.join('; ')}`);
            }
          }
        }
      }

      const renderTrailingActivity = async (): Promise<void> => {
        if (filter === 'all') {
          console.log();
          renderUpdatesView(await gatherStatusPosts({
            limit: UPDATES_VIEW_LIMIT, hosts: opts.device, local: opts.local, includeLocal, self, project: opts.project,
          }), opts.project);
          return;
        }
        if (includeLocal) renderActivityLane(opts.project);
      };

      if (filter === 'updates') {
        for (const warning of setupWarnings) {
          console.error(chalk.yellow(`Feed hook setup warning: ${warning}`));
        }
        const updates = await gatherStatusPosts({
          limit: opts.json ? UPDATES_JSON_LIMIT : UPDATES_VIEW_LIMIT,
          hosts: opts.device,
          local: opts.local,
          includeLocal,
          self,
        });
        if (opts.json) {
          console.log(JSON.stringify(updates, null, 2));
          return;
        }
        renderUpdatesView(updates, opts.project);
        return;
      }

      let sessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
      if (includeLocal) {
        sessions = await getActiveSessions();
      }
      let sessionMetas: Awaited<ReturnType<typeof discoverSessions>> = [];
      if (includeLocal && sessions.length > 0) {
        const loaded = await loadSessionMetasForFeedEnrichment(
          () => discoverSessions({ all: true, limit: 5000 }),
        );
        if (loaded.skippedLock) {
          console.error(chalk.yellow(
            'Feed: session index is locked; skipping local outcome enrichment',
          ));
        }
        sessionMetas = loaded.metas;
        backfillActiveRowsFromMeta(sessions, new Map(sessionMetas.map((meta) => [meta.id, meta])));
      }
      const localSignals = buildSessionSignals(sessions, sessionMetas);

      if (opts.pause || opts.kill) {
        if (!includeLocal) {
          throw new Error('Feed controls run on the local machine. Re-run against the target host with --local.');
        }
        const action = opts.pause ? 'pause' : 'kill';
        const target = opts.pause ?? opts.kill ?? '';
        console.log(await controlFeedSession(action, target, localSignals));
        return;
      }

      if (opts.dispatch && includeLocal) {
        const activeBoxIds = new Set(sessions.map(mailboxIdForActiveSession).filter((id): id is string => !!id));
        const gcResult = gcMailbox(activeBoxIds);
        if (gcResult.blocksRemoved > 0 || gcResult.messagesDroppedDead > 0) {
          console.log(
            chalk.yellow(`gc: ${gcResult.messagesDroppedDead} dead messages, ${gcResult.blocksRemoved} stale blocks removed`),
          );
        }
      }

      let localBlocks = includeLocal
        ? [...listBlocks(), ...synthesizeControlCards(localSignals, listAskStats())]
        : [];

      if (sessions.length > 0) {
        localBlocks = enrichBlocksFromSessions(localBlocks, sessionHintsFromActive(sessions));
      }

      const preparedLocal = prepareLocalFeedBlocks(localBlocks, {
        includeLocal,
        all: opts.all,
        dispatch: opts.dispatch,
      });
      const visibleLocalBlocks = preparedLocal.visible;
      const dispatchBlocks = preparedLocal.dispatch;

      let blocks = visibleLocalBlocks;
      const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
      if (!forceLocal) {
        const remoteHosts = remoteFeedHostsToDial(opts.device, self);
        if (!opts.device?.length || (remoteHosts && remoteHosts.length > 0)) {
          const remote = await gatherRemoteAgentsJson({
            args: ['feed', '--json'],
            noFanoutEnv: FEED_NO_FANOUT_ENV,
            hosts: remoteHosts,
            parse: parseRemoteFeed,
          });
          blocks = mergeFeedBlocks(visibleLocalBlocks, remote.items);
        }
      }

      blocks = rankFeedBlocks(blocks, localSignals).filter((b) => blockMatchesProject(b, opts.project));
      const dispatchBlocksProject = opts.project
        ? dispatchBlocks.filter((b) => blockMatchesProject(b, opts.project))
        : dispatchBlocks;
      const digest = suppressionDigest(preparedLocal.filter);
      if (digest && !opts.json) {
        console.log(chalk.dim(digest));
      }

      if (opts.dispatch) {
        const policy = loadPolicy();
        const now = new Date();
        for (const b of dispatchBlocksProject) {
          try {
            const result = applyPolicyToBlock(b, policy, now);
            if (result.action !== 'none') {
              console.log(`${chalk.yellow('policy')} ${b.blockId}: ${result.action}`);
            }
            if (isPhoneUrgent(b, policy)) {
              const notifyResult = await notifyUrgentBlock(b, { dryRun: opts.json });
              if (notifyResult.ok && !notifyResult.skipped) {
                recordNotified(b.blockId);
                console.log(`${chalk.green('notified')} ${b.blockId}`);
              } else if (notifyResult.error) {
                console.error(chalk.yellow(`Notification failed for ${b.blockId}: ${notifyResult.error}`));
              }
            }
          } catch (err) {
            console.error(chalk.yellow(`Skipped block ${b.blockId}: ${(err as Error).message}`));
          }
        }
      }

      for (const warning of setupWarnings) {
        console.error(chalk.yellow(`Feed hook setup warning: ${warning}`));
      }

      if (opts.json) {
        const stamped = stampBlockOutcomes(blocks).map((b) => ({
          ...b,
          ask: classifyBlock(b),
        }));
        console.log(JSON.stringify(stamped, null, 2));
        return;
      }

      if (blocks.length === 0) {
        console.log(chalk.gray(digest ? 'No open blocks after stall suppression.' : 'No open blocks.'));
        await renderTrailingActivity();
        return;
      }

      console.log(
        masthead({
          title: opts.project ? `${opts.project} needs you` : 'they need you',
          accent: 'amber',
          host: self,
          right: formatFeedMastheadRight(blocks),
        }),
      );
      console.log();

      if (opts.flat) {
        for (const b of blocks) renderBlock(b, self);
        return;
      }

      const groups = groupBlocksByOutcome(blocks).sort((a, b) => {
        const ar = Math.max(...a.blocks.map((block) => block.delayRank?.score ?? 0));
        const br = Math.max(...b.blocks.map((block) => block.delayRank?.score ?? 0));
        return br - ar;
      });
      for (const g of groups) renderOutcomeGroup(g, self);
      await renderTrailingActivity();
    });
}

async function broadcastPostedEvent(
  event: ActivityEvent,
  level: FeedPostLevel,
  meta: Meta,
  notify = false,
): Promise<SinkOutcome[]> {
  const config = withDesktopNotify(effectiveBroadcastConfig(meta.feed?.broadcast, level), notify);
  if (!config) return [];
  const session = resolveFullSessionId(event.sessionId) ?? event.sessionId;
  const ticket = getSessionById(session)?.ticketId;
  const planned = planFeedBroadcast(config, {
    title: event.title,
    text: event.detail ?? '',
    level,
    ticket,
    ticketUrl: linearIssueUrl(ticket),
    project: event.project,
    agent: event.agent,
    host: event.host,
    session,
    links: (event.attachments ?? [])
      .map((a) => a.href)
      .filter((href) => /^https?:\/\//i.test(href)),
    eventKey: `${session}:${event.ts}`,
  }, meta);
  if (level === 'important') fireTraceSyncInBackground();
  return runFeedBroadcast(planned, meta);
}

async function broadcastBlock(
  block: OpenBlock,
  extras: { project?: string; agent?: string; title?: string; body?: string },
  meta: Meta,
  notify = false,
): Promise<SinkOutcome[]> {
  const config = withDesktopNotify(effectiveBroadcastConfig(meta.feed?.broadcast, 'important'), notify);
  if (!config) return [];
  const sessionId = resolveFullSessionId(block.sessionId) ?? block.sessionId;
  const ticket = getSessionById(sessionId)?.ticketId;
  const ctx = blockBroadcastContext(
    { ...block, sessionId, ticket: block.ticket ?? ticket },
    extras,
  );
  fireTraceSyncInBackground();
  return runFeedBroadcast(planFeedBroadcast(config, ctx, meta), meta);
}

function reportBroadcast(outcomes: SinkOutcome[]): void {
  for (const o of outcomes) {
    if (o.ok && o.error) console.error(chalk.yellow(`  → ${o.name} partial: ${o.error}`));
    else if (o.ok) console.log(chalk.gray(`  → ${o.name}`));
    else console.error(chalk.yellow(`  → ${o.name} failed: ${o.error}`));
  }
}

type FeedFilter = 'needs' | 'updates' | 'all';

export function resolveFeedFilter(raw: string | undefined): FeedFilter {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'updates' || v === 'update') return 'updates';
  if (v === 'all') return 'all';
  return 'needs';
}

function blockMatchesProject(block: OpenBlock, project?: string): boolean {
  if (!project) return true;
  return (block.project ?? '').toLowerCase() === project.toLowerCase();
}

function eventMatchesProject(ev: EnrichedActivityEvent, project?: string): boolean {
  if (!project) return true;
  return ((ev.project ?? projectKeyFromCwd(ev.cwd) ?? '')).toLowerCase() === project.toLowerCase();
}

function renderActivityEntry(ev: ActivityEvent): void {
  if (ev.event === 'status.posted') {
    console.log(formatProgressUpdate(ev));
  } else {
    console.log(formatActivityLine(ev, { showHost: true }));
  }
}

const UPDATES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UPDATES_VIEW_LIMIT = 30;
const UPDATES_JSON_LIMIT = 100;

function readStatusPosts(limit: number): ActivityEvent[] {
  return readRecentActivity({
    sinceMs: Date.now() - UPDATES_WINDOW_MS,
    limit,
    events: ['status.posted'],
  });
}

async function gatherStatusPosts(opts: {
  limit: number;
  hosts?: string[];
  local?: boolean;
  includeLocal: boolean;
  self: string;
  project?: string;
}): Promise<EnrichedActivityEvent[]> {
  const local: EnrichedActivityEvent[] = opts.includeLocal
    ? readStatusPosts(opts.limit).filter((ev) => eventMatchesProject(ev, opts.project))
    : [];
  const forceLocal = opts.local === true || process.env[FEED_NO_FANOUT_ENV] === '1';
  if (forceLocal) return local.slice(0, opts.limit);
  const remoteHosts = opts.hosts?.length ? remoteFeedHostsToDial(opts.hosts, opts.self) : undefined;
  if (opts.hosts?.length && (!remoteHosts || remoteHosts.length === 0)) return local.slice(0, opts.limit);
  const remote = await gatherRemoteAgentsJson({
    args: ['feed', '--filter', 'updates', '--json'],
    noFanoutEnv: FEED_NO_FANOUT_ENV,
    hosts: remoteHosts,
    parse: parseActivityPayload,
  });
  const merged = mergeActivityEvents(local, remote.items).filter((ev) => eventMatchesProject(ev, opts.project));
  return merged.slice(0, opts.limit);
}

function renderUpdatesView(updates: ActivityEvent[], project?: string): void {
  const hosts = new Set(updates.map((e) => e.host).filter(Boolean));
  console.log(
    masthead({
      title: project ? `${project} updates` : 'updates',
      accent: 'cyan',
      host: hosts.size > 1 ? `${hosts.size} machines` : (updates[0]?.host ?? machineId()),
      right: `${updates.length} post${updates.length === 1 ? '' : 's'}`,
    }),
  );
  console.log();
  if (updates.length === 0) {
    console.log(chalk.gray('  No progress updates yet. Agents post them with `agents feed post --title "…" "…"`.'));
    return;
  }
  for (const ev of updates) {
    console.log(formatProgressUpdate(ev));
    console.log();
  }
}

function renderActivityLane(project?: string, limit = 6): void {
  const events = readRecentActivity({
    sinceMs: Date.now() - 24 * 60 * 60 * 1000,
    limit: limit * (project ? 4 : 1),
    tier: 'milestone',
  }).filter((ev) => eventMatchesProject(ev, project));
  if (events.length === 0) return;
  console.log(chalk.bold(project ? `\n  recent activity · ${project}` : '\n  recent activity'));
  for (const ev of events.slice(0, limit)) renderActivityEntry(ev);
  console.log(chalk.gray('  → agents feed --project ' + (project ?? '<project>') + '  for the full stream'));
}
