import { injectIntoTerminal } from '../../terminal/index.js';
import { resolveLiveInjectTarget } from '../../session/inject-target.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const NAME = 'session';

export const sessionProvider: ChannelProvider = {
  name: NAME,
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    const id = opts.target;
    const fail = (error: string): SendResult => ({ ok: false, channel: NAME, id, error });
    if (!text.trim()) return fail('refusing to type an empty message into a session');
    if (opts.attachments?.length) return fail('the session channel types text only; --attach is not supported');
    if (opts.thread) return fail('the session channel has no threads; drop --thread');
    if (opts.from) return fail('the session channel types the text verbatim; drop --from');

    const resolved = await resolveLiveInjectTarget(id);
    if (!resolved.target) {
      return fail(resolved.hint ? `${resolved.reason}\n${resolved.hint}` : resolved.reason ?? 'session not addressable');
    }
    if (opts.dryRun) return { ok: true, channel: NAME, id };

    const res = await injectIntoTerminal(resolved.target, text, { enter: true });
    return res.ok ? { ok: true, channel: NAME, id } : fail(res.error ?? 'injection failed');
  },
};
