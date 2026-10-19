import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AttentionNotifyService, buildAttentionNotification, dueStage, notifyScope, type AttentionAsk } from './attention-notify-service.js';
import { DEFAULT_NOTIFY_SCHEDULES, parseNotifySchedule, type NotifySchedule } from '../feed/notify-schedule.js';
import { buildMenubarNotifyArgs } from '../menubar/notify-desktop.js';
import { FeedHub } from '../feed/hub.js';
import { FeedWatchState, type FeedWatchEnvelope } from '../feed/envelope.js';
import { blockIdForSession, publishBlock } from '../feed/feed.js';
import type { AttentionItem } from '../feed/attention.js';
import type { ActiveSession } from '../session/active.js';
import type { SessionWatchRow } from '../session/watch.js';
import type { DaemonContext } from './service.js';
import type { DesktopNotification } from '../menubar/notify-desktop.js';

const ctx: DaemonContext = { log: () => {} };

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
    urgency: 'normal',
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

  it('a request the CLI could not verify offers only Open terminal — never an approval button (PHNX-3999)', () => {
    const n = buildAttentionNotification({ ...base, kind: 'unverified', choices: undefined, question: { text: 'Claude needs your permission to use Bash' } }, session({}));
    expect(n!.category).toBe('failure');
    expect(n!.title).toBe('sess-1 · Could not verify request');
    expect(n!.body).toBe('Claude needs your permission to use Bash');
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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {  }
  });

  function makeService() {
    const feedRoot = path.join(tmp, 'feed');
    publishBlock({
      blockId: blockIdForSession('sess-perm'), sessionId: 'sess-perm', mailboxId: 'sess-perm', host: 'zion', runtime: 'claude',
      ts: '1970-01-01T00:00:05.000Z', sourceCursor: { lastActivityMs: 5_000 },
      kind: 'notification', notificationType: 'permission_prompt', questions: [{ text: 'Approve running the release?' }],
    }, feedRoot);
    const waiting = session({ sessionId: 'sess-perm', activity: 'working', pidAlive: true, lastEventMs: 4_000, lastActivityMs: 5_100 });
    return new AttentionNotifyService({
      getSessions: async () => [waiting],
      notify: (n) => posts.push(n),
      feedRoot: path.join(tmp, 'feed'),
      ledgerDir: path.join(tmp, 'notified'),
      now: () => 1_000_000,
      gc: () => {},
    });
  }

  it('posts exactly one banner per key across two ticks, and writes a ledger sidecar', async () => {
    const service = makeService();
    const signal = new AbortController().signal;
    await service.tick(ctx, signal);
    await service.tick(ctx, signal);

    expect(posts).toHaveLength(1);
    expect(posts[0].category).toBe('permission');
    expect(posts[0].key).toContain('/sess-perm/');
    expect(posts[0].choices?.map((c) => c.id)).toEqual(['approve', 'approve-session', 'deny']);

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
    await makeService().tick(ctx, signal);
    expect(posts).toHaveLength(1);
  });
});

