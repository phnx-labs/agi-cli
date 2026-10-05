import { describe, expect, it } from 'vitest';
import { blockIdForSession, type OpenBlock } from './feed/feed.js';
import {
  deriveOutcome,
  enrichBlockFromSession,
  enrichBlocksFromSessions,
  groupBlocksByOutcome,
  isUnambiguousOutcomeAnswer,
  normalizePrRef,
  normalizeTicketRef,
  openBlocksForOutcome,
  outcomeForBlock,
  stampBlockOutcomes,
} from './feed-outcome.js';

function makeBlock(sessionId: string, opts?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'zion',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{ text: opts?.questions?.[0]?.text ?? 'Which approach?' }],
    ...opts,
  };
}

describe('normalizeTicketRef / normalizePrRef', () => {
  it('uppercases a ticket id', () => {
    expect(normalizeTicketRef('rush-1125')).toBe('RUSH-1125');
    expect(normalizeTicketRef('  ENG-42 ')).toBe('ENG-42');
  });

  it('returns undefined for empty / non-ticket strings', () => {
    expect(normalizeTicketRef('')).toBeUndefined();
    expect(normalizeTicketRef('just prose')).toBeUndefined();
  });

  it('normalizes PR urls and shorthand to #N', () => {
    expect(normalizePrRef('#534')).toBe('#534');
    expect(normalizePrRef('PR#534')).toBe('#534');
    expect(normalizePrRef('pr 534')).toBe('#534');
    expect(normalizePrRef('https://github.com/phnx-labs/agents-cli/pull/534')).toBe('phnx-labs/agents-cli#534');
  });
});

describe('deriveOutcome', () => {
  it('prefers ticket over PR over worktree over unassigned', () => {
    expect(deriveOutcome({
      ticket: 'RUSH-1125',
      pr: '#534',
      worktreeSlug: 'rush-1125-fix',
    })).toEqual({ key: 'ticket:RUSH-1125', kind: 'ticket', label: 'RUSH-1125' });

    expect(deriveOutcome({ pr: '#534', worktreeSlug: 'x' })).toEqual({
      key: 'pr:#534',
      kind: 'pr',
      label: 'PR#534',
    });

    expect(deriveOutcome({ worktreeSlug: 'headless-secrets' })).toEqual({
      key: 'worktree:headless-secrets',
      kind: 'worktree',
      label: 'headless-secrets',
    });

    expect(deriveOutcome({ epic: 'Agent Feed' })).toEqual({
      key: 'epic:Agent Feed',
      kind: 'worktree',
      label: 'Agent Feed',
    });

    expect(deriveOutcome({})).toEqual({
      key: 'unassigned',
      kind: 'unassigned',
      label: 'Unassigned',
    });
  });

  it('extracts a ticket from free text or a branch slug', () => {
    expect(deriveOutcome({ text: 'land RUSH-489 before ship' }).label).toBe('RUSH-489');
    expect(deriveOutcome({ branch: 'muqsit/rush-1125-scope' }).label).toBe('RUSH-1125');
  });

  it('extracts a PR from free text', () => {
    expect(deriveOutcome({ text: 'merge #534?' }).label).toBe('PR#534');
    expect(deriveOutcome({
      text: 'see https://github.com/phnx-labs/agents-cli/pull/999',
    })).toEqual({
      key: 'pr:phnx-labs/agents-cli#999',
      kind: 'pr',
      label: 'PR phnx-labs/agents-cli#999',
    });
  });

  it('keys PR outcomes by owner/repo when URL is known (RUSH-1630)', () => {
    const a = deriveOutcome({ pr: 'https://github.com/phnx-labs/agents-cli/pull/10' });
    const b = deriveOutcome({ pr: 'https://github.com/other/repo/pull/10' });
    expect(a.key).toBe('pr:phnx-labs/agents-cli#10');
    expect(b.key).toBe('pr:other/repo#10');
    expect(a.key).not.toBe(b.key);
  });
});

