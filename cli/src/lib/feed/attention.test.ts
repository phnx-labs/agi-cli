import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  reconcileAttention,
  attentionFingerprint,
  UNVERIFIED_PROMPT_AGE_MS,
  type PullRequestAttentionSignal,
} from './attention.js';
import {
  buildDeclaredBlock,
  publishBlock,
  readBlock,
  recordAnswer,
  recordContinued,
  removeBlock,
  readResolution,
  blockIdForSession,
  deriveBlockState,
  type OpenBlock,
  type AttentionResolution,
} from './feed.js';
import type { ActiveSession } from '../session/active.js';

function tmpFeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-attention-test-'));
}

/** Minimal ActiveSession — only the fields the reconciler reads matter. */
function session(partial: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    host: 'zion',
    ...partial,
  } as ActiveSession;
}

/** An open question block as the harness hook would write it (no explicit lifecycle fields). */
function openQuestionBlock(partial: Partial<OpenBlock> = {}): OpenBlock {
  return {
    blockId: blockIdForSession('sess-1'),
    sessionId: 'sess-1',
    mailboxId: 'mbx-1',
    host: 'zion',
    runtime: 'claude',
    ts: '2026-08-23T10:00:00.000Z',
    kind: 'question',
    questions: [{ text: 'Which reconciliation rule?', options: [{ label: 'Augment' }, { label: 'Replace' }] }],
    ...partial,
  };
}

