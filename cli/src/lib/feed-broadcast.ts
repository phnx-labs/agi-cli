/** Fans an `agents feed post` out to sinks the operator watches: config argv templates (never
 * hardcoded integrations; FSL-licensed CLI) or in-process `channel:` sinks (RUSH-2123). `minLevel`
 * and unfillable `{placeholders}` skip a sink; failures only warn, the post always stands. */
import { spawnSync } from 'child_process';
import type { Meta } from './types.js';
import { isOwnerAlias, readOwnerDest, resolveSendEnvelope, deliverEnvelope } from './channels/send.js';
import { lookupTransport } from './channels/resolve.js';
import { registerBuiltinProviders } from './channels/providers/index.js';
import { sendToOwner } from './notify.js';
import { linearIssueUrl, linearIssueKeys } from '@phnx-labs/sessions-cli/reader';
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
  /** argv to run, with `{placeholder}` tokens substituted. Spawned directly with no shell, so
   * post text cannot become shell syntax. Mutually exclusive with `channel`. */
  command?: string[];
  /** In-process delivery through the channel-provider registry `agents send` uses. `'owner'`
   * expands to `notify.owner.{channel,to}`; any other value is a registered channel name and
   * requires `to`. */
  channel?: string;
  /** Recipient for a `channel` sink. Required unless `channel` is the `owner` alias. */
  to?: string;
  /** Optional channel body template using the same placeholders as `command` argv. Defaults to
   * `{message}`. A missing placeholder skips the sink. */
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

/** Maps an open block onto the broadcast context so it reaches the same sinks as a post. Text is
 * the ask, front-loaded; `focus` carries the unblock command. Level is always `important` since
 * a block means an agent has stopped. */
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

/** Why a declared block reached nobody, or undefined when it got through. Pure so the fail-loud
 * contract is testable. Only a total failure counts; one failing sink among several is a
 * warning because channels are redundant. */
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
  /** Owner-alias sinks only: carries the post context and `message:` template so the fan-out can
   * re-render per destination (Slack mrkdwn vs plain, PHNX-3698). `text` is the plain default
   * for dry-run and fallback. */
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

/** Short host label for a phone line: strips user@ and domain. */
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

/** Tap-to-view console link for the session behind a post. Accepts any path-safe session id
 * (UUID or native `ses_` ids), since the console syncs all harnesses. Rejects only ids with a
 * path separator or the bare 8-char footer crumb, which would 404. */
function sessionConsoleUrl(session: string | undefined): string | undefined {
  const id = session?.trim();
  if (!id || !isValidMailboxId(id) || /^[0-9a-f]{8}$/i.test(id)) return undefined;
  return `https://prix.dev/console/sessions/${id}`;
}

/** Scrubs em/en dashes from outbound phone copy (house rule) and collapses whitespace. */
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

/** The provider a channel name actually delivers through, applying the same `notify.transports`
 * remap as `lookupTransport`. Identity when no mapping exists. */
function resolveSinkProvider(channel: string, meta: Meta | undefined): string {
  return meta?.notify?.transports?.[channel] ?? channel;
}

/** Replaces each real Linear key in the text with a Slack labeled link to its issue. Plain
 * format, unresolvable keys, and denylisted unit strings are left as the bare key. */
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

/** Footer like `Sent from grok/a02da0e2 on mac-mini`: agent, session crumb, host; skips the
 * default label `agent`. In `mrkdwn` the crumb links to the session console page; `plain` keeps
 * the bare sentence (PHNX-3698). */
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

/** Human-facing body for a messaging sink (`{message}`): title, blank line, body, choices and
 * default, then footer. No `agents focus` line since a CLI command is unusable from a phone.
 * Prefer `{message}` over `{text}`. */
/** Phone copy is a text, not a report: keep the title and cap the body to a short excerpt marked
 * "(full in feed)". Every sink funnels through composeBroadcastMessage, the one seam a shell
 * hook cannot reach; the full post stays in the feed. */
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
  // A typed `TEAM-N` key is dead text on a phone: mrkdwn links it in place, plain leaves the bare
  // key (PHNX-3698).
  const head = linkifyKeys(title || body, format);
  const mid = title && body && title !== body ? linkifyKeys(body, format) : undefined;
  const footer = composeBroadcastFooter(ctx, format);

  // The action block shows the choices and what happens if unanswered. Deliberately no CLI verb,
  // since the safe default is the real fallback on a phone.
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

/** Values a template may reference, resolved once per post. `format` decides how `{message}`
 * renders links; the scalar `{ticket_url}`/`{links}` vars are raw URLs and unaffected. */
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

/** Substitutes `{placeholder}` tokens in an argv template. Returns undefined when a needed value
 * is missing, so the sink is skipped rather than run with an empty argument. */
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

/** Renders one channel-message template with the same fail-closed placeholder contract as argv;
 * `format` flows into `{message}` so Slack gets labeled links and owner/iMessage gets plain
 * text. */
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

/** Which sinks a post reaches, in config order. Pure, so `--dry-run` shows exactly what runs;
 * one `minLevel` check covers both sink shapes. `meta` only resolves channel to provider and is
 * optional. */
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
      // The owner alias resolves its recipient at delivery time; any other channel needs an
      // explicit recipient now, or the sink can never fire.
      if (!isOwnerAlias(channel) && !sink.to?.trim()) continue;
      // Slack gets labeled links; every other channel stays plain (PHNX-3698). A direct sink
      // resolves its format here; the owner alias re-renders per destination in the fan-out, so the
      // plain body here is only the dry-run/fallback.
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

/** The effective sink config: the operator's `feed.broadcast`, or when unset or empty an
 * implicit fallback to `notify.owner`. The fallback fires only for `important` posts and never
 * layers on a non-empty operator config. */
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

/** Adds a local desktop-banner sink when `feed post --notify` is set, on top of (never
 * replacing) configured sinks, with no `minLevel`. Routes through the `desktop` provider so it
 * shows in outcomes and `--json`; it is local to this machine, as with `run --notify`. */
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

/** Delivers one `channel:` sink through the real provider registry, reusing the owner-alias
 * expansion and `deliverEnvelope`. A bad channel is checked with the non-throwing
 * `lookupTransport` first, because `deliverEnvelope` would `die()` and kill every other sink. */
async function runChannelSink(sink: PlannedSink, meta: Meta): Promise<SinkOutcome> {
  const name = sink.name;
  // Registration is idempotent but must run before the lookupTransport pre-check, or the first
  // channel sink in a process reports "no channel provider" for a registered name.
  registerBuiltinProviders();
  const owner = isOwnerAlias(sink.channel);
  if (owner) {
    // Re-render the body per owner destination so Slack gets mrkdwn links and iMessage stays plain
    // (PHNX-3698). renderSinkMessage is fail-closed and the plan already dropped unfillable sinks,
    // so `?? sink.text` is only a guard.
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

  // Explicit rush-backed channel sinks need the cross-device handoff the owner alias has, since
  // Linux workers lack the macOS Keychain-bound Rush transport. The destination stays explicit so
  // the peer delivers exactly this sink once.
  const forwarded = await forwardOwnerNotifyToPeer(
    resolved.envelope.text,
    resolved.envelope.channel,
    resolved.envelope.to,
    meta,
  );
  if (forwarded?.ok) return { name, ok: true };

  return { name, ok: false, error: result.error };
}

/** Runs the planned sinks: `command:` is a bounded direct spawn, `channel:` delivers in-process.
 * A failed or missing sink is reported, never thrown, since the post is already written. */
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
