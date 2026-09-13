/**
 * Reliable answer delivery (PHNX-3999) — no mocks anywhere.
 *
 * Every rail is exercised for real: the remote hop spawns a real `ssh` and a
 * real `agents` (child scripts on PATH, so the tokens asserted are the ones a
 * login shell actually reconstructed), the PR enrichment is gated by a real `gh`
 * on PATH, the keystroke rail drives a real tmux pane, and every claim/receipt
 * assertion reads a real temporary feed store.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActiveSession } from '../session/active.js';
import { isTmuxInstalled, runTmux } from '../tmux/binary.js';
import { createSession, killAll } from '../tmux/session.js';
import { BRACKETED_PASTE_START, BRACKETED_PASTE_END } from '../terminal/inject.js';
import {
  blockIdForSession, confirmAnswerResolution, deriveBlockState, getAnswerRecord, getBlockReceipts,
  latestMessageReceipt, publishBlock, readBlock, readResolution, recordAnswer, recordMessageReceipt,
  type OpenBlock,
} from './feed.js';
import { reconcileAttention } from './attention.js';
import { isOpenQuestionBlock, resolveAnswerRoute } from '../answer-router.js';
import { groupBlocksByOutcome } from '../feed-outcome.js';
import { drain, enqueue, mailboxDir, readBox } from '../mailbox.js';
import { resetPullRequestStatusCache } from './pr-status.js';
import {
  answerOwnerIsLocal, checkAnswerDelivery, claimAndRouteAttentionAnswer, classifyReceipt,
  forwardFeedAnswer, parseAttentionKey, remoteAnswerArgv, STRANDED_CLAIM_MS,
} from './answer.js';

let tmp: string;
const originalPath = process.env.PATH;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-delivery-'));
  resetPullRequestStatusCache();
});
afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function dir(name: string): string {
  const made = path.join(tmp, name);
  fs.mkdirSync(made, { recursive: true });
  return made;
}

/** Put a real executable script on PATH for this test. */
function script(binDir: string, name: string, body: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  return file;
}

/** NUL-delimited argv a child script recorded, so an embedded newline is unambiguous. */
function recordedArgv(file: string): string[] {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\0').slice(0, -1);
}

function parkedSession(sessionId: string, over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal', kind: 'claude', host: 'worker', sessionId, agentId: sessionId,
    status: 'running', ...over,
  } as ActiveSession;
}

function questionBlock(sessionId: string, over: Partial<OpenBlock> = {}): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId), sessionId, mailboxId: sessionId, host: 'worker',
    runtime: 'claude', ts: '2026-09-13T10:00:00.000Z',
    questions: [{ text: 'What next?' }], ...over,
  };
}

// --- attention key + local/remote choice ------------------------------------

describe('attention key', () => {
  it('parses host, session and generation, and refuses a malformed key', () => {
    expect(parseAttentionKey('zion/sess-1/gen-9')).toEqual({ host: 'zion', sessionId: 'sess-1', generation: 'gen-9' });
    // The old `slice(0, indexOf('/'))` turned a separator-less key into a
    // truncated host and then routed the answer at that phantom machine.
    expect(() => parseAttentionKey('nohostorgeneration')).toThrow('Malformed attention key');
    expect(() => parseAttentionKey('zion/sess-1/')).toThrow('Malformed attention key');
  });

  it('treats a `.local` suffix as this machine, not a remote hop', () => {
    expect(answerOwnerIsLocal('Yosemite-M4.local', 'yosemite-m4')).toBe(true);
    expect(answerOwnerIsLocal('mac-mini', 'yosemite-m4')).toBe(false);
  });
});

// --- the remote hop ---------------------------------------------------------