describe('outcomeForBlock + groupBlocksByOutcome', () => {
  it('attributes each block to exactly one outcome', () => {
    const blocks = [
      makeBlock('a', { ticket: 'RUSH-1125' }),
      makeBlock('b', { ticket: 'RUSH-1125', questions: [{ text: 'other?' }] }),
      makeBlock('c', { pr: '#534' }),
      makeBlock('d', { worktreeSlug: 'ship-1-20-29' }),
      makeBlock('e'),
    ];
    const groups = groupBlocksByOutcome(blocks);
    const keys = groups.map((g) => g.outcome.key);
    expect(keys).toContain('ticket:RUSH-1125');
    expect(keys).toContain('pr:#534');
    expect(keys).toContain('worktree:ship-1-20-29');
    expect(keys).toContain('unassigned');
    expect(groups.reduce((n, g) => n + g.blocks.length, 0)).toBe(blocks.length);
    const rush = groups.find((g) => g.outcome.key === 'ticket:RUSH-1125')!;
    expect(rush.counts.agents).toBe(2);
    expect(rush.counts.open).toBe(2);
  });

  it('orders needs-you outcomes first and Unassigned last', () => {
    const blocks = [
      makeBlock('orphan'),
      makeBlock('done-a', { ticket: 'RUSH-1', answer: { answeredAt: 't', answeredFrom: 'cli' } }),
      makeBlock('open-b', { ticket: 'RUSH-2' }),
      makeBlock('open-c', { ticket: 'RUSH-2' }),
    ];
    const groups = groupBlocksByOutcome(blocks);
    expect(groups[0].outcome.label).toBe('RUSH-2');
    expect(groups[0].counts.open).toBe(2);
    expect(groups[groups.length - 1].outcome.kind).toBe('unassigned');
  });

  it('reads ticket/PR out of the question text when fields are empty', () => {
    const block = makeBlock('q', {
      questions: [{ header: 'Scope', text: 'Is RUSH-1125 still in scope?' }],
    });
    expect(outcomeForBlock(block).label).toBe('RUSH-1125');
  });

  it('counts answered / parked / open distinctly', () => {
    const blocks = [
      makeBlock('o', { ticket: 'RUSH-9' }),
      makeBlock('a', { ticket: 'RUSH-9', answer: { answeredAt: 't', answeredFrom: 'feed' } }),
      makeBlock('p', { ticket: 'RUSH-9', parkedAt: 't' }),
    ];
    const g = groupBlocksByOutcome(blocks)[0];
    expect(g.counts).toEqual({ agents: 3, open: 1, answered: 1, parked: 1 });
  });
});

describe('stampBlockOutcomes', () => {
  it('adds outcome without mutating the source', () => {
    const block = makeBlock('s', { ticket: 'RUSH-1' });
    const stamped = stampBlockOutcomes([block]);
    expect(stamped[0].outcome.label).toBe('RUSH-1');
    expect((block as OpenBlock & { outcome?: unknown }).outcome).toBeUndefined();
  });
});

describe('enrichBlockFromSession', () => {
  it('fills missing project from session meta, never overwrites', () => {
    const bare = makeBlock('s-project');
    const filled = enrichBlockFromSession(bare, { project: 'agents-cli' });
    expect(filled.project).toBe('agents-cli');

    const kept = enrichBlockFromSession(makeBlock('s-project-keep', { project: 'factory' }), { project: 'agents-cli' });
    expect(kept.project).toBe('factory');
  });

  it('fills missing ticket/PR/worktree from session meta, never overwrites', () => {
    const bare = makeBlock('s1');
    const filled = enrichBlockFromSession(bare, {
      ticketId: 'RUSH-10',
      prNumber: 42,
      worktreeSlug: 'rush-10-fix',
    });
    expect(filled.ticket).toBe('RUSH-10');
    expect(filled.pr).toBe('#42');
    expect(filled.worktreeSlug).toBe('rush-10-fix');

    const kept = enrichBlockFromSession(
      makeBlock('s2', { ticket: 'RUSH-KEEP', pr: '#1', worktreeSlug: 'keep' }),
      { ticketId: 'RUSH-OTHER', prNumber: 99, worktreeSlug: 'other' },
    );
    expect(kept.ticket).toBe('RUSH-KEEP');
    expect(kept.pr).toBe('#1');
    expect(kept.worktreeSlug).toBe('keep');
  });

  it('matches sessions by mailbox id then session id', () => {
    const blocks = [
      makeBlock('sess-a', { mailboxId: 'box-a' }),
      makeBlock('sess-b'),
    ];
    const enriched = enrichBlocksFromSessions(blocks, [
      { mailboxId: 'box-a', ticketId: 'RUSH-A' },
      { sessionId: 'sess-b', ticketId: 'RUSH-B' },
    ]);
    expect(enriched[0].ticket).toBe('RUSH-A');
    expect(enriched[1].ticket).toBe('RUSH-B');
  });
});

describe('unambiguous outcome answer', () => {
  it('is true for a single open block or identical questions', () => {
    const single = groupBlocksByOutcome([makeBlock('a', { ticket: 'RUSH-1' })])[0];
    expect(isUnambiguousOutcomeAnswer(single)).toBe(true);
    expect(openBlocksForOutcome(single)).toHaveLength(1);

    const same = groupBlocksByOutcome([
      makeBlock('a', { ticket: 'RUSH-1', questions: [{ text: 'Ship it?' }] }),
      makeBlock('b', { ticket: 'RUSH-1', questions: [{ text: 'Ship it?' }] }),
    ])[0];
    expect(isUnambiguousOutcomeAnswer(same)).toBe(true);

    const mixed = groupBlocksByOutcome([
      makeBlock('a', { ticket: 'RUSH-1', questions: [{ text: 'Ship it?' }] }),
      makeBlock('b', { ticket: 'RUSH-1', questions: [{ text: 'Abort?' }] }),
    ])[0];
    expect(isUnambiguousOutcomeAnswer(mixed)).toBe(false);
  });

  it('ignores already-answered blocks when judging fan-out safety', () => {
    const g = groupBlocksByOutcome([
      makeBlock('a', { ticket: 'RUSH-1', questions: [{ text: 'Ship?' }] }),
      makeBlock('b', {
        ticket: 'RUSH-1',
        questions: [{ text: 'Different' }],
        answer: { answeredAt: 't', answeredFrom: 'cli' },
      }),
    ])[0];
    expect(isUnambiguousOutcomeAnswer(g)).toBe(true);
  });
});
