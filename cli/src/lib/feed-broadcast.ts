/**
 * Fan an `agents feed post` out to the systems the operator actually watches.
 *
 * A post is already durable — it lands in the append-only activity log and shows
 * up in `agents feed --filter updates`. But an operator who is away from every
 * terminal never sees it, and the tracker that owns the work (a Linear ticket,
 * a GitHub issue) hears nothing at all. So a post can also be mirrored outward.
 *
 * Sinks are **argv templates from config**, never hardcoded integrations. This
 * CLI ships under FSL-1.1-Apache-2.0 and must not depend on one person's tracker or messaging
 * stack; declaring `[linear, update, "{ticket}", --comment, "{text}"]` in
 * `agents.yaml` keeps the coupling in the operator's config where it belongs,
 * and lets someone else point the same mechanism at `jira`, `gh issue comment`,
 * or a webhook script.
 *
 * Two rules decide whether a sink runs, both derived from the post itself:
 *
 *   - **Level.** `minLevel: important` keeps a sink for the posts worth
 *     interrupting someone over, so a routine "CI green" does not buzz a phone.
 *   - **Placeholders.** A template that references `{ticket}` is skipped when no
 *     ticket is known. The template declares what it needs; nothing has to
 *     restate it as a flag, and a sink can never fire with a hole in its argv.
 *
 * Delivery is best-effort and reported: a sink that fails prints a warning and
 * the post still stands. Losing a mirror must never cost the operator the post.
 *
 * A second sink shape (RUSH-2123) delivers **in-process** through the same
 * channel-provider registry `agents send` uses (`channel:` instead of
 * `command:`) — no spawn, no argv templating. `channel: owner` is the address
 * alias that expands to `notify.owner.{channel,to}`, matching `agents notify`.
 * When the operator has never written a `feed.broadcast` block at all, an
 * important-level post falls back to that owner address implicitly
 * ({@link effectiveBroadcastConfig}) rather than reaching nobody — see that
 * function's doc for why this was a silent failure before.
 */
import { spawnSync } from 'child_process';
import type { Meta } from './types.js';
import { isOwnerAlias, readOwnerDest, resolveSendEnvelope, deliverEnvelope } from './channels/send.js';
import { lookupTransport } from './channels/resolve.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { sendToOwner } from './notify.js';
import { linearIssueUrl, linearIssueKeys } from './session/linear.js';
import { isValidMailboxId } from './mailbox.js';
import { forwardOwnerNotifyToPeer } from './channels/owner-forward.js';
import { sinkMessageFormat, type SinkMessageFormat } from './sink-format.js';

/** How loudly a post asks to be heard. Ordered — `important` implies milestone. */
export type FeedPostLevel = 'milestone' | 'important';

const LEVEL_RANK: Record<FeedPostLevel, number> = { milestone: 0, important: 1 };

/** Parse a `--level` value; anything unrecognized is a usage error, not a default. */
export function parseFeedPostLevel(raw: string | undefined): FeedPostLevel {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'milestone') return 'milestone';
  if (v === 'important') return 'important';
  throw new Error(`Unknown --level '${raw}'. Use milestone or important.`);
}

export interface FeedSinkConfig {
  /**
   * argv to run, with `{placeholder}` tokens substituted. First element is the
   * program; it is spawned directly (no shell), so quoting is not a concern and
   * post text can never become shell syntax. Mutually exclusive with `channel`
   * — a sink is one shape or the other.
   */
  command?: string[];
  /**
   * In-process delivery through the same channel-provider registry `agents
   * send`/`agents notify` use — the composed `{message}` body, no argv, no
   * spawn. `'owner'` is the address alias (expands to `notify.owner.{channel,to}`
   * in agents.yaml, same as `agents notify`); any other value is a registered
   * channel name (or a `notify.transports` mapping) and requires `to`.
   */
  channel?: string;
  /** Recipient for a `channel` sink. Required unless `channel` is the `owner` alias. */
  to?: string;
  /**
   * Optional channel body template. Uses the same placeholders as `command`
   * argv (`{message}`, `{ticket}`, `{project}`, ...). Defaults to `{message}`.
   * A missing placeholder skips the sink, which lets a `{ticket}` template
   * declare that only ticket-backed posts belong in that destination.
   */
  message?: string;
  /** Lowest post level that reaches this sink. Defaults to `milestone` (all posts). */
  minLevel?: FeedPostLevel;
}