describe('reconcileAttention', () => {
  it.each([
    ['Claude question', 'claude', 'question', [{ label: 'A' }], 'lifecycle', 'question'],
    ['plan review', 'gemini', 'plan_review', undefined, 'lifecycle', 'plan_review'],
    ['prose fallback', 'opencode', 'question', undefined, 'heuristic', 'question'],
    ['no hook event', 'kimi', 'question', [{ label: 'Continue' }], 'lifecycle', 'question'],
    // A lifecycle `permission` is a claim only an older peer's state engine still
    // makes (from elapsed time, not a harness event): unverified, never approvable.
    ['older-peer permission claim', 'claude', 'permission', undefined, 'heuristic', 'unverified'],
  ] as const)('%s uses the shared lifecycle projection', (_fixture, kind, reason, options, source, expectedKind) => {
    const item = reconcileAttention({
      session: session({
        kind, sessionId: `fixture-${kind}-${reason}`, activity: 'waiting_input', awaitingReason: reason,
        question: { text: 'Needs operator input', reason, ...(options ? { options: [...options] } : {}) }, lastActivityMs: 9000,
      }),
      nowMs: 10_000,
    });
    expect(item).toMatchObject({ source, state: 'open', kind: expectedKind });
    if (expectedKind === 'unverified') expect(item!.choices).toBeUndefined();
  });

  describe('a notification block is classified by its recorded subtype, never by the fact that it fired (PHNX-3999)', () => {
    const notification = (partial: Partial<OpenBlock>): OpenBlock => ({
      blockId: blockIdForSession('sess-n'), sessionId: 'sess-n', mailboxId: 'sess-n', host: 'zion', runtime: 'claude',
      ts: '2026-09-10T10:00:05.250Z', sourceCursor: { lastActivityMs: Date.parse('2026-09-10T10:00:05.250Z') },
      kind: 'notification', questions: [{ text: 'Claude needs your permission to use Bash', header: 'Permission needed' }],
      ...partial,
    });
    /** A live Claude row whose last transcript event (the tool call) precedes the block. */
    const pending = (partial: Partial<ActiveSession> = {}) => session({
      sessionId: 'sess-n', activity: 'working', pidAlive: true,
      lastEventMs: Date.parse('2026-09-10T10:00:03.000Z'), lastActivityMs: Date.parse('2026-09-10T10:00:05.400Z'), ...partial,
    });
    const now = Date.parse('2026-09-10T10:00:30.000Z');

    it('permission_prompt with an unadvanced transcript is a confirmed permission with the harness choices', () => {
      const item = reconcileAttention({ block: notification({ notificationType: 'permission_prompt' }), session: pending(), nowMs: now });
      expect(item).toMatchObject({ kind: 'permission', source: 'hook', state: 'open', key: 'zion/sess-n/2026-09-10T10:00:05.250Z' });
      expect(item!.choices?.map((c) => c.id)).toEqual(['approve', 'approve-session', 'deny']);
    });

    it('idle_prompt is not a request: the block yields nothing and the finished turn reads as nothing to do', () => {
      const block = notification({ notificationType: 'idle_prompt', questions: [{ text: 'Claude is waiting for your input', header: 'Idle Prompt' }] });
      expect(reconcileAttention({ block, session: pending({ activity: 'idle' }), nowMs: now })).toBeUndefined();
    });

    it('idle_prompt falls through to the lifecycle, so a real trailing question is still surfaced as inferred', () => {
      const block = notification({ notificationType: 'idle_prompt' });
      const item = reconcileAttention({
        block,
        session: pending({ activity: 'waiting_input', awaitingReason: 'question', question: { text: 'Which data directory should I use?', reason: 'question' } }),
        nowMs: now,
      });
      expect(item).toMatchObject({ kind: 'question', source: 'heuristic' });
      expect(item!.choices).toBeUndefined();
    });

    it('a transcript event stamped after the block resolves a hook-raised prompt (the tool ran, the dialog is gone)', () => {
      const approved = pending({ lastEventMs: Date.parse('2026-09-10T10:00:41.000Z') });
      expect(reconcileAttention({ block: notification({ notificationType: 'permission_prompt' }), session: approved, nowMs: now })).toBeUndefined();
    });

    it('a dead process resolves a hook-raised prompt — nothing can be showing a dialog', () => {
      expect(reconcileAttention({ block: notification({ notificationType: 'permission_prompt' }), session: pending({ pidAlive: false }), nowMs: now })).toBeUndefined();
    });

    it('later evidence never resolves a declared block — the agent said it is stuck until someone answers', () => {
      const declared = notification({ kind: 'declared', notificationType: undefined, questions: [{ text: 'npm token expired' }] });
      const advanced = pending({ lastEventMs: Date.parse('2026-09-10T10:05:00.000Z') });
      expect(reconcileAttention({ block: declared, session: advanced, nowMs: now })).toMatchObject({ kind: 'declared' });
    });

    it('with no transcript cursor to check, a fresh permission_prompt is trusted on the hook\'s word', () => {
      const cloud = pending({ lastEventMs: undefined, pidAlive: undefined });
      const item = reconcileAttention({ block: notification({ notificationType: 'permission_prompt' }), session: cloud, nowMs: now });
      expect(item).toMatchObject({ kind: 'permission' });
    });

    it('with no transcript cursor to check, a stale permission_prompt is "could not verify": findable, no approval buttons, no safe default', () => {
      const cloud = pending({ lastEventMs: undefined, pidAlive: undefined });
      const stale = Date.parse('2026-09-10T10:00:05.250Z') + UNVERIFIED_PROMPT_AGE_MS + 1;
      const item = reconcileAttention({ block: notification({ notificationType: 'permission_prompt', safeDefault: 'deny' }), session: cloud, nowMs: stale });
      expect(item).toMatchObject({ kind: 'unverified', source: 'hook', key: 'zion/sess-n/2026-09-10T10:00:05.250Z' });
      expect(item!.choices).toBeUndefined();
      expect(item!.safeDefault).toBeUndefined();
      expect(item!.question?.text).toBe('Claude needs your permission to use Bash');
    });

    it('a notification whose writer recorded no subtype cannot be answered from a banner', () => {
      const item = reconcileAttention({ block: notification({ notificationType: undefined }), session: pending(), nowMs: now });
      expect(item).toMatchObject({ kind: 'unverified' });
      expect(item!.choices).toBeUndefined();
    });

    it('an elicitation dialog is a question with no invented choices', () => {
      const item = reconcileAttention({ block: notification({ notificationType: 'elicitation_dialog', questions: [{ text: 'The server needs a value for region' }] }), session: pending(), nowMs: now });
      expect(item).toMatchObject({ kind: 'question', source: 'hook' });
      expect(item!.choices).toBeUndefined();
    });
  });
  it('block wins: an open block is authoritative even when the session reports working', () => {
    const item = reconcileAttention({
      block: openQuestionBlock(),
      session: session({ sessionId: 'sess-1', activity: 'working', lastActivityMs: 5000 }),
      nowMs: 10_000,
    });
    expect(item).toBeDefined();
    expect(item!.kind).toBe('question');
    expect(item!.source).toBe('hook');
    expect(item!.state).toBe('open');
    expect(item!.question?.text).toBe('Which reconciliation rule?');
    // Discrete options become slug-id choices. A feed block carries no per-option
    // key, so deliveryKey stays absent and the router matches the label to a digit.
    expect(item!.choices).toEqual([
      { label: 'Augment', id: 'augment' },
      { label: 'Replace', id: 'replace' },
    ]);
  });

  /** The permission_prompt block the harness hook writes, with its write-time cursor. */
  function permissionBlock(sessionId: string, runtime: string): OpenBlock {
    return {
      blockId: blockIdForSession(sessionId), sessionId, mailboxId: sessionId, host: 'zion', runtime,
      ts: '2026-09-07T10:00:05.000Z', sourceCursor: { lastActivityMs: 5_000 },
      kind: 'notification', notificationType: 'permission_prompt', questions: [{ text: 'Permission — run tests' }],
    };
  }

  it('a permission item exposes exactly approve / approve-session / deny for Claude', () => {
    const item = reconcileAttention({
      block: permissionBlock('perm-1', 'claude'),
      session: session({ kind: 'claude', sessionId: 'perm-1', activity: 'working', pidAlive: true, lastEventMs: 4_000, lastActivityMs: 5_100 }),
      nowMs: 10_000,
    });
    expect(item!.kind).toBe('permission');
    expect(item!.choices).toEqual([
      { id: 'approve', label: 'Approve', deliveryKey: '1' },
      { id: 'approve-session', label: 'Approve for session', deliveryKey: '2' },
      { id: 'deny', label: 'Deny', deliveryKey: 'esc' },
    ]);
  });

  it('a non-Claude permission item omits approve-session', () => {
    const item = reconcileAttention({
      block: permissionBlock('perm-2', 'codex'),
      session: session({ kind: 'codex', sessionId: 'perm-2', activity: 'working', pidAlive: true, lastEventMs: 4_000, lastActivityMs: 5_100 }),
      nowMs: 10_000,
    });
    expect(item!.kind).toBe('permission');
    expect(item!.choices?.map((c) => c.id)).toEqual(['approve', 'deny']);
  });

  it('a plan-review item exposes approve / send-back', () => {
    const item = reconcileAttention({
      session: session({
        sessionId: 'plan-choices',
        activity: 'waiting_input',
        awaitingReason: 'plan_review',
        question: { text: 'Plan ready', reason: 'plan_review' },
        lastActivityMs: 4000,
      }),
      nowMs: 10_000,
    });
    expect(item!.choices).toEqual([
      { id: 'approve', label: 'Approve plan', deliveryKey: '1' },
      { id: 'send-back', label: 'Send back', deliveryKey: 'esc' },
    ]);
  });

  it('lifecycle fallback: with no block, a structural plan handoff becomes the attention item', () => {
    const item = reconcileAttention({
      session: session({
        sessionId: 'sess-2',
        activity: 'waiting_input',
        awaitingReason: 'plan_review',
        question: { text: 'Approve this plan?', reason: 'plan_review' },
        lastActivityMs: 4000,
      }),
      nowMs: 10_000,
    });
    expect(item).toBeDefined();
    expect(item!.kind).toBe('plan_review');
    expect(item!.source).toBe('lifecycle');
    expect(item!.key).toBe('zion/sess-2/t4000');
  });

  it('lifecycle fallback: a bare prose question is the decaying heuristic source', () => {
    const item = reconcileAttention({
      session: session({
        sessionId: 'sess-3',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'Did that work?', reason: 'question' }, // no options => prose
        lastActivityMs: 4000,
      }),
      nowMs: 10_000,
    });
    expect(item!.source).toBe('heuristic');
    expect(item!.kind).toBe('question');
  });

  it('a structural question that carried options is lifecycle, not heuristic', () => {
    const item = reconcileAttention({
      session: session({
        sessionId: 'sess-3b',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'Pick one', reason: 'question', options: [{ label: 'A' }, { label: 'B' }] },
        lastActivityMs: 4000,
      }),
      nowMs: 10_000,
    });
    expect(item!.source).toBe('lifecycle');
  });

  it('disagreement: the open block wins over a conflicting session question', () => {
    const item = reconcileAttention({
      block: openQuestionBlock({ questions: [{ text: 'BLOCK: publish the release?' }] }),
      session: session({
        sessionId: 'sess-1',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'SESSION: something else', reason: 'question' },
        lastActivityMs: 5000,
      }),
      nowMs: 10_000,
    });
    expect(item!.question?.text).toBe('BLOCK: publish the release?');
  });

  it('a session that is not waiting on anyone yields no attention item', () => {
    const item = reconcileAttention({
      session: session({ sessionId: 'sess-idle', activity: 'idle', lastActivityMs: 4000 }),
      nowMs: 10_000,
    });
    expect(item).toBeUndefined();
  });

  it('stale resurrection: a resolved generation stays gone while the session sits still', () => {
    const resolution: AttentionResolution = {
      blockId: blockIdForSession('sess-4'),
      generation: 't3000',
      resolvedAt: '2026-08-23T10:05:00.000Z',
      sourceCursor: { lastActivityMs: 3000 },
      reason: 'answered',
    };
    // The session still reports waiting_input at the SAME (or older) cursor: it is a
    // stale re-read of the ask that was already answered, so it must not resurface.
    const stale = reconcileAttention({
      session: session({
        sessionId: 'sess-4',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'Which one?', reason: 'question', options: [{ label: 'A' }] },
        lastActivityMs: 3000,
      }),
      resolution,
      nowMs: 10_000,
    });
    expect(stale).toBeUndefined();

    // The transcript advances strictly past the tombstone's fence: a genuinely NEW
    // turn, a new generation, is allowed through.
    const fresh = reconcileAttention({
      session: session({
        sessionId: 'sess-4',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'A different, later ask?', reason: 'question', options: [{ label: 'A' }] },
        lastActivityMs: 9000,
      }),
      resolution,
      nowMs: 10_000,
    });
    expect(fresh).toBeDefined();
    expect(fresh!.key).toBe('zion/sess-4/t9000');
  });

  it('expiry: a tombstone with reason expired suppresses the decayed heuristic candidate', () => {
    const resolution: AttentionResolution = {
      blockId: blockIdForSession('sess-5'),
      generation: 't7000',
      resolvedAt: '2026-08-23T10:05:00.000Z',
      sourceCursor: { lastActivityMs: 7000 },
      reason: 'expired',
    };
    const item = reconcileAttention({
      session: session({
        sessionId: 'sess-5',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'inferred prose?', reason: 'question' },
        lastActivityMs: 6000, // at or before the fence => expired, suppressed
      }),
      resolution,
      nowMs: 10_000,
    });
    expect(item).toBeUndefined();
  });

  it('a tombstone for a DIFFERENT session never suppresses this one', () => {
    const resolution: AttentionResolution = {
      blockId: blockIdForSession('other-session'),
      generation: 't3000',
      resolvedAt: '2026-08-23T10:05:00.000Z',
      sourceCursor: { lastActivityMs: 9_999_999 },
      reason: 'answered',
    };
    const item = reconcileAttention({
      session: session({
        sessionId: 'sess-6',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'mine', reason: 'question', options: [{ label: 'A' }] },
        lastActivityMs: 3000,
      }),
      resolution,
      nowMs: 10_000,
    });
    expect(item).toBeDefined();
  });

  it('a new declared block is not suppressed when the session cursor is unresolvable', () => {
    // PHNX-3073: coveredByResolution defaults to suppress when the candidate has
    // no comparable sourceCursor.lastActivityMs. A declared block must stamp its
    // own cursor at write time so a fresh generation is not buried by a prior
    // tombstone while lastActivityMs is missing (cloud / remote / index-lag).
    const ts = '2026-08-27T12:00:00.000Z';
    const block = buildDeclaredBlock(
      { sessionId: 'sess-cloud', mailboxId: 'mbx', host: 'zion', runtime: 'claude' },
      { text: 'Need a new decision?', ts },
    );
    expect(block.sourceCursor?.lastActivityMs).toBe(Date.parse(ts));

    const resolution: AttentionResolution = {
      blockId: blockIdForSession('sess-cloud'),
      generation: '2026-08-27T11:00:00.000Z',
      resolvedAt: '2026-08-27T11:05:00.000Z',
      sourceCursor: { lastActivityMs: Date.parse('2026-08-27T11:00:00.000Z') },
      reason: 'answered',
    };

    const item = reconcileAttention({
      block,
      // No lastActivityMs — the session-derived fallback cannot prove advancement.
      session: session({ sessionId: 'sess-cloud', activity: 'working' }),
      resolution,
      nowMs: Date.parse(ts),
    });
    expect(item).toBeDefined();
    expect(item!.kind).toBe('declared');
    expect(item!.key).toBe(`zion/sess-cloud/${ts}`);
    expect(item!.sourceCursor?.lastActivityMs).toBe(Date.parse(ts));
  });

  it('an open block whose generation was already resolved cannot resurrect', () => {
    // The write-ordering window the plan names: the tombstone is appended BEFORE
    // the open-block view is cleared, so a still-'open' block of the resolved
    // generation must stay suppressed.
    const block = openQuestionBlock({ generation: 'gen-1', state: 'open', sourceCursor: { lastActivityMs: 3000 } });
    const resolution: AttentionResolution = {
      blockId: block.blockId,
      generation: 'gen-1',
      resolvedAt: '2026-08-23T10:05:00.000Z',
      sourceCursor: { lastActivityMs: 3000 },
      reason: 'answered',
    };
    const item = reconcileAttention({
      block,
      session: session({ sessionId: 'sess-1', activity: 'working', lastActivityMs: 3000 }),
      resolution,
      nowMs: 10_000,
    });
    expect(item).toBeUndefined();
  });

  it('reply capability is derived from the session context / host', () => {
    const q = { text: 'x', reason: 'question' as const, options: [{ label: 'A' }] };
    const base = { activity: 'waiting_input' as const, awaitingReason: 'question' as const, question: q, lastActivityMs: 1 };
    expect(reconcileAttention({ session: session({ sessionId: 'a', context: 'cloud', ...base }), nowMs: 9 })!.replyCapability).toBe('cloud');
    expect(reconcileAttention({ session: session({ sessionId: 'b', context: 'teams', ...base }), nowMs: 9 })!.replyCapability).toBe('team');
    expect(reconcileAttention({ session: session({ sessionId: 'c', host: 'tmux', ...base }), nowMs: 9 })!.replyCapability).toBe('tmux');
    expect(reconcileAttention({ session: session({ sessionId: 'd', context: 'headless', host: 'code', ...base }), nowMs: 9 })!.replyCapability).toBe('none');
  });

  it('a CLI-supplied PR signal raises a review item when a human is needed', () => {
    const pr: PullRequestAttentionSignal = { number: 2954, title: 'feed needs-you', needsHuman: true, reviewDecision: 'REVIEW_REQUIRED' };
    const item = reconcileAttention({
      session: session({ sessionId: 'sess-pr', activity: 'idle', lastActivityMs: 4000 }),
      pullRequest: pr,
      nowMs: 10_000,
    });
    expect(item).toBeDefined();
    expect(item!.kind).toBe('review');
    expect(item!.source).toBe('system');
    expect(item!.question?.text).toContain('#2954');
  });

  it('a PR that needs no human raises nothing', () => {
    const pr: PullRequestAttentionSignal = { number: 1, needsHuman: false };
    const item = reconcileAttention({
      session: session({ sessionId: 'sess-pr2', activity: 'idle', lastActivityMs: 4000 }),
      pullRequest: pr,
      nowMs: 10_000,
    });
    expect(item).toBeUndefined();
  });
});

