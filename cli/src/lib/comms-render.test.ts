import { describe, expect, it } from 'vitest';
import { aggregate, masthead, type CommsMsg } from './comms-render.js';
import { stringWidth, stripAnsi } from './session/width.js';
import type { StoredMessage } from './mailbox.js';

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    msgId: 'msg-1',
    to: 'recipient',
    from: 'claude/alpha',
    ts: '2026-07-15T12:00:00.000Z',
    text: 'hello',
    state: 'inbox',
    ...overrides,
  };
}

function comms(overrides: Partial<CommsMsg> = {}): CommsMsg {
  return {
    from: 'claude/alpha',
    to: 'recipient-id',
    toLabel: 'recipient',
    ts: '2026-07-15T12:00:00.000Z',
    text: 'hello',
    state: 'inbox',
    box: 'recipient-id',
    ...overrides,
  };
}

describe('masthead', () => {
  it('aligns the right-hand value to the terminal edge', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '72';
    try {
      const rendered = masthead({
        title: 'agents talking',
        host: 'zion',
        accent: 'cyan',
        stats: ['3 live', '23 boxes'],
        right: '14:02:51',
      });
      const plain = stripAnsi(rendered);
      expect(plain).toContain('⌁ agents talking · zion   3 live · 23 boxes');
      expect(plain).toMatch(/14:02:51$/);
      expect(stringWidth(rendered)).toBe(72);
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});

describe('aggregate', () => {
  it('sorts newest-first and resolves recipient labels with an id fallback', () => {
    const got = aggregate([
      {
        id: 'recipient-long-id',
        label: '',
        messages: [message({ msgId: 'old', ts: '2026-07-15T10:00:00.000Z', from: undefined })],
      },
      {
        id: 'second-box',
        label: 'Reviewer',
        messages: [message({ msgId: 'new', ts: '2026-07-15T12:00:00.000Z', to: 'second-box' })],
      },
    ]);

    expect(got.map((item) => item.ts)).toEqual([
      '2026-07-15T12:00:00.000Z',
      '2026-07-15T10:00:00.000Z',
    ]);
    expect(got[0]).toMatchObject({ box: 'second-box', to: 'second-box', toLabel: 'Reviewer' });
    expect(got[1]).toMatchObject({ from: 'operator', box: 'recipient-long-id', toLabel: 'recipien' });
  });
});