describe('AttentionNotifyService — per-urgency schedule, reminders and withdraw (PHNX-4369)', () => {
  let tmp: string;
  let posts: DesktopNotification[];
  let withdrawn: string[][];
  let clock: number;
  let hub: FeedHub;
  let emit: ((event: FeedWatchEnvelope) => void) | undefined;
  const wire = new FeedWatchState();

  const OPENED = Date.parse('2026-10-13T08:00:00.000Z');
  const MIN = 60_000;
  const DEFAULTS = () => ({
    urgent: parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES.urgent) as NotifySchedule,
    high: parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES.high) as NotifySchedule,
    normal: parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES.normal) as NotifySchedule,
    low: parseNotifySchedule(DEFAULT_NOTIFY_SCHEDULES.low) as NotifySchedule,
  });

  function ask(urgency: AttentionItem['urgency'], id = 'sess-1'): AttentionAsk {
    return {
      item: {
        key: `yosemite-m6/${id}/t1`, sessionId: id, mailboxId: id, host: 'yosemite-m6', project: 'agents-cli',
        kind: 'permission', source: 'hook', state: 'open', openedAt: new Date(OPENED).toISOString(),
        question: { text: 'Claude needs approval to run Bash: npm publish' },
        choices: [{ id: 'approve', label: 'Approve' }, { id: 'deny', label: 'Deny' }],
        replyCapability: 'terminal', fingerprint: 'f', urgency,
      },
      session: { label: 'release', kind: 'claude' },
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-sched-'));
    posts = [];
    withdrawn = [];
    clock = OPENED;
    emit = undefined;
    hub = new FeedHub({ watch: async (o) => { emit = o.emit; await new Promise((r) => o.signal.addEventListener('abort', r)); } });
  });
  afterEach(async () => {
    await hub.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {  }
  });

  async function attached() {
    const detach = hub.subscribe(() => {});
    for (let i = 0; i < 5 && !emit; i++) await new Promise((r) => setTimeout(r, 0));
    return detach;
  }

  async function setAsks(list: AttentionAsk[], scope = 'yosemite-m6') {
    if (!emit) await attached();
    emit!(wire.emit({ type: 'reset', scope, capturedAt: clock, agents: [], attention: list.map((a) => a.item), tools: [], setup: [] }));
  }

  function makeService(interactiveHost: string | undefined = 'zion') {
    return new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ interactiveHost, schedules: DEFAULTS() }),
      fleetHub: () => hub,
      getSessions: async () => [],
      notify: (n) => posts.push(n),
      withdraw: (keys) => withdrawn.push(keys),
      gc: () => {},
      ledgerDir: path.join(tmp, 'notified'),
      now: () => clock,
    });
  }

  async function at(service: AttentionNotifyService, minutes: number) {
    clock = OPENED + minutes * MIN;
    await service.tick(ctx, new AbortController().signal);
  }

  it('urgent: banner at 0 with --level urgent and sound, reminders at 15 and 30 min, withdraw on resolve', async () => {
    await setAsks([ask('urgent')]);
    const service = makeService();
    await at(service, 0);
    await at(service, 1);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ level: 'urgent', sound: true, key: 'yosemite-m6/sess-1/t1', subtitle: 'yosemite-m6 · agents-cli' });
    expect(posts[0].reminder).toBeUndefined();
    expect(buildMenubarNotifyArgs(posts[0])).toEqual(expect.arrayContaining(['--level', 'urgent', '--sound']));

    await at(service, 15);
    await at(service, 16);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ reminder: 1, key: 'yosemite-m6/sess-1/t1', subtitle: 'yosemite-m6 · agents-cli · Still waiting · 15 min' });

    await at(service, 30);
    expect(posts).toHaveLength(3);
    expect(posts[2]).toMatchObject({ reminder: 2, subtitle: 'yosemite-m6 · agents-cli · Still waiting · 30 min' });
    expect(withdrawn).toEqual([]);

    await setAsks([]);
    await at(service, 31);
    expect(withdrawn).toEqual([['yosemite-m6/sess-1/t1']]);
    await at(service, 32);
    expect(withdrawn).toHaveLength(1);
  });

  it('a restarted daemon re-sends nothing already sent and still withdraws the live banner', async () => {
    await setAsks([ask('urgent')]);
    await at(makeService(), 15);
    expect(posts.map((p) => p.reminder)).toEqual([1]);
    const restarted = makeService();
    await at(restarted, 20);
    expect(posts).toHaveLength(1);
    await setAsks([]);
    await at(restarted, 21);
    expect(withdrawn).toEqual([['yosemite-m6/sess-1/t1']]);
  });

  it('normal: first banner at 5 min with no sound, withdrawn about 10 s later because the level has no stay', async () => {
    await setAsks([ask('normal')]);
    const service = makeService();
    await at(service, 4);
    expect(posts).toHaveLength(0);
    await at(service, 5);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ level: 'normal' });
    expect(posts[0].sound).toBeUndefined();
    clock += 5_000;
    await service.tick(ctx, new AbortController().signal);
    expect(withdrawn).toEqual([]);
    clock += 5_000;
    await service.tick(ctx, new AbortController().signal);
    expect(withdrawn).toEqual([['yosemite-m6/sess-1/t1']]);
    await setAsks([]);
    await at(service, 7);
    expect(withdrawn).toHaveLength(1);
  });

  it('sidebar level posts nothing at any time', async () => {
    await setAsks([ask('low')]);
    const service = makeService();
    for (const m of [0, 5, 60, 600]) await at(service, m);
    expect(posts).toEqual([]);
    expect(withdrawn).toEqual([]);
  });

  it('interactive.host set to another machine: this host posts nothing', async () => {
    await setAsks([ask('urgent')]);
    const service = makeService('yosemite-s1');
    await at(service, 0);
    await at(service, 30);
    expect(posts).toEqual([]);
  });

  it('a late daemon posts only the latest due stage, as that reminder', async () => {
    await setAsks([ask('urgent')]);
    await at(makeService(), 40);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ reminder: 2, subtitle: 'yosemite-m6 · agents-cli · Still waiting · 40 min' });
  });

  it('a peer that has only reported unavailable does not count as resolved, so its banner stays up', async () => {
    await setAsks([ask('urgent')]);
    await at(makeService(), 0);
    expect(posts).toHaveLength(1);
    const restartedHub = new FeedHub({ watch: async (o) => {
      o.emit(wire.emit({ type: 'scope', scope: 'yosemite-m6', capturedAt: clock, status: 'unavailable', reason: 'ssh: timed out' }));
      await new Promise((r) => o.signal.addEventListener('abort', r));
    } });
    const restarted = new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ interactiveHost: 'zion', schedules: DEFAULTS() }),
      fleetHub: () => restartedHub,
      notify: (n) => posts.push(n), withdraw: (keys) => withdrawn.push(keys), gc: () => {},
      ledgerDir: path.join(tmp, 'notified'), now: () => clock,
    });
    await at(restarted, 1);
    await at(restarted, 2);
    expect(restartedHub.state.scopeNames).toContain('yosemite-m6');
    expect(withdrawn).toEqual([]);
    await restartedHub.close();
  });

  it('posts a done banner for another device\'s finished turn from the fleet hub, never for a previous row', async () => {
    const service = new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ interactiveHost: 'zion', schedules: { ...DEFAULTS(), low: parseNotifySchedule(['0m']) as NotifySchedule } }),
      fleetHub: () => hub, getSessions: async () => [], notify: (n) => posts.push(n), withdraw: (keys) => withdrawn.push(keys),
      gc: () => {}, ledgerDir: path.join(tmp, 'notified'), now: () => clock,
    });
    const agent = (status: string, previous = false) => ({
      rowKey: previous ? 'old' : 'r1', sourceDevice: 'yosemite-m6', sessionId: previous ? 'sess-old' : 'sess-9', kind: 'claude',
      context: 'terminal', status, previous, title: previous ? 'Old run' : 'Port the parser',
      doneVerdict: { state: 'done', gaps: [], at: new Date(OPENED + 4 * MIN).toISOString() },
    }) as unknown as SessionWatchRow;
    const rows = async (status: string) => {
      if (!emit) await attached();
      emit!(wire.emit({ type: 'reset', scope: 'yosemite-m6', capturedAt: clock, agents: [agent(status), agent(status, true)], attention: [], tools: [], setup: [] }));
    };
    await rows('running'); await at(service, 0);
    await rows('idle'); await at(service, 5);
    await at(service, 6);
    expect(posts.map((n) => [n.title, n.sessionId, n.key])).toEqual([['✓ Done · Port the parser', 'sess-9', `yosemite-m6/sess-9/done-${OPENED}`]]);
  });

  it('a fleet tick never waits on the session scan behind the hourly mailbox sweep', async () => {
    await setAsks([ask('urgent')]);
    let scans = 0;
    const service = new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ interactiveHost: 'zion', schedules: DEFAULTS() }),
      fleetHub: () => hub,
      getSessions: () => { scans += 1; return new Promise<never>(() => {}); },
      notify: (n) => posts.push(n), withdraw: (keys) => withdrawn.push(keys), gc: () => {},
      ledgerDir: path.join(tmp, 'notified'), now: () => clock,
    });
    await at(service, 0);
    await at(service, 61);
    expect(posts).toHaveLength(2);
    expect(scans).toBe(1);
  });

  it('switching interactive.host away withdraws every banner this host still shows', async () => {
    await setAsks([ask('urgent')]);
    let host = 'zion';
    const service = new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ interactiveHost: host, schedules: DEFAULTS() }),
      fleetHub: () => hub, getSessions: async () => [],
      notify: (n) => posts.push(n), withdraw: (keys) => withdrawn.push(keys), gc: () => {},
      ledgerDir: path.join(tmp, 'notified'), now: () => clock,
    });
    await at(service, 0);
    host = '';
    clock += 31_000;
    await service.tick(ctx, new AbortController().signal);
    expect(withdrawn).toEqual([['yosemite-m6/sess-1/t1']]);
  });
});

