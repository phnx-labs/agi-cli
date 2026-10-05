// Sink commands are direct argv and unresolved placeholders fail closed; declared config wins, absent config sends important posts to owner and keeps milestones record-only.
// Owner fan-out rerenders per format; --notify adds sinks, invalid channels do not stop fan-out, and session links require full native ids.
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

export type FeedPostLevel = 'milestone' | 'important';

const LEVEL_RANK: Record<FeedPostLevel, number> = { milestone: 0, important: 1 };

export function parseFeedPostLevel(raw: string | undefined): FeedPostLevel {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v || v === 'milestone') return 'milestone';
  if (v === 'important') return 'important';
  throw new Error(`Unknown --level '${raw}'. Use milestone or important.`);
}

export interface FeedSinkConfig {
  command?: string[];
  channel?: string;
  to?: string;
  message?: string;
  minLevel?: FeedPostLevel;
}

export type FeedBroadcastConfig = Record<string, FeedSinkConfig>;

export interface FeedBroadcastContext {
  title?: string;
  text: string;
  level: FeedPostLevel;
  ticket?: string;
  ticketUrl?: string;
  project?: string;
  agent?: string;
  host?: string;
  session?: string;
  links?: string[];
  blockId?: string;
  class?: string;
  cost?: string;
  focus?: string;
  options?: string[];
  safeDefault?: string;
  timeoutMinutes?: number;
}

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
  const options = (block.questions?.[0]?.options ?? [])
    .map((o) => o?.label?.trim())
    .filter((l): l is string => !!l);
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
    focus: `agents focus ${block.sessionId.slice(0, 8)}`,
    ...(options.length ? { options } : {}),
    ...(block.safeDefault ? { safeDefault: block.safeDefault } : {}),
    ...(block.timeoutMinutes ? { timeoutMinutes: block.timeoutMinutes } : {}),
    ...(links.length ? { links } : {}),
  };
}

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
  argv?: string[];
  channel?: string;
  to?: string;
  text?: string;
  ctx?: FeedBroadcastContext;
  messageTemplate?: string;
}

export interface SinkOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

function shortHost(host: string | undefined): string | undefined {
  if (!host?.trim()) return undefined;
  let h = host.trim();
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  const dot = h.indexOf('.');
  if (dot > 0) h = h.slice(0, dot);
  return h || undefined;
}

function shortSessionChunk(session: string | undefined): string | undefined {
  if (!session?.trim()) return undefined;
  const hex = session.replace(/-/g, '').toLowerCase();
  const chunk = hex.replace(/[^a-f0-9]/g, '').slice(0, 8);
  return chunk || undefined;
}

function sessionConsoleUrl(session: string | undefined): string | undefined {
  const id = session?.trim();
  if (!id || !isValidMailboxId(id) || /^[0-9a-f]{8}$/i.test(id)) return undefined;
  return `https://prix.dev/console/sessions/${id}`;
}

function scrubOutboundDashes(text: string): string {
  return text
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, ' - ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function slackLink(url: string, label: string): string {
  return `<${url}|${label}>`;
}

function resolveSinkProvider(channel: string, meta: Meta | undefined): string {
  return meta?.notify?.transports?.[channel] ?? channel;
}

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

  const consoleUrl = who ? sessionConsoleUrl(ctx.session) : undefined;
  if (who && format === 'mrkdwn' && consoleUrl) who = slackLink(consoleUrl, who);

  if (who && host) return `Sent from ${who} on ${host}`;
  if (who) return `Sent from ${who}`;
  if (host) return `Sent from host ${host}`;
  return undefined;
}

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
  const head = linkifyKeys(title || body, format);
  const mid = title && body && title !== body ? linkifyKeys(body, format) : undefined;
  const footer = composeBroadcastFooter(ctx, format);

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
    parts.push('');
    parts.push(mid);
  }
  if (action) {
    if (parts.length) parts.push('');
    parts.push(action);
  }
  if (footer) {
    if (parts.length) parts.push('');
    parts.push(footer);
  }
  return parts.join('\n').trim();
}

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
      if (!isOwnerAlias(channel) && !sink.to?.trim()) continue;
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

export const DESKTOP_NOTIFY_SINK = 'notify';

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

async function runChannelSink(sink: PlannedSink, meta: Meta): Promise<SinkOutcome> {
  const name = sink.name;
  registerBuiltinProviders();
  const owner = isOwnerAlias(sink.channel);
  if (owner) {
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

  const forwarded = await forwardOwnerNotifyToPeer(
    resolved.envelope.text,
    resolved.envelope.channel,
    resolved.envelope.to,
    meta,
  );
  if (forwarded?.ok) return { name, ok: true };

  return { name, ok: false, error: result.error };
}

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
