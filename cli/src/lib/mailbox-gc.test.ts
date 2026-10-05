import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mailboxDir, enqueue, drain } from './mailbox.js';
import { gcMailbox } from './mailbox-gc.js';
import { blockIdForSession, publishBlock, readBlock } from './feed/feed.js';

// Failed atomic archive writes retain inbox/prior consumed records and leave no temporary file.
function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-'));
}

function backdateFile(file: string, iso: string): void {
  const d = new Date(iso);
  fs.utimesSync(file, d, d);
}

const BOX = 'a1b2';

describe('mailbox GC', () => {
  it('archives pending messages from a dead box and removes its stale feed block', () => {
    const root = tmpRoot();
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-feed-'));
    const previous = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedDir;
    try {
      const box = mailboxDir(BOX, root);
      enqueue(box, { to: BOX, text: 'to dead agent' });
      const blockId = blockIdForSession(BOX);
      const blockFile = path.join(feedDir, `${blockId}.json`);
      publishBlock({
        blockId,
        sessionId: BOX,
        mailboxId: BOX,
        host: 'test-host',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Dead?' }],
      }, feedDir);
      backdateFile(blockFile, '2020-01-01T00:00:00.000Z');

      const result = gcMailbox(new Set(), { root, feedRoot: feedDir });

      expect(result.deadBoxes).toBe(1);
      expect(result.messagesDroppedDead).toBe(1);
      expect(result.blocksRemoved).toBe(1);
      const inboxFiles = fs.existsSync(path.join(box, 'inbox')) ? fs.readdirSync(path.join(box, 'inbox')) : [];
      expect(inboxFiles).toHaveLength(0);
      const consumed = fs.readdirSync(path.join(box, 'consumed'));
      expect(consumed).toHaveLength(1);
      const archived = JSON.parse(fs.readFileSync(path.join(box, 'consumed', consumed[0]), 'utf-8'));
      expect(archived.dropped).toBe('dead');
      expect(readBlock(blockId, feedDir)).toBeUndefined();
    } finally {
      process.env.AGENTS_FEED_DIR = previous;
    }
  });

  it('archives pending messages from a dead box and surfaces a dropped receipt on the block', () => {
    const root = tmpRoot();
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-feed-receipt-'));
    const previous = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedDir;
    try {
      const box = mailboxDir(BOX, root);
      const blockId = blockIdForSession(BOX);
      publishBlock({
        blockId,
        sessionId: BOX,
        mailboxId: BOX,
        host: 'test-host',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Dead?' }],
      }, feedDir);
      const msgId = enqueue(box, { to: BOX, text: 'to dead agent', from: 'operator', blockId });

      const result = gcMailbox(new Set(), { root, feedRoot: feedDir });

      expect(result.messagesDroppedDead).toBe(1);
      expect(result.blocksRemoved).toBe(0);
      const block = readBlock(blockId, feedDir);
      expect(block).toBeDefined();
      expect(block!.receipts).toHaveLength(1);
      expect(block!.receipts![0]).toMatchObject({ msgId, status: 'dropped', from: 'operator' });
    } finally {
      process.env.AGENTS_FEED_DIR = previous;
    }
  });

  it('leaves live boxes alone', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    enqueue(box, { to: BOX, text: 'alive' });

    const result = gcMailbox(new Set([BOX]), { root });

    expect(result.deadBoxes).toBe(0);
    expect(result.messagesDroppedDead).toBe(0);
    expect(fs.readdirSync(path.join(box, 'inbox'))).toHaveLength(1);
  });

  it('prunes old consumed entries', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    enqueue(box, { to: BOX, text: 'old' });
    drain(box);
    const consumedFile = path.join(box, 'consumed', fs.readdirSync(path.join(box, 'consumed'))[0]);
    const oldTime = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(consumedFile, oldTime, oldTime);

    const result = gcMailbox(new Set([BOX]), { root, maxConsumedAgeMinutes: 1 });

    expect(result.consumedPruned).toBe(1);
    expect(fs.existsSync(consumedFile)).toBe(false);
  });

  it('archives expired messages from a live box (not just metrics)', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    const msgId = enqueue(box, { to: BOX, text: 'stale', ttlSeconds: 1 });
    const inboxFile = path.join(box, 'inbox', `${msgId}.json`);
    const raw = JSON.parse(fs.readFileSync(inboxFile, 'utf-8'));
    raw.expiresAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(inboxFile, JSON.stringify(raw, null, 2), 'utf-8');

    const result = gcMailbox(new Set([BOX]), { root, now: new Date('2026-07-14T00:00:00.000Z') });

    expect(result.messagesDroppedExpired).toBe(1);
    expect(fs.existsSync(inboxFile)).toBe(false);
    const consumed = fs.readdirSync(path.join(box, 'consumed'));
    expect(consumed).toHaveLength(1);
    const archived = JSON.parse(fs.readFileSync(path.join(box, 'consumed', consumed[0]), 'utf-8'));
    expect(archived.dropped).toBe('expired');
  });

  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate('a dead-box archive write that cannot complete leaves the inbox message and the prior consumed record untouched', () => {
    const root = tmpRoot();
    const box = mailboxDir(BOX, root);
    const msgId = enqueue(box, { to: BOX, text: 'to dead agent' });
    const inboxFile = path.join(box, 'inbox', `${msgId}.json`);
    const consumedDir = path.join(box, 'consumed');
    const consumedFile = path.join(consumedDir, `${msgId}.json`);

    fs.mkdirSync(consumedDir, { recursive: true });
    const priorConsumed = JSON.stringify({ sentinel: 'prior-consumed-record' }, null, 2);
    fs.writeFileSync(consumedFile, priorConsumed, 'utf-8');

    fs.chmodSync(consumedDir, 0o555);
    try {
      const result = gcMailbox(new Set(), { root });

      expect(result.messagesDroppedDead).toBe(0);
      expect(fs.existsSync(inboxFile)).toBe(true);
      expect(fs.readFileSync(consumedFile, 'utf-8')).toBe(priorConsumed);
    } finally {
      fs.chmodSync(consumedDir, 0o755);
    }

    expect(fs.readdirSync(consumedDir)).toEqual([`${msgId}.json`]);
  });

  it('archives messages that expired under the 24h default TTL and surfaces an expired receipt', () => {
    const root = tmpRoot();
    const feedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-mailbox-gc-expired-default-'));
    const previous = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedDir;
    try {
      const box = mailboxDir(BOX, root);
      const blockId = blockIdForSession(BOX);
      publishBlock({
        blockId,
        sessionId: BOX,
        mailboxId: BOX,
        host: 'test-host',
        runtime: 'claude',
        ts: new Date().toISOString(),
        questions: [{ text: 'Alive?' }],
      }, feedDir);
      const msgId = enqueue(box, { to: BOX, text: 'stale default ttl', from: 'operator', blockId });
      const inboxFile = path.join(box, 'inbox', `${msgId}.json`);
      const raw = JSON.parse(fs.readFileSync(inboxFile, 'utf-8'));
      raw.ts = '2000-01-01T00:00:00.000Z';
      raw.expiresAt = '2000-01-02T00:00:01.000Z';
      fs.writeFileSync(inboxFile, JSON.stringify(raw, null, 2), 'utf-8');

      const result = gcMailbox(new Set([BOX]), { root, feedRoot: feedDir, now: new Date('2026-07-14T00:00:00.000Z') });

      expect(result.messagesDroppedExpired).toBe(1);
      expect(fs.existsSync(inboxFile)).toBe(false);
      const block = readBlock(blockId, feedDir);
      expect(block).toBeDefined();
      expect(block!.receipts).toHaveLength(1);
      expect(block!.receipts![0]).toMatchObject({ msgId, status: 'expired', from: 'operator' });
    } finally {
      process.env.AGENTS_FEED_DIR = previous;
    }
  });
});
