import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import { mailboxProvider } from './mailbox.js';
import { mailboxDir, peek } from '../../mailbox.js';

const BOX = `agents-send-test-${process.pid}`;

afterEach(() => {
  try {
    fs.rmSync(mailboxDir(BOX), { recursive: true, force: true });
  } catch {
  }
});

describe('mailbox provider', () => {
  it('enqueues a real message into the box inbox and returns msgId', async () => {
    const res = await mailboxProvider.send('hello mailbox', { target: BOX, from: 'send-test' });
    expect(res.ok).toBe(true);
    expect(res.channel).toBe('mailbox');
    expect(res.msgId).toBeTruthy();

    const pending = peek(mailboxDir(BOX), BOX);
    expect(pending.map((m) => m.text)).toContain('hello mailbox');
    expect(pending.find((m) => m.text === 'hello mailbox')?.from).toBe('send-test');
  });

  it('rejects an invalid mailbox id without throwing', async () => {
    const res = await mailboxProvider.send('x', { target: '../etc/passwd' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid mailbox id/i);
  });

  it('dry-run does not write', async () => {
    const res = await mailboxProvider.send('nope', { target: BOX, dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.msgId).toBeUndefined();
    expect(peek(mailboxDir(BOX), BOX)).toHaveLength(0);
  });
});