/** `feed.broadcast` in agents.yaml — sink name → what to run. */
export type FeedBroadcastConfig = Record<string, FeedSinkConfig>;

/** Everything a template may interpolate. Absent values skip templates that need them. */
export interface FeedBroadcastContext {
  /** Short subject line (~4–5 words). Phone line 1. */
  title?: string;
  /** The post body, verbatim. Phone line after the blank line. */
  text: string;
  level: FeedPostLevel;
  /** Tracker id for the work, e.g. `RUSH-2081`. */
  ticket?: string;
  /** Canonical clickable tracker URL for `ticket`, when the tracker can resolve it. */
  ticketUrl?: string;
  /** Repo/project the post came from. */
  project?: string;
  agent?: string;
  host?: string;
  session?: string;
  /** URLs attached to the post — the PR, the ticket, a shared plan. */
  links?: string[];
  /** Block-only: the block's stable id. Absent on a status post. */
  blockId?: string;
  /** Block-only: `approval` (has a safe default) or `decision` (needs a human). */
  class?: string;
  /** Block-only: cost-of-delay tag used by the urgency filter. */
  cost?: string;
  /** Block-only: the literal `agents focus <id>` command (for a `{focus}` sink). */
  focus?: string;
  /** Block-only: the answer choices the operator can pick, in order. */
  options?: string[];
  /** Block-only: the fallback applied if nobody answers in time. */
  safeDefault?: string;
  /** Block-only: minutes before `safeDefault` applies. */
  timeoutMinutes?: number;
}

/**
 * Map an open block onto the broadcast context, so a block reaches the same sinks
 * a post does instead of dying in the ledger.
 *
 * The `text` is the ask itself, front-loaded — a notification banner shows roughly
 * two lines, and a phone message is scanned, not read. `focus` carries the literal
 * command that unblocks it, so the message the operator receives contains the one
 * action they have to take rather than making them go find the session.
 *
 * Level is always `important`: a block is by definition an agent that has stopped
 * making progress, so there is no per-block level flag to get wrong.
 */
