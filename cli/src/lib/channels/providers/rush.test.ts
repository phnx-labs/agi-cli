import { describe, expect, it } from 'vitest';
import {
  buildImessageOsascriptArgs,
  buildSlackPayload,
  rushProviders,
  RUSH_CHANNELS,
} from './rush.js';

describe('buildImessageOsascriptArgs', () => {
  it('wraps the text and phone in an AppleScript tell block', () => {
    const args = buildImessageOsascriptArgs('hello world', '+18055550100');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('tell application "Messages"');
    expect(args[1]).toContain('buddy "+18055550100"');
    expect(args[1]).toContain('send "hello world"');
  });

  it('escapes double quotes and backslashes in the text', () => {
    const args = buildImessageOsascriptArgs('say "hi" \\ there', '+18055550100');
    expect(args[1]).toContain('send "say \\"hi\\" \\\\ there"');
  });

  it('escapes the phone parameter to prevent AppleScript injection', () => {
    const malicious = '" & (do shell script "rm -rf /") & "';
    const args = buildImessageOsascriptArgs('hello', malicious);
    expect(args[1]).toContain('buddy "\\" & (do shell script \\"rm -rf /\\") & \\""');
  });
});

describe('buildSlackPayload', () => {
  it('builds a chat.postMessage payload with channel and text', () => {
    expect(buildSlackPayload('C0123', 'hello')).toEqual({ channel: 'C0123', text: 'hello' });
  });

  it('includes thread_ts when a thread is given', () => {
    const payload = buildSlackPayload('C0123', 'hi', '1712345678.000100');
    expect(payload.thread_ts).toBe('1712345678.000100');
  });

  it('omits thread_ts when no thread is given', () => {
    const payload = buildSlackPayload('C0123', 'hi');
    expect(payload).not.toHaveProperty('thread_ts');
  });
});

describe('rushProviders', () => {
  it('exposes one provider per rush channel, named by channel', () => {
    expect(rushProviders.map((p) => p.name).sort()).toEqual([...RUSH_CHANNELS].sort());
  });

  it('dry-run short-circuits without side effects', async () => {
    const imessage = rushProviders.find((p) => p.name === 'imessage')!;
    const res = await imessage.send('hi', { target: '+18055550100', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('imessage');
  });

  it('dry-run works for slack too', async () => {
    const slack = rushProviders.find((p) => p.name === 'slack')!;
    const res = await slack.send('hi', { target: 'C0123', dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('slack');
  });

  it('telegram returns a clear unsupported error', async () => {
    const tg = rushProviders.find((p) => p.name === 'telegram')!;
    const res = await tg.send('hi', { target: 'chat-123' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Rush daemon');
  });
});
