
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  buildOpenClawNotifyArgs,
  formatUrgentBlockMessage,
} from './notify.js';

describe('buildOpenClawNotifyArgs', () => {
  it('builds message-send argv with the caller-supplied target (no hardcoded number)', () => {
    const args = buildOpenClawNotifyArgs('hello', { target: 'chat-42' });
    expect(args).toEqual([
      'message',
      'send',
      '--channel',
      'telegram',
      '--account',
      'default',
      '--target',
      'chat-42',
      '--message',
      'hello',
    ]);
    expect(args).not.toContain('--text');
  });

  it('has no numeric-literal recipient default baked into the source', () => {
    const src = fs.readFileSync(new URL('./notify.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/\?\?\s*['"]\d{5,}['"]/);
  });
});

describe('formatUrgentBlockMessage', () => {
  it('formats urgent feed notifications without emoji', () => {
    const message = formatUrgentBlockMessage({
      blockId: 'block-a',
      sessionId: 'a',
      mailboxId: 'a',
      host: 'zion',
      runtime: 'headless',
      ts: '2026-07-21T12:00:00.000Z',
      blockClass: 'decision',
      costOfDelay: 'high',
      questions: [{ header: 'Deploy', text: 'Production deploy?' }],
    });

    expect(message).toBe('URGENT DECISION on zion: [Deploy] Production deploy? (cost: high, id: block-a)');
    expect(message).not.toContain(String.fromCodePoint(0x1f6a8));
  });
});
