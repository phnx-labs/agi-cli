import { injectIntoTerminal, type InjectTarget } from '../../terminal/index.js';
import { resolveLiveInjectTarget } from '../../session/inject-target.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

export const SESSION_CHANNEL = 'session';

export const sessionProvider: ChannelProvider = {
  name: SESSION_CHANNEL,
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    const id = opts.target;
    const fail = (error: string): SendResult => ({ ok: false, channel: SESSION_CHANNEL, id, error });
    if (opts.attachments?.length) return fail('the session channel types text only; --attach is not supported');
    if (opts.thread) return fail('the session channel has no threads; drop --thread');
    if (opts.from) return fail('the session channel types the text verbatim; drop --from');

    const terminal = opts.terminal ?? {};
    let target: InjectTarget;
    if (terminal.pane) {
      target = { backend: 'tmux', pane: terminal.pane, socket: terminal.socket };
    } else {
      const resolved = await resolveLiveInjectTarget(id);
      if (!resolved.target) {
        return fail(resolved.hint ? `${resolved.reason}\n${resolved.hint}` : resolved.reason ?? 'session not addressable');
      }
      target = resolved.target;
    }

    const res = await injectIntoTerminal(target, text, {
      enter: terminal.enter !== false,
      combined: terminal.combined,
      dryRun: opts.dryRun,
    });
    const delivery = { backend: res.backend, writes: res.writes, confirmed: res.confirmed };
    return res.ok
      ? { ok: true, channel: SESSION_CHANNEL, id, ...delivery }
      : { ...fail(res.error ?? 'injection failed'), ...delivery };
  },
};
