import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import { publishBlock, blockIdForSession, getAnswerRecord, readBlock, type OpenBlock } from './feed.js';
import { reconcileAttention } from './attention.js';
import { claimAndRouteAttentionAnswer } from './answer.js';

describe('feed answer claim-before-route', () => {
  it('atomically permits one delivery and returns already_answered to the loser', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-mailbox-'));
    const session = { context: 'terminal', kind: 'claude', host: 'worker', sessionId: 'race', agentId: 'race', status: 'running' } as ActiveSession;
    const block: OpenBlock = {
      blockId: blockIdForSession('race'), sessionId: 'race', mailboxId: 'race', host: 'worker', runtime: 'claude',
      ts: '2026-08-23T10:00:00.000Z', questions: [{ text: 'Deploy?', options: [{ label: 'Wait' }, { label: 'Deploy' }] }],
    };
    publishBlock(block, root);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    const results = await Promise.all([
      claimAndRouteAttentionAnswer({ attentionKey: key, choiceId: 'wait', operator: { verified: false, label: 'left' }, feedRoot: root, mailboxRoot, sessions: [session] }),
      claimAndRouteAttentionAnswer({ attentionKey: key, choiceId: 'deploy', operator: { verified: false, label: 'right' }, feedRoot: root, mailboxRoot, sessions: [session] }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['already_answered', 'delivered']);
    const inbox = path.join(mailboxRoot, 'race', 'inbox');
    expect(fs.readdirSync(inbox)).toHaveLength(1);
    const delivered = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8')) as { text: string };
    expect(['Wait', 'Deploy']).toContain(delivered.text);
  });

  it('rejects an unverified high-consequence answer before delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-auth-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-auth-mailbox-'));
    const session = { context: 'terminal', kind: 'codex', host: 'worker', sessionId: 'release', agentId: 'release', status: 'running' } as ActiveSession;
    const block: OpenBlock = {
      blockId: blockIdForSession('release'), sessionId: 'release', mailboxId: 'release', host: 'worker', runtime: 'codex',
      ts: '2026-08-23T10:00:00.000Z', consequence: 'deploy', questions: [{ text: 'Publish?', options: [{ label: 'Publish' }] }],
    };
    publishBlock(block, root);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: 'publish', operator: { verified: false }, feedRoot: root, mailboxRoot, sessions: [session],
    })).rejects.toThrow('requires a verified, authorized operator');
    expect(fs.existsSync(path.join(mailboxRoot, 'release'))).toBe(false);
  });

  it('resolves --choice approve-session on a permission item to the harness key (2), delivered via the reply rail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-perm-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-perm-mailbox-'));
    // A running (not parked) agent routes the answer to its mailbox, so the
    // delivered text is exactly the resolved deliveryKey — proving `approve-session`
    // maps to Claude's option-2 selection token, not the label.
    // The block carries the harness's recorded subtype and a write-time cursor
    // the row's last transcript event precedes — a confirmed pending permission.
    const session = { context: 'terminal', kind: 'claude', host: 'worker', sessionId: 'perm', agentId: 'perm', status: 'running', activity: 'working', pidAlive: true, lastEventMs: 900 } as ActiveSession;
    const block: OpenBlock = {
      blockId: blockIdForSession('perm'), sessionId: 'perm', mailboxId: 'perm', host: 'worker', runtime: 'claude',
      ts: '2026-09-07T10:00:00.000Z', kind: 'notification', notificationType: 'permission_prompt', sourceCursor: { lastActivityMs: 1_000 },
      questions: [{ text: 'Permission — run the test suite' }],
    };
    publishBlock(block, root);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: 'approve-session', operator: { verified: false, label: 'op' }, feedRoot: root, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('delivered');
    const inbox = path.join(mailboxRoot, 'perm', 'inbox');
    const delivered = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8')) as { text: string };
    expect(delivered.text).toBe('2');
  });

  it('refuses to answer a request it could not verify is still pending (PHNX-3999)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-unverified-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-unverified-mailbox-'));
    // A cloud-shaped row: no transcript cursor to check the hook's word against,
    // and the permission prompt is well past the trust window.
    const session = { context: 'cloud', kind: 'claude', host: 'worker', sessionId: 'stale', agentId: 'stale', status: 'running' } as ActiveSession;
    const block: OpenBlock = {
      blockId: blockIdForSession('stale'), sessionId: 'stale', mailboxId: 'stale', host: 'worker', runtime: 'claude',
      ts: '2026-09-07T10:00:00.000Z', kind: 'notification', notificationType: 'permission_prompt', questions: [{ text: 'Permission — deploy' }],
    };
    publishBlock(block, root);
    const item = reconcileAttention({ block, session, nowMs: Date.now() })!;
    expect(item.kind).toBe('unverified');
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: item.key, text: '1', operator: { verified: false }, feedRoot: root, mailboxRoot, sessions: [session],
    })).rejects.toThrow('could not be verified as a pending request');
    expect(getAnswerRecord(block.blockId, root)).toBeUndefined();
    expect(fs.existsSync(path.join(mailboxRoot, 'stale'))).toBe(false);
  });

  it('recognizes lifecycle-only attention and rolls the claim back when its rail refuses delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-lifecycle-'));
    const mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-answer-lifecycle-mailbox-'));
    const session = {
      context: 'terminal', kind: 'kimi', host: 'worker', sessionId: 'hookless', status: 'input_required', tty: true,
      activity: 'waiting_input', awaitingReason: 'question', lastActivityMs: 100,
      question: { text: 'Choose?', reason: 'question', options: [{ label: 'Continue' }] },
    } as ActiveSession;
    const key = reconcileAttention({ session, nowMs: 200 })!.key;
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: 'continue', operator: { verified: false }, feedRoot: root, mailboxRoot, sessions: [session],
    })).rejects.toThrow('no addressable terminal');
    const blockId = blockIdForSession('hookless');
    expect(readBlock(blockId, root)).toMatchObject({ source: 'lifecycle', state: 'open' });
    expect(getAnswerRecord(blockId, root)).toBeUndefined();
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: key, choiceId: 'continue', operator: { verified: false }, feedRoot: root, mailboxRoot, sessions: [session],
    })).rejects.toThrow('no addressable terminal');
  });
});
