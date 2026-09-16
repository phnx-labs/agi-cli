import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { probeOwnerSink } from './owner-sink.js';
import type { Meta } from '../types.js';

describe('probeOwnerSink', () => {
  const savedHumans = process.env.AGENTS_HUMANS_FILE;
  const savedSlackToken = process.env.SLACK_BOT_TOKEN;

  beforeEach(() => {
    process.env.AGENTS_HUMANS_FILE = path.join(os.tmpdir(), 'agents-owner-sink-test-absent.yaml');
    delete process.env.SLACK_BOT_TOKEN;
  });
  afterEach(() => {
    if (savedHumans === undefined) delete process.env.AGENTS_HUMANS_FILE;
    else process.env.AGENTS_HUMANS_FILE = savedHumans;
    if (savedSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedSlackToken;
  });

  it('reports configured:false when no owner is set', async () => {
    const s = await probeOwnerSink({} as Meta);
    expect(s.configured).toBe(false);
    expect(s.reachable).toBe(false);
  });

  it('imessage on non-macOS is unreachable', async () => {
    if (process.platform === 'darwin') return; // skip on macOS where it IS reachable
    const meta = { notify: { owner: { channel: 'imessage', to: '+15550000000' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({
      configured: true,
      reachable: false,
      channel: 'imessage',
      transport: 'imessage',
      reason: 'imessage-not-macos',
    });
  });

  it('slack with SLACK_BOT_TOKEN in env is reachable', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    const meta = { notify: { owner: { channel: 'slack', to: 'D0B0L8PCH4K' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: true, channel: 'slack', transport: 'slack' });
  });

  it('slack without token is unreachable', async () => {
    const meta = { notify: { owner: { channel: 'slack', to: 'D0B0L8PCH4K' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({
      configured: true,
      reachable: false,
      channel: 'slack',
      reason: 'slack-no-token',
    });
  });

  it('telegram (daemon removed) is unsupported', async () => {
    const meta = { notify: { owner: { channel: 'telegram', to: 'chat-123' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: false, reason: 'channel-unsupported' });
  });

  it('a non-rush owner transport delivers locally → reachable', async () => {
    const meta = { notify: { owner: { channel: 'desktop', to: 'local' } } } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: true, channel: 'desktop', transport: 'desktop' });
    expect(s.reason).toBeUndefined();
  });

  it('resolves the transport through notify.transports before deciding', async () => {
    const meta = {
      notify: { owner: { channel: 'imessage', to: 'x' }, transports: { imessage: 'desktop' } },
    } as Meta;
    const s = await probeOwnerSink(meta);
    expect(s).toMatchObject({ configured: true, reachable: true, transport: 'desktop' });
  });
});
