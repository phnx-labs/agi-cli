/**
 * Attention truth, end to end on real transcript shapes (PHNX-3999).
 *
 * Reproduces the live 2026-09-10 finding — nine fleet attention records classified
 * `permission`, eight of them from Claude's `idle_prompt` hook event, one of them a
 * session whose whole transcript was "reply with exactly: pong" → "pong" — and pins
 * the corrected pipeline from the transcript bytes to every consumer: the real
 * Claude tail parser (`computeLiveSignals`), the real feed store (`readBlock`), the
 * reconciler, the daemon banner service with its on-disk ledger, and the
 * `feed watch --json` projection the menu-bar helper and AGI EXT render.
 *
 * No mocks: the fixtures under ./testdata are transcripts in the exact line shape
 * Claude Code writes and blocks in the exact shape the feed-publish hook writes.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// watch.ts resolves the feed dir from HOME at module load, so pin it before the
// imports below — the stream projection must read the same store the fixtures
// are copied into.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-truth-'));
process.env.HOME = TEST_HOME;

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getFeedDir } from '../state.js';
import { clearLiveSignalsCacheForTest, computeLiveSignals, type ActiveSession } from '../session/active.js';
import type { SessionWatchRow } from '../session/remote/watch.js';
import { blockIdForSession, readBlock } from './feed.js';
import { reconcileAttention } from './attention.js';
import { AttentionNotifyService } from '../daemon/attention-notify-service.js';
import { FeedWatchState, projectSessionEnvelope, type FeedWatchEnvelope } from './watch.js';
import type { DesktopNotification } from '../menubar/notify-desktop.js';

const TESTDATA = path.join(import.meta.dirname, 'testdata');
const scratch: string[] = [];
afterAll(() => {
  for (const dir of [TEST_HOME, ...scratch]) fs.rmSync(dir, { recursive: true, force: true });
});

/** Copy a transcript fixture to a scratch path and pin its mtime just after its last line. */
function transcript(fixture: string, lastLineIso: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-truth-tx-'));
  scratch.push(dir);
  const file = path.join(dir, fixture);
  fs.copyFileSync(path.join(TESTDATA, fixture), file);
  const mtime = new Date(Date.parse(lastLineIso) + 1_000);
  fs.utimesSync(file, mtime, mtime);
  return file;
}

/** Put a block fixture into the real feed store under the id the hook would have used. */
function installBlock(fixture: string, sessionId: string): void {
  fs.mkdirSync(getFeedDir(), { recursive: true });
  fs.copyFileSync(path.join(TESTDATA, fixture), path.join(getFeedDir(), `${blockIdForSession(sessionId)}.json`));
}

/**
 * The live row `getActiveSessions` builds for a Claude terminal session — the
 * state-engine fields exactly as `applyState` folds them on, from the real parser.
 */
function liveRow(sessionId: string, file: string, nowMs: number): ActiveSession {
  const { state } = computeLiveSignals('claude', file, path.dirname(file), true, nowMs);
  if (!state) throw new Error(`fixture ${file} parsed to no state`);
  return {
    context: 'terminal', kind: 'claude', host: 'iterm', sessionId, cwd: path.dirname(file), pidAlive: true,
    status: state.activity === 'working' ? 'running' : state.activity === 'waiting_input' ? 'input_required' : 'idle',
    activity: state.activity, awaitingReason: state.awaitingReason, question: state.question,
    lastEventMs: state.lastEventMs, lastActivityMs: fs.statSync(file).mtimeMs,
  } as ActiveSession;
}

function watchRow(row: ActiveSession): SessionWatchRow {
  return { ...row, rowKey: `k-${row.sessionId}`, sourceDevice: 'zion', previous: false, resumable: true, unwatched: false, viewingIn: null, recovery: null } as SessionWatchRow;
}

/** The `feed watch --json` envelopes one live-row upsert projects to. */
async function project(row: ActiveSession): Promise<FeedWatchEnvelope[]> {
  return projectSessionEnvelope(
    { version: 1, type: 'upsert', streamId: 's', sequence: 1, capturedAt: Date.now(), scope: 'zion', rowKey: `k-${row.sessionId}`, row: watchRow(row) },
    new FeedWatchState(),
  );
}

