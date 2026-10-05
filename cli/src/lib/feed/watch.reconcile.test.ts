import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-watch-reconcile-'));
process.env.HOME = TEST_HOME;

import { afterAll, describe, expect, it } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import { getActivityDir, getFeedDir } from '../state.js';
import { appendActivityEvent } from './activity.js';
import { watchLocalFeed, type FeedWatchEnvelope } from './watch.js';
import { resetPullRequestStatusCache } from './pr-status.js';

afterAll(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const liveSession = (sessionId: string): ActiveSession => ({
  context: 'terminal', kind: 'claude', sessionId, status: 'running', cwd: TEST_HOME, lastActivityMs: 10,
});

interface Harness {
  events: FeedWatchEnvelope[];
  stop: () => Promise<void>;
}

function start(options: {
  reconcileMs: number; sessionId?: string; withFeedDir?: boolean;
  pr?: { url: string; number: number };
  gh?: (args: string[]) => Promise<string>;
}): Harness {
  fs.mkdirSync(getActivityDir(), { recursive: true });
  if (options.withFeedDir !== false) fs.mkdirSync(getFeedDir(), { recursive: true });
  const events: FeedWatchEnvelope[] = [];
  const controller = new AbortController();
  const journalPath = path.join(TEST_HOME, `journal-${Math.random().toString(36).slice(2)}.jsonl`);
  const sessions = options.sessionId ? [{ ...liveSession(options.sessionId), ...(options.pr ? { pr: options.pr } : {}) }] : [];
  const watching = watchLocalFeed({
    scope: 'test-box',
    signal: controller.signal,
    emit: (event) => events.push(event),
    activityPollMs: 25,
    reconcileMs: options.reconcileMs,
    gh: options.gh,
    sessions: {
      journalPath,
      journalPollMs: 10,
      heartbeatMs: 60_000,
      readCache: () => ({ version: 1, scope: 'test-box', capturedAt: 1, sessions }),
      readPrevious: () => [],
    },
  });
  return { events, stop: async () => { controller.abort(); await watching; } };
}

function writeBlock(sessionId: string): void {
  fs.writeFileSync(path.join(getFeedDir(), `block-${sessionId}.json`), JSON.stringify({
    blockId: `block-${sessionId}`,
    sessionId,
    generation: 1,
    createdAt: new Date().toISOString(),
    questions: [{ text: 'Approve the plan?', reason: 'plan_review' }],
  }));
}

describe('feed watch reconcile cadence', () => {
  it('drains appended activity every tick without reconciling attention on any of them', async () => {
    const harness = start({ reconcileMs: 3_600_000, sessionId: 'live-quiet' });
    await settle(80);
    appendActivityEvent({ sessionId: 'live-quiet', event: 'status.posted', ts: new Date().toISOString(), detail: 'first' });
    await settle(120);
    appendActivityEvent({ sessionId: 'live-quiet', event: 'status.posted', ts: new Date().toISOString(), detail: 'second' });
    await settle(200);
    await harness.stop();

    const appended = harness.events.filter((event) => event.type === 'activity.append');
    expect(appended.map((event) => (event as Extract<FeedWatchEnvelope, { type: 'activity.append' }>).event.detail))
      .toEqual(['first', 'second']);
    expect(harness.events.filter((event) => event.type === 'attention.upsert' || event.type === 'attention.remove')).toEqual([]);
  });

  it('reconciles a row as soon as a block is written, without waiting for the PR-status cadence', async () => {
    const harness = start({ reconcileMs: 3_600_000, sessionId: 'live-blocked' });
    await settle(120);
    const beforeBlock = harness.events.length;
    writeBlock('live-blocked');
    await settle(300);
    await harness.stop();

    const raised = harness.events.slice(beforeBlock).filter((event) => event.type === 'attention.upsert');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: 'attention.upsert', attention: { kind: 'question', sessionId: 'live-blocked' } });
  });

  it('reconciles on the timed cadence when no directory watcher could arm', async () => {
    // Start with no feed dir, as on a box that never posted: `watchAttentionStores` has nothing to
    // subscribe to, so the timed pass is the only path left. It must exist, since a PR verdict also
    // changes with no local file write.
    fs.rmSync(getFeedDir(), { recursive: true, force: true });
    const harness = start({ reconcileMs: 50, sessionId: 'live-timed', withFeedDir: false });
    await settle(80);
    fs.mkdirSync(getFeedDir(), { recursive: true });
    writeBlock('live-timed');
    await settle(300);
    await harness.stop();

    const raised = harness.events.filter((event) => event.type === 'attention.upsert');
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ attention: { kind: 'question', sessionId: 'live-timed' } });
  });
});

describe('feed watch PR status on agent rows', () => {
  const prView = (state: string, rollup: unknown[]) => JSON.stringify({
    number: 7, state, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', statusCheckRollup: rollup,
  });

  it('projects the fetched status onto the row and re-emits the row only when it changes', async () => {
    resetPullRequestStatusCache();
    let response = prView('OPEN', [{ status: 'IN_PROGRESS' }]);
    let calls = 0;
    const gh = async (args: string[]) => {
      calls += 1;
      expect(args.slice(0, 3)).toEqual(['pr', 'view', 'https://github.com/o/r/pull/7']);
      return response;
    };
    const harness = start({ reconcileMs: 30, sessionId: 'live-pr', pr: { url: 'https://github.com/o/r/pull/7', number: 7 }, gh });
    await settle(150);
    const reset = harness.events.find((event) => event.type === 'reset');
    expect(reset && reset.type === 'reset' ? reset.agents[0]?.pr : undefined).toEqual({
      url: 'https://github.com/o/r/pull/7', number: 7,
      state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', checks: 'pending',
    });
    const upsertsBefore = harness.events.filter((event) => event.type === 'agent.upsert').length;

    await settle(150);
    expect(harness.events.filter((event) => event.type === 'agent.upsert').length).toBe(upsertsBefore);

    response = prView('MERGED', [{ conclusion: 'SUCCESS' }]);
    resetPullRequestStatusCache();
    await settle(200);
    await harness.stop();
    const upserts = harness.events.filter((event) => event.type === 'agent.upsert');
    expect(upserts.length).toBe(upsertsBefore + 1);
    const last = upserts[upserts.length - 1];
    expect(last.type === 'agent.upsert' ? last.agent.pr : undefined).toMatchObject({ state: 'MERGED', checks: 'passing' });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
