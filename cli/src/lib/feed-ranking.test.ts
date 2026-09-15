import { describe, expect, it } from 'vitest';
import type { OpenBlock, FeedAskStats } from './feed/feed.js';
import {
  buildSessionSignals,
  needyControlCards,
  rankFeedBlocks,
  runawayControlCards,
} from './feed-ranking.js';
import type { ActiveSession } from './session/active.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

function block(id: string, ts: string, extra?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: `block-${id}`,
    sessionId: id,
    mailboxId: id,
    host: 'zion',
    runtime: 'headless',
    ts,
    questions: [{ text: 'Which approach should we take?' }],
    ...extra,
  };
}

describe('rankFeedBlocks', () => {
  it('puts a costly 40-minute critical-path block above a fresh cheap block', () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const ranked = rankFeedBlocks(
      [
        block('fresh-cheap', '2026-07-21T11:59:00.000Z', { costOfDelay: 'low' }),
        block('old-critical', '2026-07-21T11:20:00.000Z', { downstreamAgents: 4 }),
      ],
      [
        { sessionId: 'fresh-cheap', mailboxId: 'fresh-cheap', costUsd: 0.10, durationMs: 60 * 60_000 },
        { sessionId: 'old-critical', mailboxId: 'old-critical', costUsd: 48, durationMs: 60 * 60_000 },
      ],
      now,
    );

    expect(ranked.map((b) => b.sessionId)).toEqual(['old-critical', 'fresh-cheap']);
    expect(ranked[0].delayRank.score).toBeGreaterThan(ranked[1].delayRank.score);
    expect(ranked[0].delayRank).toMatchObject({
      idleMinutes: 40,
      blastRadius: 4,
      burnUsdPerHour: 48,
      decisionIrreducibility: 1,
    });
  });

  it('sinks suppressible stalls to zero irreducibility', () => {
    const ranked = rankFeedBlocks(
      [block('stall', '2026-07-21T11:00:00.000Z', { questions: [{ text: 'Should I continue?' }] })],
      [{ sessionId: 'stall', mailboxId: 'stall', costUsd: 100, durationMs: 60 * 60_000 }],
      new Date('2026-07-21T12:00:00.000Z'),
    );

    expect(ranked[0].delayRank.decisionIrreducibility).toBe(0);
    expect(ranked[0].delayRank.score).toBe(0);
  });

  it('preserves peer-provided burn and irreducibility when local signals are absent', () => {
    const ranked = rankFeedBlocks(
      [block('remote', '2026-07-21T11:30:00.000Z', {
        delayRank: {
          score: 0,
          idleMinutes: 0,
          blastRadius: 1,
          burnUsdPerHour: 48,
          decisionIrreducibility: 1,
        },
      })],
      [],
      new Date('2026-07-21T12:00:00.000Z'),
    );

    expect(ranked[0].delayRank.burnUsdPerHour).toBe(48);
    expect(ranked[0].delayRank.score).toBe(1440);
  });
});

describe('control card detection', () => {
  it('flags token and dollar runaways without requiring an open ask', () => {
    const cards = runawayControlCards([
      { sessionId: 'silent', mailboxId: 'silent', host: 'zion', runtime: 'terminal', tokPerSec: 300 },
      { sessionId: 'costly', mailboxId: 'costly', host: 'zion', runtime: 'headless', costUsd: 48, durationMs: 60 * 60_000 },
    ], new Date('2026-07-21T12:00:00.000Z'));

    expect(cards.map((c) => c.mailboxId)).toEqual(['silent', 'costly']);
    expect(cards[0].kind).toBe('control');
    expect(cards[0].runaway?.reason).toContain('300 tok/s');
    expect(cards[1].runaway?.reason).toContain('$48.00/hr');
  });

  it('flags tight relaunch loops by cwd and agent kind', () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const cards = runawayControlCards([
      { sessionId: 'a', mailboxId: 'a', kind: 'claude', cwd: '/repo', startedAtMs: now.getTime() - 60_000 },
      { sessionId: 'b', mailboxId: 'b', kind: 'claude', cwd: '/repo', startedAtMs: now.getTime() - 2 * 60_000 },
      { sessionId: 'c', mailboxId: 'c', kind: 'claude', cwd: '/repo', startedAtMs: now.getTime() - 3 * 60_000 },
    ], now);

    expect(cards).toHaveLength(3);
    expect(cards[0].runaway?.relaunchesPerTenMinutes).toBe(3);
  });

  it('emits one needy card per session once the rolling ask threshold is crossed', () => {
    const stats: FeedAskStats = {
      sessionId: 'needy-session',
      mailboxId: 'needy-agent',
      firstAskAt: '2026-07-21T11:00:00.000Z',
      lastAskAt: '2026-07-21T11:55:00.000Z',
      totalAskCount: 21,
      recentAskTimestamps: [
        '2026-07-21T11:10:00.000Z',
        '2026-07-21T11:20:00.000Z',
        '2026-07-21T11:30:00.000Z',
        '2026-07-21T11:40:00.000Z',
        '2026-07-21T11:50:00.000Z',
        '2026-07-21T11:55:00.000Z',
      ],
    };

    const cards = needyControlCards([stats], [], new Date('2026-07-21T12:00:00.000Z'));
    expect(cards).toHaveLength(1);
    expect(cards[0].blockId).toBe('control-needy-needy-session');
    expect(cards[0].needy).toMatchObject({ askCountLastHour: 6, threshold: 6, totalAskCount: 21 });
  });

  it('joins active sessions to stored cost metadata for dollar burn ranking', () => {
    const active: ActiveSession[] = [{
      context: 'headless',
      kind: 'claude',
      sessionId: 'sess-cost',
      status: 'running',
    }];
    const metas: SessionMeta[] = [{
      id: 'sess-cost',
      shortId: 'sess-cos',
      agent: 'claude',
      timestamp: '2026-07-21T11:00:00.000Z',
      filePath: '/tmp/sess-cost.jsonl',
      costUsd: 12,
      durationMs: 30 * 60_000,
    }];

    expect(buildSessionSignals(active, metas)[0]).toMatchObject({
      sessionId: 'sess-cost',
      costUsd: 12,
      durationMs: 30 * 60_000,
    });
  });
});