const DONE = 'fixture-trivial-done';
const PENDING = 'fixture-permission-pending';
const PROSE = 'fixture-prose-question';
/** One minute after the idle reminder fired; 25 s after the permission dialog opened. */
const NOW = Date.parse('2026-09-10T10:02:04.000Z');

beforeEach(() => {
  clearLiveSignalsCacheForTest();
  fs.rmSync(getFeedDir(), { recursive: true, force: true });
});

describe('a completed trivial task followed by an idle_prompt is not a request', () => {
  it('the transcript reads as a finished turn and the on-disk idle_prompt block yields no attention item', () => {
    installBlock('block-idle-prompt.json', DONE);
    const row = liveRow(DONE, transcript('claude-trivial-done.jsonl', '2026-09-10T10:00:04.505Z'), NOW);
    expect(row.activity).toBe('idle');
    expect(row.awaitingReason).toBeUndefined();
    expect(row.lastEventMs).toBe(Date.parse('2026-09-10T10:00:02.000Z'));
    const block = readBlock(blockIdForSession(DONE), getFeedDir());
    expect(block).toMatchObject({ kind: 'notification', notificationType: 'idle_prompt' });
    expect(reconcileAttention({ block, session: row, nowMs: NOW })).toBeUndefined();
  });

  it('the daemon notifier posts no banner for it, and the stream projection removes rather than upserts attention', async () => {
    installBlock('block-idle-prompt.json', DONE);
    const row = liveRow(DONE, transcript('claude-trivial-done.jsonl', '2026-09-10T10:00:04.505Z'), NOW);
    const posts: DesktopNotification[] = [];
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-truth-ledger-'));
    scratch.push(ledgerDir);
    const service = new AttentionNotifyService({ getSessions: async () => [row], notify: (n) => posts.push(n), feedRoot: getFeedDir(), ledgerDir, now: () => NOW });
    await service.tick({ log: () => {} }, new AbortController().signal);
    expect(posts).toEqual([]);
    expect(fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir) : []).toEqual([]);

    const envelopes = await project(row);
    expect(envelopes.map((e) => e.type)).toEqual(['agent.upsert', 'attention.remove']);
  });
});