describe('forwardFeedAnswer over a real ssh child', () => {
  /**
   * A faithful `ssh`: real ssh hands its LAST argument to the remote login
   * shell, so the fake does exactly that. Anything that survives to the recorder
   * survived a real `sh -c` parse.
   */
  function fakeSsh(bin: string): void {
    script(bin, 'ssh', 'for last; do :; done\nexec sh -c "$last"');
  }

  it('preserves a multiline answer and shell metacharacters byte-for-byte', async () => {
    const bin = dir('bin');
    const argvFile = path.join(tmp, 'argv');
    fakeSsh(bin);
    script(bin, 'agents', [
      `: > "${argvFile}"`,
      `for a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done`,
      `printf '{"status":"delivered","delivery":"receipt","resolved":false,"attentionKey":"%s","receipt":{"msgId":"m1","status":"queued","at":"2026-09-13T00:00:00.000Z"}}\\n' "$3"`,
    ].join('\n'));

    // Every metacharacter a naive join would let the remote shell evaluate.
    const answer = 'line one\nline two $(whoami) `id` "quoted" \'single\' ; rm -rf / && echo $HOME | cat > /tmp/x';
    const result = await forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-remote/gen-1', text: answer, timeoutMs: 10_000,
    });

    expect(result.status).toBe('delivered');
    const argv = recordedArgv(argvFile);
    expect(argv).toEqual(['feed', 'answer', 'worker/sess-remote/gen-1', '--json', '--text', answer]);
    // Nothing was evaluated on the way: the destructive fragments are still text.
    expect(argv[5]).toContain('$(whoami)');
    expect(argv[5]).toContain('\n');
    expect(fs.existsSync('/tmp/x')).toBe(false);
  });

  it('reports a timeout as UNKNOWN, not a confirmed failure — the remote may have delivered', async () => {
    const bin = dir('bin');
    script(bin, 'ssh', 'sleep 20');
    const startedAt = Date.now();
    const result = await forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-slow/gen-1', text: 'go', timeoutMs: 400,
    });
    expect(result.status).toBe('unknown');
    expect(result.delivery).toBe('unconfirmed');
    expect(result.resolved).toBe(false);
    expect(result.reason).toMatch(/Check delivery rather than resending/);
    // Bounded: the whole call returns far inside the AGI Menu's 30s abandon.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('never trusts a receipt that is about a different attention key', async () => {
    const bin = dir('bin');
    fakeSsh(bin);
    script(bin, 'agents', `printf '{"status":"delivered","delivery":"receipt","resolved":false,"attentionKey":"worker/someone-else/gen-9"}\\n'`);
    const result = await forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-mine/gen-1', text: 'go', timeoutMs: 10_000,
    });
    // The remote DID run, so this is not a retry-safe failure — but its answer
    // describes another item, so it is no evidence about this one either.
    expect(result.status).toBe('unknown');
    expect(result.delivery).toBe('unconfirmed');
    expect(result.receipt).toBeUndefined();
    expect(result.reason).toMatch(/reported 'worker\/someone-else\/gen-9', not 'worker\/sess-mine\/gen-1'/);
  });

  it('treats a delivered-then-truncated remote reply as unknown, not a safe retry', async () => {
    const bin = dir('bin');
    fakeSsh(bin);
    // Wrote to the rail, then died before emitting its JSON receipt.
    script(bin, 'agents', 'echo "panic: connection reset" >&2\nexit 1');
    const result = await forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-mine/gen-1', text: 'go', timeoutMs: 10_000,
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/no JSON receipt/);
  });

  it('reports an ssh connection failure as a CONFIRMED failure — nothing ran', async () => {
    const bin = dir('bin');
    script(bin, 'ssh', 'echo "ssh: connect to host worker port 22: No route to host" >&2\nexit 255');
    await expect(forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-mine/gen-1', text: 'go', timeoutMs: 10_000,
    })).rejects.toThrow(/No route to host/);
  });

  it('rejects a shape-invalid remote reply that claims a receipt without one', async () => {
    const bin = dir('bin');
    fakeSsh(bin);
    script(bin, 'agents', `printf '{"status":"delivered","delivery":"receipt","resolved":false,"attentionKey":"worker/sess-mine/gen-1"}\\n'`);
    const result = await forwardFeedAnswer({
      host: 'worker', attentionKey: 'worker/sess-mine/gen-1', text: 'go', timeoutMs: 10_000,
    });
    expect(result.status).toBe('unknown');
    expect(result.reason).toMatch(/claimed a receipt without one/);
  });

  it('carries --check through to the remote as a read-only request', () => {
    expect(remoteAnswerArgv({ attentionKey: 'w/s/g', check: true })).toEqual(
      ['agents', 'feed', 'answer', 'w/s/g', '--json', '--check'],
    );
  });
});