export function blockBroadcastContext(
  block: {
    blockId: string;
    sessionId: string;
    host?: string;
    questions?: Array<{ text?: string; options?: Array<{ label?: string }> }>;
    blockClass?: string;
    costOfDelay?: string;
    safeDefault?: string;
    timeoutMinutes?: number;
    ticket?: string;
    pr?: string;
  },
  extras: { project?: string; agent?: string; title?: string; body?: string } = {},
): FeedBroadcastContext {
  const ask = block.questions?.[0]?.text?.trim() || 'agent is blocked';
  const links = [block.pr].filter((l): l is string => !!l && /^https?:\/\//i.test(l));
  // The answer choices + the safe default are what make the phone message
  // actionable: the operator sees the options and what happens if they do not
  // reply, instead of a `agents focus <id>` CLI command they cannot run from a phone.
  const options = (block.questions?.[0]?.options ?? [])
    .map((o) => o?.label?.trim())
    .filter((l): l is string => !!l);
  // Prefer explicit title/body from the feed post; fall back to the ask as body.
  const title = extras.title?.trim() || undefined;
  const text = extras.body?.trim() || ask;
  return {
    ...(title ? { title } : {}),
    text,
    level: 'important',
    ticket: block.ticket,
    ticketUrl: linearIssueUrl(block.ticket),
    project: extras.project,
    agent: extras.agent,
    host: block.host,
    session: block.sessionId,
    blockId: block.blockId,
    class: block.blockClass,
    cost: block.costOfDelay,
    // Short id: `agents focus` matches on a prefix, and a full uuid in a phone
    // message is noise. Kept for a `{focus}` sink; the human message no longer
    // shows it (a CLI command is unusable from a phone).
    focus: `agents focus ${block.sessionId.slice(0, 8)}`,
    ...(options.length ? { options } : {}),
    ...(block.safeDefault ? { safeDefault: block.safeDefault } : {}),
    ...(block.timeoutMinutes ? { timeoutMinutes: block.timeoutMinutes } : {}),
    ...(links.length ? { links } : {}),
  };
}

/**
 * Why a declared block reached nobody, or undefined when it got through.
 *
 * Pure so the fail-loud contract is testable without driving the CLI — the
 * original version lived inline in the command action and was consequently
 * never covered, which is how a `--json` early-return quietly bypassed it.
 *
 * Only a TOTAL failure counts. One sink failing among several is a warning, not
 * an error: the channels are redundant by design, and a dead `rush` login must
 * not mask a delivered desktop notification.
 */
export function blockDeliveryFailure(
  blocked: boolean,
  outcomes: SinkOutcome[],
): string | undefined {
  if (!blocked) return undefined;
  if (outcomes.length === 0) {
    return 'Block recorded but NOT delivered — no feed.broadcast sink configured.';
  }
  if (outcomes.every((o) => !o.ok)) {
    const why = outcomes.map((o) => `${o.name}: ${o.error ?? 'failed'}`).join('; ');
    return `Block recorded but NOT delivered — every feed.broadcast sink failed (${why}).`;
  }
  return undefined;
}

interface PlannedSink {
  name: string;
  /** Command sink: argv to spawn (mutually exclusive with `channel`). */
  argv?: string[];
  /** Channel sink: provider channel name, or the `owner` alias. */
  channel?: string;
  /** Channel sink recipient. Unset for the `owner` alias — resolved at delivery. */
  to?: string;
  /** Channel sink body — the composed `{message}` for this post. */
  text?: string;
  /**
   * Owner-alias sinks only: the post context + its `message:` template, carried
   * so the owner fan-out can re-render the body PER DESTINATION — Slack in the
   * policy gets `mrkdwn` labeled links while iMessage stays plain (PHNX-3698).
   * `text` above is the plain default (dry-run display + the fallback when a
   * destination has no resolvable provider); this drives the real send. A
   * direct `channel:` sink resolves its one provider's format at plan time and
   * needs neither field.
   */
  ctx?: FeedBroadcastContext;
  messageTemplate?: string;
}

export interface SinkOutcome {
  name: string;
  ok: boolean;
  /** stderr tail when the sink failed, for the warning line. */
  error?: string;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * Short host label for a phone line — strip user@ and domain so
 * `muqsit@mac-mini.tailnet.ts.net` reads as `mac-mini`.
 */
function shortHost(host: string | undefined): string | undefined {
  if (!host?.trim()) return undefined;
  let h = host.trim();
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  const dot = h.indexOf('.');
  if (dot > 0) h = h.slice(0, dot);
  return h || undefined;
}

/** First 8 hex chars of a session id for the footer (readable, not a full uuid). */
function shortSessionChunk(session: string | undefined): string | undefined {
  if (!session?.trim()) return undefined;
  const hex = session.replace(/-/g, '').toLowerCase();
  const chunk = hex.replace(/[^a-f0-9]/g, '').slice(0, 8);
  return chunk || undefined;
}

/**
 * Tap-to-view link for the session behind a post: the addressable console page
 * ({@link https://prix.dev/console/sessions/<id>}, prix/web). The footer already
 * carries a short session crumb for disambiguation; this rides the link trail so
 * the owner can open the full transcript straight from an iMessage broadcast
 * instead of hunting for it in the console.
 *
 * Accepts any real, path-safe session id — a Claude/Codex UUID *and* a native
 * `ses_…` id from OpenCode or another harness. The console shard uploader
 * (`traces/sync.ts`) syncs sessions with no harness filter, so all of them are
 * addressable; a UUID-only gate would silently drop the link for every non-Claude
 * harness (the whole point of the link). Reject only an id that could not resolve:
 * one with a path separator (URL-unsafe, via {@link isValidMailboxId}) or the bare
 * 8-char footer crumb (a truncated id that would 404).
 */
function sessionConsoleUrl(session: string | undefined): string | undefined {
  const id = session?.trim();
  if (!id || !isValidMailboxId(id) || /^[0-9a-f]{8}$/i.test(id)) return undefined;
  return `https://prix.dev/console/sessions/${id}`;
}

/**
 * Scrub em/en dashes from outbound phone copy (house rule + iMessage readability).
 * Collapses whitespace; does not invent meaning.
 */
function scrubOutboundDashes(text: string): string {
  return text
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, ' - ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Slack mrkdwn labeled link: `<url|label>` renders as blue `label` text. */
function slackLink(url: string, label: string): string {
  return `<${url}|${label}>`;
}

/**
 * The provider a channel name actually delivers through — the same
 * `notify.transports` remap `lookupTransport` applies at delivery — so the format
 * decision and the delivery agree on what Slack is. Identity when no mapping
 * exists (or no `meta`), matching the default name-identity transport rule.
 */
function resolveSinkProvider(channel: string, meta: Meta | undefined): string {
  return meta?.notify?.transports?.[channel] ?? channel;
}

/**
 * Replace each real Linear key the text NAMES with a Slack labeled link to its
 * issue — `PHNX-3689` → `<https://linear.app/getrush/issue/PHNX-3689|PHNX-3689>`
 * — so the key itself turns blue in place (no trailing URL line). Plain format,
 * or a key the workspace can't resolve, or a denylisted unit string, is left as
 * the bare key. `linearIssueKeys` is the same canonical detector the trail used,
 * so mrkdwn linkifies exactly the keys plain leaves as text.
 */
function linkifyKeys(text: string, format: SinkMessageFormat): string {
  if (format !== 'mrkdwn' || !text) return text;
  let out = text;
  for (const key of linearIssueKeys(text)) {
    const url = linearIssueUrl(key);
    if (!url) continue;
    out = out.replace(new RegExp(`\\b${key}\\b`, 'g'), slackLink(url, key));
  }
  return out;
}

/**
 * Footer like "Sent from my iPhone" — who posted, a session crumb, which box.
 *
 *   Sent from grok/a02da0e2 on mac-mini
 *
 * Agent name first; session chunk for disambiguation when many groks run;
 * host last. Skip the uninformative default label `agent`.
 *
 * In `mrkdwn` the crumb (`agent/short`) becomes a Slack labeled link to the
 * session's console page, so the human sentence reads identically while the
 * crumb turns blue and taps through (PHNX-3698). `plain` keeps the bare sentence
 * — it can't render a labeled link and must not dump the URL.
 */
function composeBroadcastFooter(
  ctx: FeedBroadcastContext,
  format: SinkMessageFormat = 'plain',
): string | undefined {
  const agent = ctx.agent?.trim();
  const agentLabel = agent && agent !== 'agent' ? agent : undefined;
  const session = shortSessionChunk(ctx.session);
  const host = shortHost(ctx.host);

  let who: string | undefined;
  if (agentLabel && session) who = `${agentLabel}/${session}`;
  else if (agentLabel) who = agentLabel;
  else if (session) who = session;

  // The crumb is only a link when the session resolves to a real console page.
  const consoleUrl = who ? sessionConsoleUrl(ctx.session) : undefined;
  if (who && format === 'mrkdwn' && consoleUrl) who = slackLink(consoleUrl, who);

  if (who && host) return `Sent from ${who} on ${host}`;
  if (who) return `Sent from ${who}`;
  if (host) return `Sent from host ${host}`;
  return undefined;
}

/**
 * Human-facing body for a messaging sink (`{message}`).
 *
 * ```
 * Title in a few words
 *
 * Body of what happened or the ask.
 * Options: publish / wait          (blocks with choices)
 * Default in 15 min: wait          (blocks with a safe default)
 *
 * Sent from grok/a02da0e2 on mac-mini
 * https://…                        (optional attach URL)
 * ```
 *
 * Title first (scannable subject). Blank line. Body. Then the phone-actionable
 * choices + default (a block that has stopped for the human), then footer
 * provenance. No `agents focus <id>` line: a CLI command is unusable from a phone,
 * so the safe default is the fallback and the message carries it. Prefer `{message}`
 * over bare `{text}` in messaging sinks.
 */
/**
 * The phone copy is a text, not a report. A long body reaches the owner's phone
 * as an unreadable wall, and the `feed post` forwarding path is where that has to
 * be shaped: every sink (owner alias, in-process `channel:`, spawned `command:`)
 * funnels through {@link composeBroadcastMessage}, which is the only seam a shell
 * hook cannot reach. Keep the title (the scannable headline) and cap the BODY to a
 * short excerpt, marking the cut with a plain "(full in feed)" — NOT a CLI command
 * (unusable from a phone, see the note on composeBroadcastMessage). Nothing is
 * lost: this shapes only the outbound sink text; the full post stays in the feed.
 */
const PHONE_BODY_MAX_CHARS = 500;
const PHONE_BODY_MAX_LINES = 8;

function truncateBroadcastBody(body: string): string {
  if (!body) return body;
  let out = body;
  let cut = false;
  const lines = out.split('\n');
  if (lines.length > PHONE_BODY_MAX_LINES) {
    out = lines.slice(0, PHONE_BODY_MAX_LINES).join('\n');
    cut = true;
  }
  if (out.length > PHONE_BODY_MAX_CHARS) {
    out = out.slice(0, PHONE_BODY_MAX_CHARS);
    cut = true;
  }
  if (!cut) return body;
  return `${out.trimEnd()}\n… (full in feed)`;
}

export function composeBroadcastMessage(
  ctx: FeedBroadcastContext,
  format: SinkMessageFormat = 'plain',
): string {
  const title = scrubOutboundDashes(ctx.title ?? '');
  const body = truncateBroadcastBody(scrubOutboundDashes(ctx.text ?? ''));
  // Title preferred; if an older post has no title, body alone still sends.
  // A `TEAM-N` key the human typed is dead text on a phone — in `mrkdwn` the key
  // itself becomes a Slack labeled link in place, so nothing rides a trailing
  // naked URL line; `plain` leaves the bare key (iMessage can't render a label,
  // and dumping the URL is worse than leaving it — PHNX-3698).
  const head = linkifyKeys(title || body, format);
  const mid = title && body && title !== body ? linkifyKeys(body, format) : undefined;
  const footer = composeBroadcastFooter(ctx, format);

  // The action block: the one thing the operator can act on from a phone. Show the
  // choices, then what happens if they do not answer. Deliberately NOT a CLI command
  // (`agents focus <id>` is unusable from a phone) -- the safe default is the real
  // fallback, so a block meant for a phone should always carry one.
  const choices = ctx.options?.length
    ? `Options: ${ctx.options.map((o) => scrubOutboundDashes(o)).join(' / ')}`
    : undefined;
  const fallback = ctx.safeDefault
    ? (ctx.timeoutMinutes && ctx.timeoutMinutes > 0
        ? `Default in ${ctx.timeoutMinutes} min: ${scrubOutboundDashes(ctx.safeDefault)}`
        : `Default: ${scrubOutboundDashes(ctx.safeDefault)}`)
    : undefined;
  const action = [choices, fallback].filter(Boolean).join('\n') || undefined;

  const parts: string[] = [];
  if (head) parts.push(head);
  if (mid) {
    // Blank line between subject and body (title, then space, then message).
    parts.push('');
    parts.push(mid);
  }
  if (action) {
    // The choices/default hug the ask under a blank line so they read as the reply.
    if (parts.length) parts.push('');
    parts.push(action);
  }
  if (footer) {
    // Blank line before the "Sent from" footer (iPhone "Sent from my iPhone" spacing).
    // The crumb/ticket links are inline (footer + prose) — never a trailing URL line.
    if (parts.length) parts.push('');
    parts.push(footer);
  }
  return parts.join('\n').trim();
}

/**
 * The values a template may reference, resolved once per post. `format` decides
 * how `{message}` surfaces its links — Slack `mrkdwn` (labeled links) vs `plain`
 * (the human sentence, no URLs). The scalar `{ticket_url}`/`{links}` vars are the
 * raw URLs a custom `message:` template can place itself, so they are unaffected.
 */
function templateVars(
  ctx: FeedBroadcastContext,
  format: SinkMessageFormat = 'plain',
): Record<string, string | undefined> {
  return {
    title: ctx.title,
    text: ctx.text,
    ticket: ctx.ticket,
    ticket_url: ctx.ticketUrl,
    project: ctx.project,
    agent: ctx.agent,
    host: ctx.host,
    session: ctx.session,
    level: ctx.level,
    links: ctx.links?.length ? ctx.links.join(' ') : undefined,
    message: composeBroadcastMessage(ctx, format),
    block: ctx.blockId,
    class: ctx.class,
    cost: ctx.cost,
    focus: ctx.focus,
    options: ctx.options?.length ? ctx.options.join(' / ') : undefined,
    default: ctx.safeDefault,
  };
}

/**
 * Substitute `{placeholder}` tokens in an argv template. Returns undefined when
 * the template needs a value this post does not have — the sink is then skipped
 * rather than run with an empty argument, which is how a `linear update --comment`
 * would otherwise comment on nothing.
 */
export function renderSinkArgv(
  template: string[],
  ctx: FeedBroadcastContext,
): string[] | undefined {
  const vars = templateVars(ctx);
  const argv: string[] = [];
  for (const token of template) {
    let missing = false;
    const rendered = token.replace(PLACEHOLDER, (whole, key: string) => {
      const value = vars[key];
      if (value === undefined || value === '') {
        missing = true;
        return whole;
      }
      return value;
    });
    if (missing) return undefined;
    argv.push(rendered);
  }
  return argv.length > 0 ? argv : undefined;
}

/**
 * Render one channel-message template with the same fail-closed placeholder
 * contract as argv. `format` (Slack `mrkdwn` vs `plain`) flows into the shared
 * `{message}` var so a Slack sink gets labeled links and an iMessage/owner sink
 * gets the plain sentence.
 */
export function renderSinkMessage(
  template: string,
  ctx: FeedBroadcastContext,
  format: SinkMessageFormat = 'plain',
): string | undefined {
  const vars = templateVars(ctx, format);
  let missing = false;
  const rendered = template.replace(PLACEHOLDER, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined || value === '') {
      missing = true;
      return whole;
    }
    return value;
  });
  if (missing) return undefined;
  const seenUrls = new Set<string>();
  const text = rendered
    .trim()
    .split('\n')
    .filter((line) => {
      const value = line.trim();
      if (!/^https?:\/\/\S+$/i.test(value)) return true;
      if (seenUrls.has(value)) return false;
      seenUrls.add(value);
      return true;
    })
    .join('\n');
  return text || undefined;
}

/**
 * Which sinks this post reaches, in config order. Pure — the dry-run listing and
 * the real fan-out plan through here, so what `--dry-run` shows is what runs.
 *
 * A `channel:` sink is gated by the same `minLevel` rule as a `command:` sink —
 * one level check for both shapes, so a dry-run plan is truthful regardless of
 * which shape an operator's sink uses.
 *
 * `meta` is used only to resolve a channel name to its real provider for the
 * mrkdwn/plain format decision (`notify.transports`), the same map delivery uses;
 * it is optional so a test can plan without a config snapshot (identity mapping).
 */
export function planFeedBroadcast(
  config: FeedBroadcastConfig | undefined,
  ctx: FeedBroadcastContext,
  meta?: Meta,
): PlannedSink[] {
  if (!config) return [];
  const planned: PlannedSink[] = [];
  for (const [name, sink] of Object.entries(config)) {
    if (!sink) continue;
    const min = sink.minLevel ?? 'milestone';
    if (LEVEL_RANK[ctx.level] < LEVEL_RANK[min]) continue;

    const channel = sink.channel?.trim();
    if (channel) {
      // The owner alias resolves its recipient from notify.owner at delivery
      // time; any other channel name needs an explicit recipient now, or the
      // sink can never fire with a hole in it (same contract as a missing argv
      // placeholder below).
      if (!isOwnerAlias(channel) && !sink.to?.trim()) continue;
      // Slack renders labeled links; every other channel (iMessage, telegram,
      // discord, mailbox, desktop) stays plain (PHNX-3698). A DIRECT channel sink
      // has one known provider, so its format is resolved here. The OWNER ALIAS
      // fans out to every channel in owner.policy.normal — each with its OWN
      // provider — so it can't pick one format now: it carries the ctx + template
      // and re-renders per destination inside the owner fan-out (runChannelSink →
      // sendToOwner), so the Slack destination turns blue while a sibling iMessage
      // copy stays plain. The plain body computed here is the dry-run/fallback
      // default. Keying on the resolved provider (not the raw name) matches what
      // delivery does.
      const owner = isOwnerAlias(channel);
      const template = sink.message ?? '{message}';
      const provider = owner ? channel : resolveSinkProvider(channel, meta);
      const text = renderSinkMessage(template, ctx, sinkMessageFormat(provider));
      if (!text) continue;
      planned.push({
        name,
        channel,
        to: owner ? undefined : sink.to!.trim(),
        text,
        ...(owner ? { ctx, messageTemplate: template } : {}),
      });
      continue;
    }

    if (!Array.isArray(sink.command) || sink.command.length === 0) continue;
    const argv = renderSinkArgv(sink.command, ctx);
    if (!argv) continue;
    planned.push({ name, argv });
  }
  return planned;
}

/**
 * The effective sink config for a post: the operator's `feed.broadcast`, or —
 * when that is unset or empty — an implicit fallback straight to
 * `notify.owner`, for a post worth interrupting someone over.
 *
 * Before this, `broadcastPostedEvent`/`broadcastBlock` returned early the
 * moment `feed.broadcast` was empty, even when `notify.owner` was fully
 * configured — so the common case (an operator who set up owner notifications
 * but never wrote a `feed.broadcast` block) produced a `--blocked` post that
 * looked recorded and reached nobody. `agents notify` already treats
 * `notify.owner` as the default human destination; this makes an important
 * feed post/block use that same default instead of requiring a second,
 * redundant config block that says the same thing.
 *
 * The fallback only fires for `important` — a routine `milestone` post stays
 * record-only, matching the `minLevel` contract every declared sink already
 * follows. An operator-declared `feed.broadcast` (any non-empty config)
 * always wins outright; the fallback never layers on top of it.
 */
export function effectiveBroadcastConfig(
  config: FeedBroadcastConfig | undefined,
  level: FeedPostLevel,
  meta: Meta,
): FeedBroadcastConfig | undefined {
  if (config && Object.keys(config).length > 0) return config;
  if (level !== 'important') return undefined;
  if (!readOwnerDest(meta)) return undefined;
  return { owner: { channel: 'owner' } };
}

/** Sink name for the ephemeral local banner added by `feed post --notify`. */
export const DESKTOP_NOTIFY_SINK = 'notify';

/**
 * Add a local desktop-banner sink when `feed post --notify` is set — the same
 * `notifyDesktop` banner `run --notify` raises, but for an authored post.
 *
 * `--notify` is a per-post opt-in that ADDS the local banner on top of whatever
 * `feed.broadcast`/owner delivery already runs; it never replaces a configured
 * sink. It carries no `minLevel`, so it fires for any level — a quiet milestone
 * banner on this box does not touch the phone the way an `important` post does.
 * And it routes through the `desktop` channel provider exactly like every other
 * `channel:` sink, so it appears in the outcomes and the `--json` payload rather
 * than a parallel code path the reporting cannot see.
 *
 * The desktop banner is inherently local — `notifyDesktop` reaches whoever is at
 * THIS machine — so a post authored on a headless box notifies that box (a no-op
 * with a stated reason where no notifier exists, per the desktop provider),
 * never the operator's Mac. That is the same locality `run --notify` has; the
 * phone hop stays the job of an `important`-level owner/broadcast sink.
 *
 * The banner is added under `DESKTOP_NOTIFY_SINK`, or the first free
 * `notify-2`/`notify-3`/… when the operator already declared a sink by that
 * name — so `--notify` can never silently overwrite a configured sink; both fire.
 */
export function withDesktopNotify(
  config: FeedBroadcastConfig | undefined,
  notify: boolean,
): FeedBroadcastConfig | undefined {
  if (!notify) return config;
  const base = config ?? {};
  let name = DESKTOP_NOTIFY_SINK;
  for (let i = 2; name in base; i++) name = `${DESKTOP_NOTIFY_SINK}-${i}`;
  return { ...base, [name]: { channel: 'desktop', to: 'local' } };
}

function runCommandSink(name: string, argv: string[], timeoutMs: number): SinkOutcome {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { name, ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const tail = (result.stderr || result.stdout || '').trim().split('\n').slice(-1)[0];
    return { name, ok: false, error: tail || `exited ${result.status}` };
  }
  return { name, ok: true };
}

/**
 * Deliver one `channel:` sink through the real provider registry —
 * `resolveSendEnvelope` reuses `agents notify`'s owner-alias expansion, and
 * `deliverEnvelope` is the same seam `agents send` calls. A bad channel name
 * is checked with `lookupTransport` (the non-throwing lookup) BEFORE handing
 * off to `deliverEnvelope`: that function's own resolution `die()`s on an
 * unregistered provider, which is the right answer for an interactive `agents
 * send` typo but would take the whole broadcast fan-out down with it here —
 * one misconfigured sink must report a failure, not kill the process running
 * every other sink.
 */
async function runChannelSink(sink: PlannedSink, meta: Meta): Promise<SinkOutcome> {
  const name = sink.name;
  // Registration is idempotent and normally happens inside deliverEnvelope();
  // it has to happen before the lookupTransport pre-check below too, or the
  // very first channel sink in a process would report "no channel provider"
  // for a name that is, in fact, registered.
  registerBuiltinProviders();
  const owner = isOwnerAlias(sink.channel);
  if (owner) {
    // Re-render the body PER owner destination so a Slack channel in the policy
    // gets mrkdwn labeled links while iMessage stays plain (PHNX-3698). The
    // fan-out (sendToOwner) resolves each destination's provider and asks this
    // composer for the matching format. renderSinkMessage is fail-closed on a
    // missing placeholder — the plan already dropped the sink if the template
    // couldn't fill, so here it always resolves; `?? sink.text` is a belt-and-
    // braces guard, never the normal path.
    const composeForFormat = sink.ctx
      ? (format: SinkMessageFormat): string =>
          renderSinkMessage(sink.messageTemplate ?? '{message}', sink.ctx!, format) ?? sink.text ?? ''
      : undefined;
    const result = await sendToOwner(sink.text ?? '', { meta, composeForFormat });
    return { name, ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  }
  const resolved = resolveSendEnvelope(
    {
      text: sink.text ?? '',
      channel: owner ? undefined : sink.channel,
      to: owner ? 'owner' : sink.to,
      ownerMode: owner,
    },
    meta,
  );
  if (!resolved.ok) return { name, ok: false, error: resolved.error };

  const { provider, error } = lookupTransport(resolved.envelope.channel, meta);
  if (!provider) return { name, ok: false, error };

  const result = await deliverEnvelope(resolved.envelope, meta);
  if (result.ok) return { name, ok: true };

  // Explicit rush-backed channel sinks need the same cross-device handoff as
  // the owner alias. Linux workers do not carry the macOS Keychain-bound Rush
  // transport, but feed posts originate on those workers routinely. Keep the
  // destination explicit so the peer delivers exactly this sink once instead
  // of expanding the owner's multi-channel policy.
  const forwarded = await forwardOwnerNotifyToPeer(
    resolved.envelope.text,
    resolved.envelope.channel,
    resolved.envelope.to,
    meta,
  );
  if (forwarded?.ok) return { name, ok: true };

  return { name, ok: false, error: result.error };
}

/**
 * Run the planned sinks. A `command:` sink is a direct spawn with a bounded
 * lifetime; a `channel:` sink delivers in-process. Either way a sink that
 * fails or is not installed/registered is reported, never thrown — the post
 * is already written and must not be undone by a mirror that could not be
 * reached.
 */
export async function runFeedBroadcast(
  planned: PlannedSink[],
  meta: Meta,
  timeoutMs = 20_000,
): Promise<SinkOutcome[]> {
  const outcomes: SinkOutcome[] = [];
  for (const sink of planned) {
    if (sink.channel) {
      outcomes.push(await runChannelSink(sink, meta));
    } else {
      outcomes.push(runCommandSink(sink.name, sink.argv ?? [], timeoutMs));
    }
  }
  return outcomes;
}
