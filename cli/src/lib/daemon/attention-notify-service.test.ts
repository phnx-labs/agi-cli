import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AttentionNotifyService, buildAttentionNotification } from './attention-notify-service.js';
import type { AttentionItem } from '../feed/attention.js';
import type { ActiveSession } from '../session/active.js';
import type { DaemonContext } from './service.js';
import type { DesktopNotification } from '../menubar/notify-desktop.js';

const ctx: DaemonContext = { log: () => {} };

/** Minimal live session — only the fields the reconciler + banner builder read. */
function session(partial: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    host: 'iterm',
    ...partial,
  } as ActiveSession;
}

describe('buildAttentionNotification', () => {
  const base: AttentionItem = {
    key: 'zion/sess-1/t4000',
    sessionId: 'sess-1',
    mailboxId: 'sess-1',
    host: 'zion',
    project: 'agents-cli',
    kind: 'permission',
    source: 'lifecycle',
    state: 'open',
    openedAt: '2026-09-07T10:00:00.000Z',
    question: { text: 'Run the test suite?' },
    choices: [
      { id: 'approve', label: 'Approve', deliveryKey: '1' },
      { id: 'approve-session', label: 'Approve for session', deliveryKey: '2' },
      { id: 'deny', label: 'Deny', deliveryKey: 'esc' },
    ],
    replyCapability: 'terminal',
    fingerprint: 'abc',
  };

  it('carries category, key, session, agent, subtitle, and choices for a permission item', () => {
    const n = buildAttentionNotification(base, session({ sessionId: 'sess-1', label: 'fix-parser' }));
    expect(n).toEqual({
      title: 'fix-parser · Command approval',
      body: 'Run the test suite?',
      category: 'permission',
      key: 'zion/sess-1/t4000',
      agent: 'claude',
      sessionId: 'sess-1',
      subtitle: 'zion · agents-cli',
      choices: [
        { id: 'approve', label: 'Approve' },
        { id: 'approve-session', label: 'Approve for session' },
        { id: 'deny', label: 'Deny' },
      ],
    });
  });

  it('falls back to the short session id when the session is unnamed', () => {
    const n = buildAttentionNotification({ ...base, sessionId: 'abcdef1234567890' }, session({ sessionId: 'abcdef1234567890' }));
    expect(n!.title).toBe('abcdef12 · Command approval');
  });

  it('labels a question and a plan review by their category verb', () => {
    const q = buildAttentionNotification({ ...base, kind: 'question', question: { text: 'Which rule?' } }, session({}));
    expect(q!.title).toBe('sess-1 · Question');
    expect(q!.category).toBe('question');
    const p = buildAttentionNotification({ ...base, kind: 'plan_review', question: { text: 'Plan ready' } }, session({}));
    expect(p!.title).toBe('sess-1 · Plan review');
    expect(p!.category).toBe('plan_review');
  });

  it('a stall becomes a failure banner with one open-terminal choice', () => {
    const n = buildAttentionNotification({ ...base, kind: 'stall', choices: undefined }, session({}));
    expect(n!.category).toBe('failure');
    expect(n!.title).toBe('sess-1 · Failed');
    expect(n!.choices).toEqual([{ id: 'open-terminal', label: 'Open terminal' }]);
  });

  it('produces no banner for a done/declared/review kind', () => {
    expect(buildAttentionNotification({ ...base, kind: 'declared' }, session({}))).toBeUndefined();
    expect(buildAttentionNotification({ ...base, kind: 'review' }, session({}))).toBeUndefined();
  });

  it('caps the body at 200 chars', () => {
    const n = buildAttentionNotification({ ...base, question: { text: 'x'.repeat(300) } }, session({}));
    expect(n!.body.length).toBeLessThanOrEqual(200);
    expect(n!.body.endsWith('…')).toBe(true);
  });
});

describe('AttentionNotifyService — ledger idempotency', () => {
  let tmp: string;
  let posts: DesktopNotification[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-notify-'));
    posts = [];
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeService() {
    const waiting = session({
      sessionId: 'sess-perm',
      awaitingReason: 'permission',
      activity: 'waiting_input',
      question: { text: 'Approve running the release?', reason: 'permission' },
      lastActivityMs: 4000,
    });
    return new AttentionNotifyService({
      getSessions: async () => [waiting],
      notify: (n) => posts.push(n),
      feedRoot: path.join(tmp, 'feed'),
      ledgerDir: path.join(tmp, 'notified'),
      now: () => 1_000_000,
    });
  }

  it('posts exactly one banner per key across two ticks, and writes a ledger sidecar', async () => {
    const service = makeService();
    // tick() (public, from PeriodicService) drives the real onTick + reconciler.
    const signal = new AbortController().signal;
    await service.tick(ctx, signal);
    await service.tick(ctx, signal);

    expect(posts).toHaveLength(1);
    expect(posts[0].category).toBe('permission');
    expect(posts[0].key).toContain('/sess-perm/');
    expect(posts[0].choices?.map((c) => c.id)).toEqual(['approve', 'approve-session', 'deny']);

    // The idempotency truth is the on-disk ledger, not memory.
    const ledgerFiles = fs.readdirSync(path.join(tmp, 'notified'));
    expect(ledgerFiles).toHaveLength(1);
    const record = JSON.parse(fs.readFileSync(path.join(tmp, 'notified', ledgerFiles[0]), 'utf-8'));
    expect(record.key).toBe(posts[0].key);
    expect(record.postedAt).toBe('1970-01-01T00:16:40.000Z');
  });

  it('a fresh service instance reads the same ledger and does not re-post (survives restart)', async () => {
    const signal = new AbortController().signal;
    await makeService().tick(ctx, signal);
    expect(posts).toHaveLength(1);
    // New instance = a daemon restart. Memory is gone; the ledger is not.
    await makeService().tick(ctx, signal);
    expect(posts).toHaveLength(1);
  });
});