// --- targeting --------------------------------------------------------------

describe('answer targeting', () => {
  it('never answers a different session that is also pending', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const mine = parkedSession('mine');
    const theirs = parkedSession('theirs');
    publishBlock(questionBlock('mine'), feedRoot);
    publishBlock(questionBlock('theirs'), feedRoot);
    const key = reconcileAttention({ block: questionBlock('mine'), session: mine, nowMs: Date.now() })!.key;

    await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'for mine only', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [theirs, mine],
    });

    expect(fs.readdirSync(path.join(mailboxRoot, 'mine', 'inbox'))).toHaveLength(1);
    // The other operator's pending request was neither claimed nor delivered to.
    expect(fs.existsSync(path.join(mailboxRoot, 'theirs'))).toBe(false);
    expect(getAnswerRecord(blockIdForSession('theirs'), feedRoot)).toBeUndefined();
  });

  it('refuses a stale key once the session has moved to a new question', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('moved');
    const first = questionBlock('moved', { questions: [{ text: 'Ship it?' }] });
    publishBlock(first, feedRoot);
    const staleKey = reconcileAttention({ block: first, session, nowMs: Date.now() })!.key;

    // The agent asked something else; the block generation moves with it.
    const second = questionBlock('moved', { ts: '2026-09-13T11:00:00.000Z', questions: [{ text: 'Roll back?' }] });
    publishBlock(second, feedRoot);

    await expect(claimAndRouteAttentionAnswer({
      attentionKey: staleKey, text: 'yes', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    })).rejects.toThrow(/no longer the open request/);
    expect(getAnswerRecord(blockIdForSession('moved'), feedRoot)).toBeUndefined();
    expect(fs.existsSync(path.join(mailboxRoot, 'moved'))).toBe(false);
  });

  it('names the missing session instead of scanning every other one', async () => {
    await expect(claimAndRouteAttentionAnswer({
      attentionKey: 'worker/ghost/gen-1', text: 'hi', operator: { verified: false },
      feedRoot: dir('feed'), mailboxRoot: dir('mail'), sessions: [parkedSession('other')],
    })).rejects.toThrow("No live session 'ghost' here");
  });
});

// --- PR enrichment is last, not first ---------------------------------------

