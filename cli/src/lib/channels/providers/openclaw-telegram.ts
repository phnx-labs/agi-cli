import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildOpenClawNotifyArgs } from '../../notify.js';
import type { ChannelProvider, SendOptions, SendResult } from '../registry.js';

const execFileAsync = promisify(execFile);

export const openclawTelegramProvider: ChannelProvider = {
  name: 'openclaw-telegram',
  async send(text: string, opts: SendOptions): Promise<SendResult> {
    const name = 'openclaw-telegram';
    if (opts.dryRun) {
      return { ok: true, channel: name, id: opts.target };
    }
    try {
      await execFileAsync('which', ['openclaw']);
    } catch {
      return { ok: false, channel: name, id: opts.target, error: 'openclaw CLI not found on PATH' };
    }
    try {
      await execFileAsync('openclaw', buildOpenClawNotifyArgs(text, { target: opts.target }));
      return { ok: true, channel: name, id: opts.target };
    } catch (err) {
      return { ok: false, channel: name, id: opts.target, error: (err as Error).message };
    }
  },
};