describe('attentionFingerprint', () => {
  it('clusters identical asks and separates different ones', () => {
    const a = attentionFingerprint('question', { text: 'Publish now?', options: [{ label: 'yes' }, { label: 'no' }] });
    const b = attentionFingerprint('question', { text: 'Publish now?', options: [{ label: 'yes' }, { label: 'no' }] });
    const c = attentionFingerprint('question', { text: 'Different ask?' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('feed lifecycle emission (real store, no mocking)', () => {
  it('answer advances the block to answered and writes an answered tombstone that suppresses a stale re-read', () => {
    const dir = tmpFeedDir();
    const block = buildDeclaredBlock(
      { sessionId: 'live-1', mailboxId: 'mbx', host: 'zion', runtime: 'claude' },
      { text: 'Publish the release?', safeDefault: 'wait' },
    );
    publishBlock(block, dir);
    const blockId = blockIdForSession('live-1');

    expect(deriveBlockState(readBlock(blockId, dir)!)).toBe('open');

    const res = recordAnswer(blockId, { answeredFrom: 'feed', answeredBy: 'operator' }, dir);
    expect(res).toEqual({ ok: true });

    const answered = readBlock(blockId, dir)!;
    expect(deriveBlockState(answered)).toBe('answered');

    const tombstone = readResolution(blockId, dir);
    expect(tombstone?.reason).toBe('answered');
    expect(tombstone?.generation).toBe(block.generation);

    // The session engine still momentarily reports waiting_input on a stale cursor:
    // the answered block is no longer open, and the tombstone suppresses the
    // lifecycle fallback, so nothing needs a human.
    const item = reconcileAttention({
      block: answered,
      session: session({
        sessionId: 'live-1',
        activity: 'waiting_input',
        awaitingReason: 'question',
        question: { text: 'Publish the release?', reason: 'question' },
        lastActivityMs: 1000,
      }),
      resolution: tombstone,
      nowMs: 10_000,
    });
    expect(item).toBeUndefined();
  });

  it('continued advances the block to continued and writes a continued tombstone', () => {
    const dir = tmpFeedDir();
    const block = buildDeclaredBlock(
      { sessionId: 'live-2', mailboxId: 'mbx', host: 'zion', runtime: 'claude' },
      { text: 'Merge it?' },
    );
    publishBlock(block, dir);
    const blockId = blockIdForSession('live-2');

    recordAnswer(blockId, { answeredFrom: 'terminal' }, dir);
    recordContinued(blockId, dir);

    expect(deriveBlockState(readBlock(blockId, dir)!)).toBe('continued');
    expect(readResolution(blockId, dir)?.reason).toBe('continued');
  });

  it('clearing an unanswered open block records a session_advanced tombstone before removal', () => {
    const dir = tmpFeedDir();
    const block = buildDeclaredBlock(
      { sessionId: 'live-3', mailboxId: 'mbx', host: 'zion', runtime: 'claude' },
      { text: 'Still stuck?' },
    );
    publishBlock(block, dir);
    const blockId = blockIdForSession('live-3');

    expect(removeBlock(blockId, dir)).toBe(true);
    expect(readBlock(blockId, dir)).toBeUndefined();
    // The tombstone survives the removal — that is what prevents resurrection.
    expect(readResolution(blockId, dir)?.reason).toBe('session_advanced');
  });
});
