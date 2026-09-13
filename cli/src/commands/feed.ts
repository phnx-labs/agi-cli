/**
 * `agents feed` -- operator inbox + agent status posts.
 *
 * Default (`agents feed`): list open blocks (decisions agents are waiting on).
 * Aggregates block records from the local feed store and, with --device, from
 * reachable remote hosts via SSH passthrough. Each block carries enough
 * identity for `agents message` to route a reply back to the right agent.
 *
 * Default view groups by **outcome** (ticket / PR / worktree / Unassigned) so
 * an operator sees dozens of deliverables, not ~1,100 agents. Pass `--flat`
 * for the legacy per-agent list.
 *
 * `agents feed post`: agent-callable free-text progress into the activity
 * stream (milestone `status.posted`). Session/agent/host/runtime/pid identity
 * is auto-stamped from env + the pid registry — no domain-specific flags.
 * Humans watch via the feed activity lane.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  ensureFeedPublishHook,
  listAskStats,
  listBlocks,
  recordNotified,
  buildDeclaredBlock,
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
import { linearIssueUrl } from '../lib/session/linear.js';
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
import { claimAndRouteAttentionAnswer, forwardFeedAnswer } from '../lib/feed/answer.js';
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

/** Flags for `feed post`. Declared once — the action reads them off both the child and the parent. */
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
as {message} and {ticket}; a missing placeholder skips that sink. A milestone is always recorded, but it does not text
the owner when the sink has minLevel: important. Add --level important for a
phone-worthy successful update. Use --blocked only when work cannot continue.
The owner destination comes from humans.yaml; do not duplicate it in agents.yaml.
`;

const FEED_NO_FANOUT_ENV = 'AGENTS_FEED_LOCAL';

/** Right-hand masthead summary: `N blocks · M agents`. */
export function formatFeedMastheadRight(blocks: OpenBlock[]): string {
  const agents = new Set(blocks.map((b) => b.mailboxId)).size;
  return `${blocks.length} block${blocks.length === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`;
}

/** Reply hint matching the shared fleet-comms reply line. */
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
    // A crafted mailboxId (path separators, `.`/`..`) would throw inside
    // mailboxDir() when policy runs against the block, aborting the whole
    // dispatch loop — drop it here so a malicious peer can't smuggle one in.
    if (!isValidMailboxId(block.mailboxId)) continue;
    blocks.push({ ...block, host: machine } as OpenBlock);
  }
  return blocks;
}

/** Merge local and remote rows, keeping the first copy of a host/session block. */
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
  // Shared fleet-comms glyphs: ▲ open ask, ✓ answered (see comms-render GLYPH).
  const marker = b.answer
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
    console.log(`${indent}  ${chalk.green('answered')} by ${who} ${verified}`);
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

/** Specific host app + routine provenance for one feed row. */
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

/** Human summary line for one outcome rollup. */
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

/** Map active sessions into the lightweight hints outcome enrichment needs. */
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
    // Same precedence as mailboxIdForActiveSession (agentId ?? sessionId).
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

/**
 * True when a SQLite open/query failed because another writer holds the lock.
 * better-sqlite3 surfaces this as message "database is locked" and/or code
 * SQLITE_BUSY (RUSH-2006).
 */
export function isSqliteBusyError(err: unknown): boolean {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : '';
  return /SQLITE_BUSY|database is locked/i.test(msg) || /SQLITE_BUSY/i.test(code);
}

/**
 * Load session metas for feed outcome enrichment. The sessions index can be
 * locked by a concurrent scanner/daemon — enrichment is best-effort, so a lock
 * degrades to an empty list instead of crashing `agents feed` (RUSH-2006).
 *
 * `load` is injected so tests can throw a real lock-shaped error without
 * mocking the session module.
 */
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
    .option('--json', 'Emit the delivery result as JSON')
    .action(async (attentionKey: string, opts: { choice?: string; text?: string; as?: string; json?: boolean }, invoked: Command) => {
      try {
        const ownerHost = attentionKey.slice(0, attentionKey.indexOf('/'));
        const result = ownerHost && ownerHost !== machineId()
          ? await forwardFeedAnswer({ host: ownerHost, attentionKey, choiceId: opts.choice, text: opts.text, operatorId: opts.as })
          : await claimAndRouteAttentionAnswer({
            attentionKey, choiceId: opts.choice, text: opts.text,
            operator: { id: opts.as, verified: Boolean(opts.as), label: opts.as },
          });
        if (opts.json || (invoked.parent?.opts() as { json?: boolean } | undefined)?.json) console.log(JSON.stringify(result));
        else console.log(result.status === 'delivered' ? `Delivered ${result.receipt.msgId}.` : `Already answered (${result.receipt.at}).`);
      } catch (error) {
        invoked.error(`error: ${error instanceof Error ? error.message : String(error)}`);
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
      // Parent `feed` also declares `--json` (for the list view). Commander
      // binds the flag on the parent, so a `feed post … --json` lands on
      // parent.opts().json — not the child. Read both.
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
        // Blocked is a state, not a volume: it always broadcasts at `important`,
        // so an agent has exactly one thing to say. Passing both is a usage
        // error rather than a silent override -- an agent that thinks it chose
        // the level should not be quietly ignored.
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

        // A blocked post lands in BOTH stores: the event in the shared activity
        // stream (what happened) and an OpenBlock in the ledger (what is still
        // open). The ledger is what makes it answerable and clearable -- without
        // it the ask would scroll away like any other update.
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
              // Prefer title as the front-loaded ask on the phone; body is detail.
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

        // Fail loud when a block reached nobody. This is computed BEFORE the
        // --json early return: a machine caller is exactly the one that reads the
        // exit code, so returning 0 there while a human gets 1 would make the
        // undelivered block invisible to the caller most likely to act on it —
        // reintroducing, behind a flag, the silent failure this exists to remove.
        // One sink failing among several stays a warning: the channels are
        // redundant by design.
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
        // Feed and activity hooks are independent -- install both, and register
        // the manifest as long as at least one wrote its entries (don't couple
        // activity registration to the feed hook succeeding).
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

      // Trailing lane under the block views: `--filter all` appends the same
      // fleet-wide updates section, anything else the compact local lane.
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

      // Updates view: deliberate progress posts only (blocks are decisions, not
      // announcements). Short-circuits the block pipeline — no dispatch policy —
      // but fans out like the block view, because a post lands on whichever box
      // ran the agent.
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

      // Active sessions feed both the GC sweep and outcome enrichment (ticket/PR).
      let sessions: Awaited<ReturnType<typeof getActiveSessions>> = [];
      if (includeLocal) {
        sessions = await getActiveSessions();
      }
      // discoverSessions touches sessions.db; under concurrent scan pressure it
      // can throw SQLITE_BUSY. Outcome enrichment is best-effort — degrade with
      // a warning rather than crash the whole feed (RUSH-2006).
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
        // Liveness sweep: drop messages to dead agents and retire stale blocks
        // before we render the feed.
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

      // Fill missing ticket/PR/worktree from live session meta before local
      // policy mutates the store, so outcome keys land even when the publish
      // hook had no deliverable stamp.
      if (sessions.length > 0) {
        localBlocks = enrichBlocksFromSessions(localBlocks, sessionHintsFromActive(sessions));
      }

      // Stall suppression (RUSH-1477) must only mutate blocks owned by this
      // machine. Remote peers run their own `feed --json`; never enqueue a
      // policy answer into a local mailbox for a remote agent.
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
            // Bare --json stays a block array so older peers and scripts keep working.
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
          // Wrap per-block policy so one malformed block (e.g. a crafted
          // mailboxId that throws in mailboxDir) can't abort the whole loop and
          // strand every remaining block's dispatch.
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
        // Always a block array (stamped with outcome + ask class) so remote fan-out
        // and scripts keep a stable contract. Human grouping is text-only.
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

      // Shared fleet-comms masthead (same family as `agents mailboxes`).
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

/**
 * Mirror a written post to the configured sinks (`feed.broadcast` in
 * agents.yaml, or the implicit `notify.owner` fallback for an important post —
 * see {@link effectiveBroadcastConfig}). The ticket is JOINED from the session
 * index rather than asked for as a flag — it is a domain fact about the
 * session, and an agent that has to remember a `--ticket` argument is an agent
 * that will forget it. Returns the per-sink outcomes; an empty array means
 * nothing is configured and no fallback applies, which is not a failure for a
 * routine post (see `blockDeliveryFailure` for the `--blocked` case).
 *
 * `meta` is threaded in rather than read here so the fallback/config decision
 * and the delivery are pinned to one config snapshot, and so this is testable
 * against a real in-memory `Meta` without touching `~/.agents/agents.yaml`.
 */
async function broadcastPostedEvent(
  event: ActivityEvent,
  level: FeedPostLevel,
  meta: Meta,
  notify = false,
): Promise<SinkOutcome[]> {
  // `--notify` adds a local desktop banner on top of the configured sinks; it
  // fires even for a milestone post that no configured sink would broadcast.
  const config = withDesktopNotify(effectiveBroadcastConfig(meta.feed?.broadcast, level, meta), notify);
  if (!config) return [];
  // Upgrade an 8-char footer crumb to the full indexed id so the console session
  // URL resolves instead of 404ing, and so the ticket join hits the right row.
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
  }, meta);
  // An important post links the session's console page; fire the trace sync now
  // so that page exists when the owner taps it (trace sync otherwise waits for
  // run exit — PHNX-3628/PHNX-3698). Gated + best-effort, never blocks the post.
  if (level === 'important') fireTraceSyncInBackground();
  return runFeedBroadcast(planned, meta);
}

/**
 * Mirror a declared block to the same sinks a post reaches (plus the implicit
 * `notify.owner` fallback — a block is always `important`, so it always
 * qualifies).
 *
 * Blocks previously never broadcast at all: `broadcastPostedEvent` ran only for
 * `feed post`, while every `publishBlock` call wrote to the ledger and stopped
 * there — so a "needs you" record was durable and invisible at the same time.
 */
async function broadcastBlock(
  block: OpenBlock,
  extras: { project?: string; agent?: string; title?: string; body?: string },
  meta: Meta,
  notify = false,
): Promise<SinkOutcome[]> {
  const config = withDesktopNotify(effectiveBroadcastConfig(meta.feed?.broadcast, 'important', meta), notify);
  if (!config) return [];
  const sessionId = resolveFullSessionId(block.sessionId) ?? block.sessionId;
  const ticket = getSessionById(sessionId)?.ticketId;
  const ctx = blockBroadcastContext(
    { ...block, sessionId, ticket: block.ticket ?? ticket },
    extras,
  );
  // A block is always important and links the session's console page — fire the
  // trace sync so the page exists when tapped (best-effort, gated, non-blocking).
  fireTraceSyncInBackground();
  return runFeedBroadcast(planFeedBroadcast(config, ctx, meta), meta);
}

/** One line per sink that ran. Silent when nothing is configured. */
function reportBroadcast(outcomes: SinkOutcome[]): void {
  for (const o of outcomes) {
    if (o.ok && o.error) console.error(chalk.yellow(`  → ${o.name} partial: ${o.error}`));
    else if (o.ok) console.log(chalk.gray(`  → ${o.name}`));
    else console.error(chalk.yellow(`  → ${o.name} failed: ${o.error}`));
  }
}

/** Feed view selector (RUSH-2015): decisions, progress, or both. */
type FeedFilter = 'needs' | 'updates' | 'all';

/** Normalize a raw --filter value; unknown/empty falls back to the default. */
export function resolveFeedFilter(raw: string | undefined): FeedFilter {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'updates' || v === 'update') return 'updates';
  if (v === 'all') return 'all';
  return 'needs';
}

/** True when a block belongs to the requested project (case-insensitive). */
function blockMatchesProject(block: OpenBlock, project?: string): boolean {
  if (!project) return true;
  return (block.project ?? '').toLowerCase() === project.toLowerCase();
}

/** True when an activity event belongs to the requested project (case-insensitive). */
function eventMatchesProject(ev: EnrichedActivityEvent, project?: string): boolean {
  if (!project) return true;
  return ((ev.project ?? projectKeyFromCwd(ev.cwd) ?? '')).toLowerCase() === project.toLowerCase();
}

/**
 * Render one activity event in the lane: deliberate progress posts
 * (`status.posted`) use the rich multi-line {@link formatProgressUpdate}; hook
 * milestones (PR, commit, …) keep the compact {@link formatActivityLine}.
 */
function renderActivityEntry(ev: ActivityEvent): void {
  if (ev.event === 'status.posted') {
    console.log(formatProgressUpdate(ev));
  } else {
    console.log(formatActivityLine(ev, { showHost: true }));
  }
}

/** How far back the updates view looks for deliberate progress posts. */
const UPDATES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Posts kept per machine in the rendered view / the `--json` payload. */
const UPDATES_VIEW_LIMIT = 30;
const UPDATES_JSON_LIMIT = 100;

/**
 * The most recent `limit` deliberate progress posts on THIS machine, newest
 * first. The event filter is pushed into the reader so `limit` counts posts —
 * slicing first and filtering after returned an empty view on a busy box, where
 * routine `file.edited` hook events fill the whole slice.
 */
function readStatusPosts(limit: number): ActivityEvent[] {
  return readRecentActivity({
    sinceMs: Date.now() - UPDATES_WINDOW_MS,
    limit,
    events: ['status.posted'],
  });
}

/**
 * Progress posts across the fleet, newest first. An agent posts on whichever
 * box it runs on, so a local-only read shows the operator a fraction of what
 * the fleet reported. Peers are dialed with the same SSH fan-out the block view
 * uses; `--local` (or the no-fanout env guard on a peer) keeps it to this box.
 */
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

/**
 * Render the **Updates** view: deliberate progress posts only (`status.posted`),
 * recency-ordered, with rich identity chips. Pure `file.edited` / git-hook noise
 * is excluded so operators see announcements, not tool churn.
 */
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

/**
 * Print a compact "recent activity" lane under the feed: the last few milestone
 * events (plans, PRs, worktrees, sub-agents, progress posts) from the append-only
 * activity logs. Read-only tail of the logs -- no transcript re-parsing. Silent
 * when empty.
 */
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
