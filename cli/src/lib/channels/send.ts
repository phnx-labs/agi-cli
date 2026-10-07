import type { Meta } from '../types.js';
import { registerBuiltinProviders } from './providers/index.js';
import { lookupTransport, resolveTransport } from './resolve.js';
import type { SendResult, TerminalSendOptions } from './registry.js';
import { SESSION_CHANNEL } from './providers/session.js';
import { sendToOwner } from '../notify.js';

interface SendEnvelope {
  text: string;
  channel: string;
  to: string;
  thread?: string;
  attachments?: string[];
  from?: string;
  dryRun?: boolean;
  terminal?: TerminalSendOptions;
}

export interface ResolveSendInput {
  text?: string;
  positionalText?: string;
  to?: string;
  channel?: string;
  thread?: string;
  attachments?: string[];
  urls?: string[];
  from?: string;
  dryRun?: boolean;
  terminal?: TerminalSendOptions;
}

type ResolveSendResult =
  | { ok: true; envelope: SendEnvelope }
  | { ok: false; error: string };

const OWNER_ALIAS = 'owner';

export function isOwnerAlias(to: string | undefined): boolean {
  return (to ?? '').trim().toLowerCase() === OWNER_ALIAS;
}

export function composeSendText(text: string, urls?: string[], verbatim = false): string {
  const body = verbatim ? text : text.trim();
  const extra = (urls ?? [])
    .map((u) => u.trim())
    .filter(Boolean)
    .filter((u) => !body.includes(u));
  if (extra.length === 0) return body;
  return body ? `${body}\n${extra.join('\n')}` : extra.join('\n');
}

function resolveText(
  input: ResolveSendInput,
  verbatim: boolean,
): { ok: true; text: string } | { ok: false; error: string } {
  const norm = (t: string | undefined) => (t === undefined || verbatim ? t : t.trim());
  const positional = norm(input.positionalText);
  const flagged = norm(input.text);
  const conflict = verbatim
    ? positional !== undefined && flagged !== undefined && positional !== flagged
    : Boolean(positional && flagged && positional !== flagged);
  if (conflict) {
    return {
      ok: false,
      error: 'Pass the message once: use --text, or a positional argument, not both with different values.',
    };
  }
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
  const supplied = verbatim ? (flagged ?? positional) : (flagged || positional);
  const text = composeSendText(supplied ?? '', urls, verbatim);
  if (!text && (supplied === undefined || !verbatim)) {
    return {
      ok: false,
      error: 'Message is empty. Pass --text "…", a positional message, and/or --url.',
    };
  }
  return { ok: true, text };
}

function terminalOptionsError(terminal: TerminalSendOptions | undefined, to: string): string | null {
  if (!terminal) return null;
  if (terminal.socket && !terminal.pane) {
    return '--socket addresses an explicit --pane; a session found by --to already carries its own socket.';
  }
  if (terminal.combined && terminal.enter === false) {
    return '--combined fuses the text with Enter; it cannot be used with --no-enter.';
  }
  if (terminal.pane && to && to !== terminal.pane) {
    return `--pane ${terminal.pane} and --to ${to} name different targets; pass one of them.`;
  }
  return null;
}

export function resolveSendEnvelope(input: ResolveSendInput, meta: Meta): ResolveSendResult {
  const channel = (input.channel ?? '').trim();
  let to = (input.to ?? '').trim();
  if (isOwnerAlias(to)) {
    return { ok: false, error: '--to owner sends to your account, whose notification preferences pick the channels, so it cannot be combined with --channel (a feed sink uses `channel: owner` instead). Drop --channel, or name an explicit recipient.' };
  }

  const isSession = Boolean(channel)
    && lookupTransport(channel, meta).providerName === SESSION_CHANNEL;
  if (input.terminal && !isSession) {
    return {
      ok: false,
      error: '--pane, --socket, --no-enter and --combined only apply to --channel session.',
    };
  }
  const terminalError = isSession ? terminalOptionsError(input.terminal, to) : null;
  if (terminalError) return { ok: false, error: terminalError };
  if (isSession && input.terminal?.pane) to = input.terminal.pane;

  const resolvedText = resolveText(input, isSession);
  if (!resolvedText.ok) return resolvedText;
  const { text } = resolvedText;

  if (!channel || !to) {
    const hint = isSession
      ? 'Need --to <session> (find ids with: agents ps) or --pane <tmux pane id>.'
      : 'Need --channel and --to, or --to owner. Example: agents send --channel desktop --to local --text "hi"';
    return { ok: false, error: hint };
  }

  const attachments = [
    ...(input.attachments ?? []),
  ]
    .map((p) => p.trim())
    .filter(Boolean);

  return {
    ok: true,
    envelope: {
      text,
      channel,
      to,
      thread: input.thread?.trim() || undefined,
      attachments: attachments.length ? attachments : undefined,
      from: input.from?.trim() || undefined,
      dryRun: input.dryRun,
      terminal: isSession ? input.terminal : undefined,
    },
  };
}

export async function deliverEnvelope(envelope: SendEnvelope, meta: Meta): Promise<SendResult> {
  registerBuiltinProviders();
  const provider = resolveTransport(envelope.channel, meta);
  return provider.send(envelope.text, {
    target: envelope.to,
    thread: envelope.thread,
    attachments: envelope.attachments,
    from: envelope.from,
    dryRun: envelope.dryRun,
    terminal: envelope.terminal,
  });
}

function ownerSendError(input: ResolveSendInput): string | null {
  if (input.channel?.trim()) return '--to owner sends to your account, whose notification preferences pick the channels, so it cannot be combined with --channel (a feed sink uses `channel: owner` instead). Drop --channel, or name an explicit recipient.';
  if (input.terminal) return '--pane, --socket, --no-enter and --combined only apply to --channel session.';
  if (input.thread?.trim()) return '--thread does not apply to --to owner; the account decides where the message lands.';
  if (input.attachments?.length) return '--attach does not apply to --to owner; owner notifications carry text and a link. Pass --url instead.';
  return null;
}

export async function sendMessage(
  input: ResolveSendInput,
  meta: Meta,
): Promise<{ result: SendResult; envelope: SendEnvelope } | { error: string }> {
  if (isOwnerAlias(input.to)) {
    const refused = ownerSendError(input);
    if (refused) return { error: refused };
    const resolvedText = resolveText(input, false);
    if (!resolvedText.ok) return resolvedText;
    const { ownerMessageNotification } = await import('../owner-message.js');
    const notification = ownerMessageNotification(resolvedText.text, {
      ...(input.from?.trim() ? { agent: input.from.trim() } : {}),
      ...(input.urls?.[0]?.trim() ? { url: input.urls[0].trim() } : {}),
    });
    const result = await sendToOwner(notification, { dryRun: input.dryRun });
    return {
      result,
      envelope: { text: notification.body, channel: 'owner', to: 'owner', dryRun: input.dryRun },
    };
  }
  const resolved = resolveSendEnvelope(input, meta);
  if (!resolved.ok) return { error: resolved.error };
  return { result: await deliverEnvelope(resolved.envelope, meta), envelope: resolved.envelope };
}