describe('a real permission prompt is a permission with the harness choices, until the transcript moves past it', () => {
  it('reconciles to `permission` keyed on the block generation, and the notifier posts one approvable banner', async () => {
    installBlock('block-permission-prompt.json', PENDING);
    const row = liveRow(PENDING, transcript('claude-permission-pending.jsonl', '2026-09-10T10:00:03.000Z'), NOW);
    // The transcript alone says only "a tool call is in flight" — no permission is
    // inferred from it; the hook block is the evidence, corroborated by the cursor.
    expect(row.activity).toBe('working');
    expect(row.awaitingReason).toBeUndefined();
    expect(row.lastEventMs).toBe(Date.parse('2026-09-10T10:00:03.000Z'));

    const block = readBlock(blockIdForSession(PENDING), getFeedDir());
    const item = reconcileAttention({ block, session: row, nowMs: NOW })!;
    expect(item).toMatchObject({
      kind: 'permission', source: 'hook', state: 'open', sessionId: PENDING,
      key: `zion/${PENDING}/2026-09-10T10:00:05.250000+00:00`,
    });
    expect(item.question?.text).toBe('Claude needs your permission to use Bash');
    expect(item.choices).toEqual([
      { id: 'approve', label: 'Approve', deliveryKey: '1' },
      { id: 'approve-session', label: 'Approve for session', deliveryKey: '2' },
      { id: 'deny', label: 'Deny', deliveryKey: 'esc' },
    ]);

    const posts: DesktopNotification[] = [];
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-truth-ledger-'));
    scratch.push(ledgerDir);
    const service = new AttentionNotifyService({ getSessions: async () => [row], notify: (n) => posts.push(n), feedRoot: getFeedDir(), ledgerDir, now: () => NOW });
    await service.tick({ log: () => {} }, new AbortController().signal);
    await service.tick({ log: () => {} }, new AbortController().signal);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ category: 'permission', key: item.key, sessionId: PENDING, body: 'Claude needs your permission to use Bash' });
    expect(posts[0].choices?.map((c) => c.id)).toEqual(['approve', 'approve-session', 'deny']);

    const envelopes = await project(row);
    expect(envelopes.map((e) => e.type)).toEqual(['agent.upsert', 'attention.upsert']);
    const upsert = envelopes[1] as Extract<FeedWatchEnvelope, { type: 'attention.upsert' }>;
    expect(upsert.attention).toMatchObject({ kind: 'permission', key: item.key });
  });

  it('the tool result the operator\'s approval produces resolves the record, whatever the block file still says', async () => {
    installBlock('block-permission-prompt.json', PENDING);
    const file = transcript('claude-permission-pending.jsonl', '2026-09-10T10:00:03.000Z');
    fs.appendFileSync(file, fs.readFileSync(path.join(TESTDATA, 'claude-permission-approved-tail.jsonl')));
    const mtime = new Date(Date.parse('2026-09-10T10:00:42.000Z'));
    fs.utimesSync(file, mtime, mtime);
    const row = liveRow(PENDING, file, NOW);
    expect(row.lastEventMs).toBe(Date.parse('2026-09-10T10:00:41.000Z'));

    const block = readBlock(blockIdForSession(PENDING), getFeedDir());
    expect(block).toBeDefined();
    expect(reconcileAttention({ block, session: row, nowMs: NOW })).toBeUndefined();
    const envelopes = await project(row);
    expect(envelopes.map((e) => e.type)).toEqual(['agent.upsert', 'attention.remove']);
  });

  it('a dismissed banner does not resolve it: the ledger only stops re-posting, the record stays until evidence arrives', async () => {
    installBlock('block-permission-prompt.json', PENDING);
    const row = liveRow(PENDING, transcript('claude-permission-pending.jsonl', '2026-09-10T10:00:03.000Z'), NOW);
    const posts: DesktopNotification[] = [];
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-truth-ledger-'));
    scratch.push(ledgerDir);
    const service = new AttentionNotifyService({ getSessions: async () => [row], notify: (n) => posts.push(n), feedRoot: getFeedDir(), ledgerDir, now: () => NOW });
    await service.tick({ log: () => {} }, new AbortController().signal);
    expect(posts).toHaveLength(1);
    // The operator swipes the banner away. Nothing in the store changes, so the
    // reconciled record — what the menu and the stream render — is still open.
    const later = NOW + 10 * 60_000;
    const item = reconcileAttention({ block: readBlock(blockIdForSession(PENDING), getFeedDir()), session: row, nowMs: later });
    expect(item).toMatchObject({ kind: 'permission', key: posts[0].key });
  });
});

describe('a time-based inference expires from the transcript stamps, not the file mtime', () => {
  it('a trailing free-text question is an inferred ask with no invented buttons, and decays while the bytes sit still', () => {
    const file = transcript('claude-prose-question.jsonl', '2026-09-10T10:00:08.000Z');
    const askedMs = Date.parse('2026-09-10T10:00:06.000Z');

    const fresh = liveRow(PROSE, file, askedMs + 10 * 60_000);
    expect(fresh.activity).toBe('waiting_input');
    const item = reconcileAttention({ session: fresh, nowMs: askedMs + 10 * 60_000 })!;
    expect(item).toMatchObject({ kind: 'question', source: 'heuristic' });
    expect(item.question?.text).toContain('Which browser data directory should I use');
    expect(item.choices).toBeUndefined();

    // Same file, same mtime, same memoized parse — 31 minutes later the verdict
    // has expired. Before PHNX-3999 the mtime-keyed memo returned the frozen
    // "waiting" state here for as long as the transcript went untouched.
    const stale = liveRow(PROSE, file, askedMs + 31 * 60_000);
    expect(stale.activity).toBe('idle');
    expect(reconcileAttention({ session: stale, nowMs: askedMs + 31 * 60_000 })).toBeUndefined();
  });
});
