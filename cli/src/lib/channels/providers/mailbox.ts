import { mailboxDir, enqueue, isValidMailboxId } from '../../mailbox.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

export const mailboxProvider: ChannelProvider = {
  name: 'mailbox',
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    if (!isValidMailboxId(opts.target)) {
      return { ok: false, channel: 'mailbox', id: opts.target, error: `invalid mailbox id '${opts.target}'` };
    }
    if (opts.dryRun) {
      return { ok: true, channel: 'mailbox', id: opts.target };
    }
    try {
      const msgId = enqueue(mailboxDir(opts.target), { to: opts.target, text, from: opts.from });
      return { ok: true, channel: 'mailbox', id: opts.target, msgId };
    } catch (err) {
      return { ok: false, channel: 'mailbox', id: opts.target, error: (err as Error).message };
    }
  },
};
