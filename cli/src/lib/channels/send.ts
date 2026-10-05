import type { Meta } from '../types.js';
import { getOwnerNotifyFromHumans } from '../humans.js';
import { registerBuiltinProviders } from './providers/index.js';
import { resolveTransport } from './resolve.js';
import type { SendResult } from './registry.js';
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
}

type ResolveSendResult =
  | { ok: true; envelope: SendEnvelope }
  | { ok: false; error: string };

const OWNER_ALIAS = 'owner';

export function isOwnerAlias(to: string | undefined): boolean {
  return (to ?? '').trim().toLowerCase() === OWNER_ALIAS;
}

export function composeSendText(text: string, urls?: string[]): string {
  const body = text.trim();
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

export function resolveSendEnvelope(input: ResolveSendInput, meta: Meta): ResolveSendResult {
  const positional = (input.positionalText ?? '').trim();
  const flagged = (input.text ?? '').trim();
  if (positional && flagged && positional !== flagged) {
    return {
      ok: false,
      error: 'Pass the message once: use --text, or a positional argument, not both with different values.',
    };
  }
  const rawText = flagged || positional;
  const urls = (input.urls ?? []).map((u) => u.trim()).filter(Boolean);
  const text = composeSendText(rawText, urls);
  if (!text) {
    return {
      ok: false,
      error: 'Message is empty. Pass --text "…", a positional message, and/or --url.',
    };
  }

  let channel = (input.channel ?? '').trim();
  let to = (input.to ?? '').trim();
  const usedOwnerAlias = isOwnerAlias(to);

  if (input.ownerMode || usedOwnerAlias) {
    const owner = getOwnerNotifyFromHumans() ?? meta.notify?.owner;
    const ownerChannel = owner?.channel ?? '';
    const ownerTo = owner?.to ?? '';
    if (!channel) channel = ownerChannel;
    if (!to || usedOwnerAlias) to = ownerTo;
  }

  if (!channel || !to) {
    const hint =
      input.ownerMode || usedOwnerAlias
        ? 'Set owner.channels and owner.policy.normal in humans.yaml, or pass --channel and --to explicitly.'
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
