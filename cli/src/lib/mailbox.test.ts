import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mailboxDir, enqueue, assertValidMailboxId, isExpired, sweepExpired, readBox, DEFAULT_TTL_SECONDS, MAILBOX_TTL_ENV, type MailboxMessage } from './mailbox.js';
import { blockIdForSession, getBlockReceipts, publishBlock } from './feed/feed.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-test-'));
}

const BOX = 'a1b2';

function pending(boxDir: string): MailboxMessage[] {
  return readBox(boxDir).filter((m) => m.state !== 'consumed');
}

function backdateExpiry(boxDir: string, msgId: string, now: Date): void {
  const file = path.join(boxDir, 'inbox', `${msgId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf-8'));
  record.ts = new Date(now.getTime() - 60_000).toISOString();
  record.expiresAt = new Date(now.getTime() - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
}

describe('mailbox', () => {
  it('rejects a mailboxId with a path separator or traversal (fail loud, not silent-drop)', () => {
    const root = tmpRoot();
    for (const bad of ['team1/subagentA', '..', '.', '', 'a\\b', 'foo/../bar']) {
      expect(() => mailboxDir(bad, root)).toThrow(/Invalid mailboxId/);
    }
    const box = mailboxDir(BOX, root);
    expect(() => enqueue(box, { to: 'team1/subagentA', text: 'x' })).toThrow(/Invalid mailboxId/);
    expect(() => assertValidMailboxId('loop-1700000000000-a1b2c3')).not.toThrow();
  });

  it('round-trips the `from` field and a host:/path clip token in text', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, from: 'operator@s0', text: 'match this  zion:/Users/m/mock.png' });

    const [msg] = pending(box);
    expect(msg.from).toBe('operator@s0');
    expect(msg.text).toContain('zion:/Users/m/mock.png');
  });

  it('stamps expiresAt when ttlSeconds is provided', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, text: 'ttl', ttlSeconds: 60 });
    const msgs = pending(box);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].expiresAt).toBeTruthy();
    expect(Date.parse(msgs[0].expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('stamps expiresAt with a 24h default when ttlSeconds is omitted', () => {
    const previous = process.env[MAILBOX_TTL_ENV];
    delete process.env[MAILBOX_TTL_ENV];
    try {
      const box = mailboxDir(BOX, tmpRoot());
      const before = Date.now();
      enqueue(box, { to: BOX, text: 'default ttl' });
      const after = Date.now();
      const msgs = pending(box);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].expiresAt).toBeTruthy();
      const exp = Date.parse(msgs[0].expiresAt!);
      expect(exp).toBeGreaterThanOrEqual(before + DEFAULT_TTL_SECONDS * 1000);
      expect(exp).toBeLessThanOrEqual(after + DEFAULT_TTL_SECONDS * 1000);
    } finally {
      if (previous === undefined) delete process.env[MAILBOX_TTL_ENV];
      else process.env[MAILBOX_TTL_ENV] = previous;
    }
  });

  it('honors ttlSeconds: 0 to disable expiry', () => {
    const box = mailboxDir(BOX, tmpRoot());
    enqueue(box, { to: BOX, text: 'no ttl', ttlSeconds: 0 });
    expect(pending(box)[0].expiresAt).toBeUndefined();
  });

  it('sweepExpired drops expired messages to consumed with a dropped marker', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const now = new Date('2026-01-01T00:00:00.000Z');
    const msgId = enqueue(box, { to: BOX, text: 'fresh', ttlSeconds: 30 });
    backdateExpiry(box, msgId, now);

    expect(sweepExpired(box, BOX, now)).toBe(1);
    expect(pending(box)).toEqual([]);
    const consumed = fs.readdirSync(path.join(box, 'consumed'));
    expect(consumed).toHaveLength(1);
    const archived = JSON.parse(fs.readFileSync(path.join(box, 'consumed', consumed[0]), 'utf-8'));
    expect(archived.dropped).toBe('expired');
    expect(archived.text).toBe('fresh');
  });

  it('isExpired checks expiry against a provided time', () => {
    const msg: MailboxMessage = { msgId: 'x', to: BOX, ts: '', text: '', expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(isExpired(msg, new Date('2026-01-01T00:00:01.000Z'))).toBe(true);
    expect(isExpired(msg, new Date('2025-12-31T23:59:59.000Z'))).toBe(false);
  });

  it('surfaces an expired receipt when sweepExpired drops a message carrying blockId', () => {
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-expired-receipt-'));
    const blockId = blockIdForSession(BOX);
    publishBlock({
      blockId,
      sessionId: BOX,
      mailboxId: BOX,
      host: 'test-host',
      runtime: 'claude',
      ts: new Date().toISOString(),
      questions: [{ text: 'Confirm?' }],
    }, feedDir);

    const box = mailboxDir(BOX, tmpRoot());
    const now = new Date('2026-01-01T00:00:00.000Z');
    const msgId = enqueue(box, { to: BOX, from: 'feed', text: 'too late', blockId });
    backdateExpiry(box, msgId, now);

    expect(sweepExpired(box, BOX, now, feedDir)).toBe(1);

    const receipts = getBlockReceipts(blockId, feedDir);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ msgId, status: 'expired', from: 'feed' });
  });
});

describe('readBox', () => {
  it('reads all three buckets, tags state, and sorts FIFO — including consumed', () => {
    const box = mailboxDir(BOX, tmpRoot());
    const first = enqueue(box, { to: BOX, text: 'first', from: 'claude/alpha' });
    const second = enqueue(box, { to: BOX, text: 'second' });
    const third = enqueue(box, { to: BOX, text: 'third-claimed' });
    enqueue(box, { to: BOX, text: 'fourth-still-pending' });
    for (const id of [first, second]) {
      fs.renameSync(path.join(box, 'inbox', `${id}.json`), path.join(box, 'consumed', `${id}.json`));
    }
    fs.renameSync(path.join(box, 'inbox', `${third}.json`), path.join(box, 'processing', `${third}.json`));

    const all = readBox(box);
    expect(all.map((m) => m.text)).toEqual(['first', 'second', 'third-claimed', 'fourth-still-pending']);
    expect(all.map((m) => m.state)).toEqual(['consumed', 'consumed', 'processing', 'inbox']);
    expect(all[0].from).toBe('claude/alpha');
    expect(readBox(box)).toEqual(all);
  });
});