describe('notifyScope', () => {
  it('unset → local, this machine → fleet, another machine → none', () => {
    expect(notifyScope(undefined, 'zion')).toBe('local');
    expect(notifyScope('Zion', 'zion')).toBe('fleet');
    expect(notifyScope('yosemite-s1', 'zion')).toBe('none');
  });
});

describe('dueStage', () => {
  it('counts each time from when the ask opened', () => {
    const s = parseNotifySchedule(['5m', '1h']) as NotifySchedule;
    expect(dueStage(s, 0, 4 * 60_000)).toBe(-1);
    expect(dueStage(s, 0, 5 * 60_000)).toBe(0);
    expect(dueStage(s, 0, 61 * 60_000)).toBe(1);
    expect(dueStage(parseNotifySchedule(['sidebar']) as NotifySchedule, 0, 1e9)).toBe(-1);
  });
});

describe('AttentionNotifyService — finished-turn banners', () => {
  let tmp: string;
  let posts: DesktopNotification[];
  let withdrawn: string[][];
  let clock: number;
  let rows: ActiveSession[];
  const T0 = 1_792_380_000_000;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-done-'));
    posts = [];
    withdrawn = [];
    clock = T0;
    rows = [];
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {  }
  });

  function makeService(low: readonly string[] = ['0m']) {
    const schedules = Object.fromEntries((['urgent', 'high', 'normal', 'low'] as const).map((l) => [l, parseNotifySchedule(l === 'low' ? low : DEFAULT_NOTIFY_SCHEDULES[l]) as NotifySchedule])) as Record<'urgent' | 'high' | 'normal' | 'low', NotifySchedule>;
    return new AttentionNotifyService({
      self: () => 'zion',
      settings: () => ({ schedules }),
      getSessions: async () => rows,
      notify: (n) => posts.push(n),
      withdraw: (keys) => withdrawn.push(keys),
      gc: () => {},
      feedRoot: path.join(tmp, 'feed'),
      ledgerDir: path.join(tmp, 'notified'),
      now: () => clock,
    });
  }

  const live = (id: string, status: ActiveSession['status']) =>
    session({ sessionId: id, status, title: `Task ${id}`, userTurns: [{ atMs: T0, text: 'go', images: 0 }] });

  async function tickAt(service: AttentionNotifyService, ms: number, next: ActiveSession[]) {
    clock = T0 + ms;
    rows = next;
    await service.tick(ctx, new AbortController().signal);
  }

  it('posts one done banner per turn, withdraws it after 10 s, and a restart sends it again never', async () => {
    const service = makeService();
    await tickAt(service, 5_000, [live('s1', 'running')]);
    await tickAt(service, 3 * 60_000, [live('s1', 'idle')]);
    expect(posts).toEqual([]);
    await tickAt(service, 3 * 60_000 + 15_000, [live('s1', 'idle')]);
    expect(posts.map((n) => [n.title, n.category, n.sessionId, n.key])).toEqual([['Finished · Task s1', 'done', 's1', 'zion/s1/done-1792380000000']]);
    await tickAt(service, 3 * 60_000 + 30_000, [live('s1', 'idle')]);
    expect(withdrawn).toEqual([['zion/s1/done-1792380000000']]);

    const restarted = makeService();
    await tickAt(restarted, 4 * 60_000, [live('s1', 'running')]);
    await tickAt(restarted, 5 * 60_000, [live('s1', 'idle')]);
    await tickAt(restarted, 6 * 60_000, [live('s1', 'idle')]);
    expect(posts).toHaveLength(1);
  });

  it('three finishes together post one summary banner', async () => {
    const service = makeService();
    const ids = ['s1', 's2', 's3'];
    await tickAt(service, 5_000, ids.map((id) => live(id, 'running')));
    await tickAt(service, 3 * 60_000, ids.map((id) => live(id, id === 's3' ? 'running' : 'idle')));
    await tickAt(service, 3 * 60_000 + 10_000, ids.map((id) => live(id, 'idle')));
    await tickAt(service, 3 * 60_000 + 25_000, ids.map((id) => live(id, 'idle')));
    expect(posts.map((n) => [n.title, n.body])).toEqual([['3 sessions finished', 'Task s1 · Task s2 · Task s3']]);
  });

  it('posts no done banner under the default low schedule (sidebar)', async () => {
    const service = makeService(DEFAULT_NOTIFY_SCHEDULES.low);
    await tickAt(service, 5_000, [live('s1', 'running')]);
    await tickAt(service, 3 * 60_000, [live('s1', 'idle')]);
    await tickAt(service, 4 * 60_000, [live('s1', 'idle')]);
    expect(posts).toEqual([]);
  });
});