describe('PR enrichment', () => {
  /** A `gh` that records every call and then stalls, so an eager read is visible AND slow. */
  function stallingGh(bin: string, marker: string): void {
    script(bin, 'gh', `touch "${marker}"\nsleep 20`);
  }

  it('answers an ordinary question without ever running gh', async () => {
    const bin = dir('bin');
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const marker = path.join(tmp, 'gh-ran');
    stallingGh(bin, marker);

    // A session carrying a PR — exactly the row whose enrichment used to be paid
    // for before the requested key was even compared.
    const session = parkedSession('with-pr', { cwd: tmp, pr: { number: 7, url: 'https://example.test/pr/7' } } as Partial<ActiveSession>);
    publishBlock(questionBlock('with-pr'), feedRoot);
    const key = reconcileAttention({ block: questionBlock('with-pr'), session, nowMs: Date.now() })!.key;

    const startedAt = Date.now();
    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'ship it', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    });

    expect(result.status).toBe('delivered');
    expect(fs.existsSync(marker)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('still enriches when the key IS a PR review, so the fallback was narrowed and not deleted', async () => {
    const bin = dir('bin');
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    script(bin, 'gh', `printf '{"number":7,"title":"Fix it","state":"OPEN","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","statusCheckRollup":[]}'`);

    const session = parkedSession('review-me', {
      cwd: tmp, activity: 'working', pr: { number: 7, url: 'https://example.test/pr/7' },
    } as Partial<ActiveSession>);
    const key = `worker/review-me/pr7:REVIEW_REQUIRED`;

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'approving', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('delivered');
    const inbox = path.join(mailboxRoot, 'review-me', 'inbox');
    const delivered = JSON.parse(fs.readFileSync(path.join(inbox, fs.readdirSync(inbox)[0]), 'utf8')) as { text: string };
    expect(delivered.text).toBe('approving');
  });
});

// --- receipts and idempotence ------------------------------------------------

describe('claims reconciled against real receipts', () => {
  it('a repeat answer reports the FIRST delivery\'s real receipt and enqueues nothing new', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('once');
    publishBlock(questionBlock('once'), feedRoot);
    const key = reconcileAttention({ block: questionBlock('once'), session, nowMs: Date.now() })!.key;
    const common = { attentionKey: key, operator: { verified: false, label: 'op' }, feedRoot, mailboxRoot, sessions: [session] };

    const first = await claimAndRouteAttentionAnswer({ ...common, text: 'first' });
    const second = await claimAndRouteAttentionAnswer({ ...common, text: 'second' });

    expect(first.status).toBe('delivered');
    expect(second.status).toBe('already_answered');
    expect(second.receipt?.msgId).toBe(first.receipt?.msgId);
    expect(fs.readdirSync(path.join(mailboxRoot, 'once', 'inbox'))).toHaveLength(1);
    expect(getBlockReceipts(blockIdForSession('once'), feedRoot)).toHaveLength(1);
  });

  it('a queued receipt is delivery, never resolution — and dropped/expired are failures', () => {
    expect(classifyReceipt({ msgId: 'm', status: 'queued', at: 'x' })).toEqual({ delivery: 'receipt', resolved: false });
    expect(classifyReceipt({ msgId: 'm', status: 'consumed', at: 'x' })).toEqual({ delivery: 'receipt', resolved: true });
    expect(classifyReceipt({ msgId: 'm', status: 'continued', at: 'x' })).toEqual({ delivery: 'receipt', resolved: true });
    // `dropped`/`expired` outrank `continued` in the monotonic WRITE rank, so a
    // reader that equated "furthest along" with success reported a dead message
    // as a resolved answer.
    expect(classifyReceipt({ msgId: 'm', status: 'dropped', at: 'x' })).toEqual({ delivery: 'failed', resolved: false });
    expect(classifyReceipt({ msgId: 'm', status: 'expired', at: 'x' })).toEqual({ delivery: 'failed', resolved: false });
  });

  it('reports a dropped receipt as a failure rather than an answered item', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('dead-letter');
    const block = questionBlock('dead-letter');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot);
    recordMessageReceipt(block.blockId, { msgId: 'm1', status: 'dropped', at: '2026-09-13T10:05:00.000Z' }, feedRoot);

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'retry', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('failed');
    expect(result.delivery).toBe('failed');
    expect(result.resolved).toBe(false);
    expect(latestMessageReceipt(block.blockId, feedRoot)?.status).toBe('dropped');
  });

  it('adopts a claim a kill stranded, completes it once, and does not double-enqueue', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('stranded');
    const block = questionBlock('stranded');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    // A claim written, then the process killed before any rail reported back.
    const markerDir = path.join(feedRoot, 'answered');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, `${block.blockId}.json`), JSON.stringify({
      answeredAt: new Date(Date.now() - STRANDED_CLAIM_MS - 5_000).toISOString(),
      answeredFrom: 'feed', answeredBy: 'killed-run',
    }));
    expect(latestMessageReceipt(block.blockId, feedRoot)).toBeUndefined();

    const common = { attentionKey: key, text: 'finish it', operator: { verified: false, label: 'op' }, feedRoot, mailboxRoot, sessions: [session] };
    const adopted = await claimAndRouteAttentionAnswer(common);
    expect(adopted.status).toBe('delivered');
    expect(adopted.receipt?.status).toBe('queued');

    // Two retries after the strand window must not both deliver.
    const again = await claimAndRouteAttentionAnswer(common);
    expect(again.status).toBe('already_answered');
    expect(fs.readdirSync(path.join(mailboxRoot, 'stranded', 'inbox'))).toHaveLength(1);
  });

  it('leaves a FRESH claim alone — an in-flight delivery is never adopted', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('inflight');
    const block = questionBlock('inflight');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'holder' }, feedRoot);

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'me too', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('unknown');
    expect(result.delivery).toBe('unconfirmed');
    expect(result.reason).toMatch(/Check delivery rather than resending/);
    expect(fs.existsSync(path.join(mailboxRoot, 'inflight'))).toBe(false);
  });
});

