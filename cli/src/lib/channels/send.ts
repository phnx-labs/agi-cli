import type { Meta } from '../types.js';
import { getOwnerNotifyFromHumans } from '../humans.js';
import { registerBuiltinProviders } from './providers/index.js';
import { lookupTransport, resolveTransport } from './resolve.js';
import type { SendResult, TerminalSendOptions } from './registry.js';
import { SESSION_CHANNEL } from './providers/session.js';
import { sendToOwner } from '../notify.js';
import type { SinkMessageFormat } from '../sink-format.js';

interface SendEnvelope {
  text: string;
  channel: string;
  to: string;
  thread?: string;
  attachments?: string[];
  from?: string;
  ownerScoped?: boolean;
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
  ownerMode?: boolean;
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

export function readOwnerDest(meta: Meta): { channel: string; to: string } | null {
  const canonical = getOwnerNotifyFromHumans();
  if (canonical) return canonical;
  const channel = meta.notify?.owner?.channel?.trim();
  const to = meta.notify?.owner?.to?.trim();
  return channel && to ? { channel, to } : null;
}

// The session channel types into a terminal, so its text is delivered byte for
// byte: surrounding whitespace is input, and an explicitly empty message still
// presses Enter. Every other channel trims.
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
  let channel = (input.channel ?? '').trim();
  let to = (input.to ?? '').trim();
  const usedOwnerAlias = isOwnerAlias(to);
  const ownerAddressed = input.ownerMode || usedOwnerAlias;

  if (ownerAddressed) {
    const owner = getOwnerNotifyFromHumans() ?? meta.notify?.owner;
    const ownerChannel = owner?.channel ?? '';
    const ownerTo = owner?.to ?? '';
    if (!channel) channel = ownerChannel;
    if (!to || usedOwnerAlias) to = ownerTo;
  }

  const isSession = !ownerAddressed && Boolean(channel)
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
    const hint =
      ownerAddressed
        ? 'Set owner.channels and owner.policy.normal in humans.yaml, or pass --channel and --to explicitly.'
        : isSession
          ? 'Need --to <session> (find ids with: agents ps) or --pane <tmux pane id>.'
          : 'Need --channel and --to (or --to owner with notify.owner configured). ' +
            'Example: agents send --channel desktop --to local --text "hi"';
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
      ownerScoped: usedOwnerAlias || (input.ownerMode === true && !input.to?.trim()),
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
    ownerScoped: envelope.ownerScoped,
    dryRun: envelope.dryRun,
    terminal: envelope.terminal,
  });
}

export async function sendMessage(
  input: ResolveSendInput,
  meta: Meta,
  ownerCompose?: (format: SinkMessageFormat) => string,
): Promise<{ result: SendResult; envelope: SendEnvelope } | { error: string }> {
  const resolved = resolveSendEnvelope(input, meta);
  if (!resolved.ok) return { error: resolved.error };
  const ownerPolicyRequest = resolved.envelope.ownerScoped === true
    && !input.channel?.trim()
    && (!input.to?.trim() || isOwnerAlias(input.to));
  const result = ownerPolicyRequest
    ? await sendToOwner(resolved.envelope.text, {
        meta,
        dryRun: resolved.envelope.dryRun,
        thread: resolved.envelope.thread,
        attachments: resolved.envelope.attachments,
        from: resolved.envelope.from,
        ...(ownerCompose ? { composeForFormat: ownerCompose } : {}),
      })
    : await deliverEnvelope(resolved.envelope, meta);
  return { result, envelope: resolved.envelope };
}