describe('stranded-claim replay is bound to the ask and the rail', () => {
  /** Write an answered marker directly, as a killed run would leave behind. */
  function strandClaim(blockId: string, feedRoot: string, ageMs: number): string {
    const answeredAt = new Date(Date.now() - ageMs).toISOString();
    const dir = path.join(feedRoot, 'answered');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${blockId}.json`), JSON.stringify({
      answeredAt, answeredFrom: 'feed', answeredBy: 'killed-run',
    }));
    return answeredAt;
  }

  it("does not mistake an OLD question's queued message for this question's delivery", async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('two-asks');

    // Question 1 was answered and its message is still in the spool.
    enqueue(mailboxDir('two-asks', mailboxRoot), {
      to: 'two-asks', text: 'answer to the FIRST question', blockId: blockIdForSession('two-asks'),
      generation: '2026-09-13T10:00:00.000Z', attempt: '2026-09-13T10:00:01.000Z',
    });

    // The agent has since asked question 2, whose claim a kill stranded.
    const q2 = questionBlock('two-asks', { ts: '2026-09-13T12:00:00.000Z', questions: [{ text: 'Second question?' }] });
    publishBlock(q2, feedRoot);
    const q2Key = reconcileAttention({ block: q2, session, nowMs: Date.now() })!.key;
    strandClaim(q2.blockId, feedRoot, STRANDED_CLAIM_MS + 5_000);

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: q2Key, text: 'answer to the SECOND question',
      operator: { verified: false, label: 'op' }, feedRoot, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('delivered');

    // The block id is shared, so a bare-blockId match would have "re-used" the
    // first question's message and reported delivered while sending nothing.
    const spool = readBox(mailboxDir('two-asks', mailboxRoot));
    expect(spool).toHaveLength(2);
    expect(spool.map((m) => m.text).sort()).toEqual([
      'answer to the FIRST question', 'answer to the SECOND question',
    ]);
  });

  it('keeps a parked headless agent on its resume rail when a stranded claim is retried', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    // Parked headless: the correct rail is resume, NOT the mailbox it will never drain.
    const session = parkedSession('parked-headless', {
      context: 'headless', status: 'input_required', activity: 'waiting_input',
      awaitingReason: 'question', tty: false,
    } as Partial<ActiveSession>);
    const block = questionBlock('parked-headless');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    // A pending claim records an answer ON the block while leaving it open. If a
    // consumer read `block.answer` truthiness instead of the canonical state, the
    // route would silently downgrade to mailbox here.
    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'killed-run' }, feedRoot, { pending: true });
    const claimed = readBlock(block.blockId, feedRoot)!;
    expect(claimed.answer).toBeDefined();
    expect(deriveBlockState(claimed)).toBe('open');
    expect(isOpenQuestionBlock(claimed)).toBe(true);
    expect(resolveAnswerRoute({ mailboxId: 'parked-headless', answer: 'go', block: claimed, session }).kind)
      .toBe('resume');

    // And the operator's own feed still shows it as needing a human.
    expect(groupBlocksByOutcome([claimed])[0].counts.open).toBe(1);
    expect(fs.existsSync(path.join(mailboxRoot, 'parked-headless'))).toBe(false);
    expect(key).toContain('parked-headless');
  });

  it('lets exactly ONE of two concurrent adopters take a stranded claim', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('contended');
    const block = questionBlock('contended');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    strandClaim(block.blockId, feedRoot, STRANDED_CLAIM_MS + 5_000);

    const common = { attentionKey: key, operator: { verified: false, label: 'op' }, feedRoot, mailboxRoot, sessions: [session] };
    const results = await Promise.all([
      claimAndRouteAttentionAnswer({ ...common, text: 'adopter A' }),
      claimAndRouteAttentionAnswer({ ...common, text: 'adopter B' }),
    ]);

    // Exactly one delivers; the other reports rather than sending a second copy.
    expect(results.filter((r) => r.status === 'delivered')).toHaveLength(1);
    expect(fs.readdirSync(path.join(mailboxRoot, 'contended', 'inbox'))).toHaveLength(1);
    // The release token must not be left behind.
    const answered = fs.readdirSync(path.join(feedRoot, 'answered'));
    expect(answered.filter((f) => f.endsWith('.release'))).toEqual([]);
  });
});

// --- read-only delivery check -----------------------------------------------

describe('checkAnswerDelivery', () => {
  it('reports the stored state and changes nothing — no claim, no message', () => {
    const feedRoot = dir('feed');
    const session = parkedSession('checked');
    const block = questionBlock('checked');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    const noClaim = checkAnswerDelivery(key, feedRoot);
    expect(noClaim.status).toBe('failed');
    expect(noClaim.reason).toMatch(/No answer has been claimed/);
    expect(getAnswerRecord(block.blockId, feedRoot)).toBeUndefined();

    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot, { pending: true });
    const claimedOnly = checkAnswerDelivery(key, feedRoot);
    expect(claimedOnly.status).toBe('unknown');
    expect(claimedOnly.delivery).toBe('unconfirmed');
    expect(claimedOnly.attempt).toBe(getAnswerRecord(block.blockId, feedRoot)?.answeredAt);

    recordMessageReceipt(block.blockId, { msgId: 'm1', status: 'consumed', at: '2026-09-13T10:10:00.000Z' }, feedRoot);
    const consumed = checkAnswerDelivery(key, feedRoot);
    expect(consumed.status).toBe('already_answered');
    expect(consumed.resolved).toBe(true);
    expect(consumed.receipt?.msgId).toBe('m1');
    // Still read-only: exactly the one receipt the rail recorded.
    expect(getBlockReceipts(block.blockId, feedRoot)).toHaveLength(1);
  });

  it("never reports the NEXT question's receipt as this question's answer", () => {
    const feedRoot = dir('feed');
    const session = parkedSession('two-questions');
    const q1 = questionBlock('two-questions', { questions: [{ text: 'Ship it?' }] });
    publishBlock(q1, feedRoot);
    const q1Key = reconcileAttention({ block: q1, session, nowMs: Date.now() })!.key;

    // The session moved to a second question, which was answered and consumed.
    const q2 = questionBlock('two-questions', { ts: '2026-09-13T12:00:00.000Z', questions: [{ text: 'Roll back?' }] });
    publishBlock(q2, feedRoot);
    recordAnswer(q2.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot, { pending: true });
    recordMessageReceipt(q2.blockId, { msgId: 'q2', status: 'consumed', at: '2026-09-13T12:01:00.000Z' }, feedRoot);

    // One block id serves both generations, so an unbound check would hand Q2's
    // consumed receipt back as proof that Q1 was answered.
    const checked = checkAnswerDelivery(q1Key, feedRoot);
    expect(checked.status).toBe('unknown');
    expect(checked.resolved).toBe(false);
    expect(checked.receipt).toBeUndefined();
    expect(checked.reason).toMatch(/not the generation this session is on/);
  });

  it('distinguishes a superseded attempt from the one the caller is checking', () => {
    const feedRoot = dir('feed');
    const session = parkedSession('attempted');
    const block = questionBlock('attempted');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;
    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot, { pending: true });
    const live = getAnswerRecord(block.blockId, feedRoot)!.answeredAt;

    expect(checkAnswerDelivery(key, feedRoot, live).status).toBe('unknown');
    const stale = checkAnswerDelivery(key, feedRoot, '2020-01-01T00:00:00.000Z');
    expect(stale.reason).toMatch(/was replaced by one at/);
    expect(stale.attempt).toBe(live);
  });
});

describe('a claim is not a resolution', () => {
  it('leaves the card OPEN while delivery is unconfirmed, and resolves it on a receipt', async () => {
    const feedRoot = dir('feed');
    const session = parkedSession('pending-card');
    const block = questionBlock('pending-card');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    // Phase 1 — claimed, not resolved: no tombstone, and the reconciler still
    // surfaces the item, so an unconfirmed answer cannot hide the request.
    recordAnswer(block.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot, { pending: true });
    expect(readResolution(block.blockId, feedRoot)).toBeUndefined();
    const claimed = readBlock(block.blockId, feedRoot)!;
    expect(deriveBlockState(claimed)).toBe('open');
    expect(reconcileAttention({ block: claimed, session, nowMs: Date.now() })?.key).toBe(key);

    // A `queued` receipt is the RAIL taking the answer — still not resolution.
    recordMessageReceipt(block.blockId, { msgId: 'm1', status: 'queued', at: '2026-09-13T10:05:00.000Z' }, feedRoot);
    expect(readResolution(block.blockId, feedRoot)).toBeUndefined();
    expect(deriveBlockState(readBlock(block.blockId, feedRoot)!)).toBe('open');

    // The AGENT's own acknowledgement is what lets the card go.
    recordMessageReceipt(block.blockId, { msgId: 'm1', status: 'consumed', at: '2026-09-13T10:06:00.000Z' }, feedRoot);
    expect(readResolution(block.blockId, feedRoot)?.reason).toBe('answered');
    expect(deriveBlockState(readBlock(block.blockId, feedRoot)!)).toBe('answered');
  });

  it('a queued delivery leaves the card up until the agent drains it', async () => {
    const feedRoot = dir('feed');
    const mailboxRoot = dir('mail');
    const session = parkedSession('drains');
    const block = questionBlock('drains');
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'go', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot, sessions: [session],
    });
    expect(result.status).toBe('delivered');
    expect(result.resolved).toBe(false);
    expect(readResolution(block.blockId, feedRoot)).toBeUndefined();
    expect(deriveBlockState(readBlock(block.blockId, feedRoot)!)).toBe('open');

    // The REAL drain records `consumed`, which promotes the claim to resolved.
    // It resolves its feed store from the environment, exactly as in production.
    const priorFeedDir = process.env.AGENTS_FEED_DIR;
    process.env.AGENTS_FEED_DIR = feedRoot;
    try {
      expect(drain(mailboxDir('drains', mailboxRoot), 'drains')).toHaveLength(1);
    } finally {
      if (priorFeedDir === undefined) delete process.env.AGENTS_FEED_DIR;
      else process.env.AGENTS_FEED_DIR = priorFeedDir;
    }
    expect(latestMessageReceipt(block.blockId, feedRoot)?.status).toBe('consumed');
    expect(readResolution(block.blockId, feedRoot)?.reason).toBe('answered');
  });

  it("a late acknowledgement cannot resolve the question the agent moved on to", () => {
    const feedRoot = dir('feed');
    const q1 = questionBlock('late-ack', { questions: [{ text: 'Ship it?' }] });
    publishBlock(q1, feedRoot);
    recordAnswer(q1.blockId, { answeredFrom: 'feed', answeredBy: 'op' }, feedRoot, { pending: true });
    const q1Attempt = getAnswerRecord(q1.blockId, feedRoot)!.answeredAt;

    // The agent moved on. A new generation publishes a fresh block with no
    // answer record — nothing has claimed THIS ask.
    const q2 = questionBlock('late-ack', { ts: '2026-09-13T12:00:00.000Z', questions: [{ text: 'Roll back?' }] });
    publishBlock(q2, feedRoot);

    // Q1's slow rail finally acknowledges. It must not resolve Q2.
    recordMessageReceipt(q2.blockId, { msgId: 'q1-late', status: 'consumed', at: '2026-09-13T12:05:00.000Z' }, feedRoot);
    expect(readResolution(q2.blockId, feedRoot)).toBeUndefined();
    expect(deriveBlockState(readBlock(q2.blockId, feedRoot)!)).toBe('open');

    // And an explicit confirm bound to Q1's identity is a no-op against Q2.
    expect(confirmAnswerResolution(q2.blockId, feedRoot, {
      generation: q1.ts, answeredAt: q1Attempt,
    })).toBe(false);
    expect(readResolution(q2.blockId, feedRoot)).toBeUndefined();
  });
});

// --- the keystroke rail, against a real tmux pane ---------------------------

const noTmux = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(noTmux)('multiline free text over a real tmux rail', () => {
  const name = 'answer-e2e';
  let socket: string;

  beforeEach(() => { socket = path.join(dir('tmux'), 'srv.sock'); });
  afterEach(async () => { try { await killAll(socket); } catch { /* best-effort */ } });

  async function firstPane(): Promise<string> {
    const res = await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}'] });
    return res.stdout.trim().split('\n')[0];
  }

  it('delivers every line in ONE bracketed paste, so the TUI never submits a partial line', async () => {
    const feedRoot = dir('feed');
    const paneCwd = dir('pane');
    const sink = path.join(paneCwd, 'typed.txt');
    // `cat > file` records the exact bytes that reached the pty.
    await createSession({ name, socket, cmd: `cat > ${sink}`, cwd: paneCwd });
    const pane = await firstPane();

    const session = parkedSession('multiline', {
      status: 'input_required', activity: 'waiting_input', awaitingReason: 'question', tty: true,
      provenance: { reply: { rail: 'tmux', target: pane, socket } },
    } as Partial<ActiveSession>);
    const block = questionBlock('multiline', { questions: [{ text: 'Describe the fix' }] });
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    const answer = 'first line\nsecond line\nthird line';
    const result = await claimAndRouteAttentionAnswer({
      attentionKey: key, text: answer, operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot: dir('mail'), sessions: [session],
    });
    expect(result.status).toBe('delivered');

    let typed = '';
    for (let i = 0; i < 60; i++) {
      typed = fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8') : '';
      if (typed.includes('third line')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Asserted against the literal DEC-2004 bytes, NOT the exported constant:
    // comparing the output to the same constant that produced it would pass even
    // if the constant were missing its ESC.
    const ESC = String.fromCharCode(0x1b);
    expect(BRACKETED_PASTE_START).toBe(`${ESC}[200~`);
    expect(BRACKETED_PASTE_END).toBe(`${ESC}[201~`);
    // One paste, framed — every line rode in a single insert.
    expect(typed).toContain(`${ESC}[200~`);
    expect(typed).toContain(`${ESC}[201~`);
    expect(typed).toContain('first line');
    expect(typed).toContain('second line');
    expect(typed).toContain('third line');
    expect(typed.indexOf(BRACKETED_PASTE_START)).toBeLessThan(typed.indexOf('first line'));
    expect(typed.indexOf('third line')).toBeLessThan(typed.indexOf(BRACKETED_PASTE_END));
  });

  it('refuses a multiline answer on a rail that cannot paste, before taking the claim', async () => {
    const feedRoot = dir('feed');
    const session = parkedSession('ghostty-rail', {
      status: 'input_required', activity: 'waiting_input', awaitingReason: 'question', tty: true,
      provenance: { reply: { rail: 'iterm', target: 'sess-uuid' } },
    } as Partial<ActiveSession>);
    const block = questionBlock('ghostty-rail', { questions: [{ text: 'Describe the fix' }] });
    publishBlock(block, feedRoot);
    const key = reconcileAttention({ block, session, nowMs: Date.now() })!.key;

    await expect(claimAndRouteAttentionAnswer({
      attentionKey: key, text: 'one\ntwo', operator: { verified: false, label: 'op' },
      feedRoot, mailboxRoot: dir('mail'), sessions: [session],
    })).rejects.toThrow(/multiline answer cannot be typed|no addressable terminal/);
    // Refused BEFORE the claim, so the item stays cleanly answerable.
    expect(getAnswerRecord(block.blockId, feedRoot)).toBeUndefined();
  });
});
