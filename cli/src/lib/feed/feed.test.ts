import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'yaml';
import { spawnSync } from 'child_process';
import {
  FEED_PUBLISH_HOOK_SCRIPT,
  ensureFeedPublishHook,
  buildDeclaredBlock,
  type DeclaringAgent,
  publishBlock,
  listBlocks,
  readBlock,
  removeBlock,
  blockIdForSession,
  recordAnswer,
  recordMessageReceipt,
  recordContinued,
  getAnswerRecord,
  isBlockAnswered,
  listAskStats,
  readResolution,
  type OpenBlock,
} from './feed.js';
import { classifyBlock, filterBlocksForFeed } from '../ask-classifier.js';
import { isPhoneUrgent, DEFAULT_POLICY } from '../feed-policy.js';
import { loadOperators } from '../operator.js';
import { reconcileAttention } from './attention.js';
import type { ActiveSession } from '../session/active.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;

function tmpFeedDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-test-'));
}

function makeBlock(sessionId: string, text: string, opts?: Partial<OpenBlock>): OpenBlock {
  return {
    blockId: blockIdForSession(sessionId),
    sessionId,
    mailboxId: sessionId,
    host: 'test-host',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{ text }],
    ...opts,
  };
}

describe('feed store', () => {
  it('publishes a block and reads it back', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('sess-1', 'Which approach?', {
      questions: [{
        text: 'Which approach?',
        header: 'Approach',
        options: [
          { label: 'A', description: 'Option A' },
          { label: 'B', description: 'Option B' },
        ],
        multiSelect: false,
      }],
    });
    publishBlock(block, dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe('block-sess-1');
    expect(blocks[0].sessionId).toBe('sess-1');
    expect(blocks[0].questions[0].text).toBe('Which approach?');
    expect(blocks[0].questions[0].options).toHaveLength(2);
    expect(blocks[0].questions[0].options![0].label).toBe('A');
  });

  it('replaces a block when the same session publishes again', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-2', 'first question'), dir);
    publishBlock(makeBlock('sess-2', 'second question'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].questions[0].text).toBe('second question');
  });

  it('lists multiple blocks from different sessions', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('aaa', 'question A'), dir);
    publishBlock(makeBlock('bbb', 'question B'), dir);
    publishBlock(makeBlock('ccc', 'question C'), dir);

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(3);
    expect(blocks.map(b => b.sessionId)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('removes a block by id', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('to-remove', 'remove me'), dir);
    expect(listBlocks(dir)).toHaveLength(1);

    const removed = removeBlock(blockIdForSession('to-remove'), dir);
    expect(removed).toBe(true);
    expect(listBlocks(dir)).toHaveLength(0);
  });

  it('removeBlock returns false for a missing block', () => {
    const dir = tmpFeedDir();
    expect(removeBlock('no-such-block', dir)).toBe(false);
  });

  it('listBlocks returns empty for a missing directory', () => {
    expect(listBlocks('/tmp/nonexistent-feed-dir-' + Date.now())).toEqual([]);
  });

  it('skips corrupt JSON files', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('valid', 'a real question'), dir);
    fs.writeFileSync(path.join(dir, 'corrupt.json'), '{not valid json', 'utf-8');
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}', 'utf-8');

    const blocks = listBlocks(dir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].sessionId).toBe('valid');
  });

  it('publish is atomic (no partial reads)', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('atomic', 'atomic write test');
    publishBlock(block, dir);

    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  // RUSH-2840: publishBlock() now routes through the shared atomicWriteJsonSync
  // instead of hand-rolling its own tmp-then-rename. This pins the discriminating
  // half of that guarantee that the "no partial reads" test above does not cover:
  // a write that FAILS must leave the previous valid block untouched, with no
  // stray tmp file. Only a NEW-file create can be blocked by directory
  // permissions -- renaming over an existing directory entry is not -- so
  // making the dir read-only forces atomicWriteJsonSync's first fs call (the
  // tmp-file create) to fail before rename is ever reached. chmod is a no-op on
  // Windows and root bypasses the permission check entirely, so this is skipped
  // where the mechanism cannot hold.
  const canBlockFileCreate =
    process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  const itBlocksCreate = canBlockFileCreate ? it : it.skip;

  itBlocksCreate('a publish that cannot complete leaves the previous block untouched, never torn', () => {
    const dir = tmpFeedDir();
    const block = makeBlock('atomic-fail', 'v1');
    publishBlock(block, dir);
    const target = path.join(dir, `${block.blockId}.json`);
    const before = fs.readFileSync(target, 'utf-8');
    expect(JSON.parse(before).questions[0].text).toBe('v1');

    const v2 = makeBlock('atomic-fail', 'v2');
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => publishBlock(v2, dir)).toThrow();

      const after = fs.readFileSync(target, 'utf-8');
      expect(after).toBe(before);
      expect(JSON.parse(after).questions[0].text).toBe('v1');
    } finally {
      fs.chmodSync(dir, 0o755);
    }

    expect(fs.readdirSync(dir)).toEqual([`${block.blockId}.json`]);
  });

  it('blockIdForSession produces a deterministic id', () => {
    expect(blockIdForSession('abc-123')).toBe('block-abc-123');
    expect(blockIdForSession('abc-123')).toBe(blockIdForSession('abc-123'));
  });

  it('sanitizes session ids before using them as filenames', () => {
    expect(blockIdForSession('../../outside/session')).toBe('block-..-..-outside-session');
    const dir = tmpFeedDir();
    expect(() => publishBlock(makeBlock('safe', 'question', { blockId: '../escape' }), dir)).toThrow('Invalid feed block id');
  });

  it('preserves ticket and PR fields', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('with-meta', 'question', {
      ticket: 'RUSH-1473',
      pr: 'https://github.com/phnx-labs/agents-cli/pull/999',
    }), dir);

    const blocks = listBlocks(dir);
    expect(blocks[0].ticket).toBe('RUSH-1473');
    expect(blocks[0].pr).toBe('https://github.com/phnx-labs/agents-cli/pull/999');
  });

  it('preserves every question in one AskUserQuestion block', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('multi-question', 'first', {
      questions: [
        { text: 'First?', header: 'One', options: [{ label: 'A' }] },
        { text: 'Second?', header: 'Two', options: [{ label: 'B' }], multiSelect: true },
      ],
    }), dir);

    const blocks = listBlocks(dir);
    expect(blocks[0].questions.map((q) => q.text)).toEqual(['First?', 'Second?']);
    expect(blocks[0].questions[1].multiSelect).toBe(true);
  });

  it('buildDeclaredBlock stamps project from cwd, worktree-aware', () => {
    const plain = buildDeclaredBlock(
      { sessionId: 's1', mailboxId: 'm1', host: 'zion', runtime: 'claude', cwd: '/home/muqsit/src/foo' },
      { text: 'Stuck?' },
    );
    expect(plain.project).toBe('foo');

    const worktree = buildDeclaredBlock(
      { sessionId: 's2', mailboxId: 'm2', host: 'zion', runtime: 'claude', cwd: '/home/muqsit/src/agents-cli/.agents/worktrees/feature-x' },
      { text: 'Stuck?' },
    );
    expect(worktree.project).toBe('agents-cli');

    const noCwd = buildDeclaredBlock(
      { sessionId: 's3', mailboxId: 'm3', host: 'zion', runtime: 'claude' },
      { text: 'Stuck?' },
    );
    expect(noCwd.project).toBeUndefined();
  });

  it('buildDeclaredBlock stamps sourceCursor from ts at write time', () => {
    const ts = '2026-08-27T12:00:00.000Z';
    const block = buildDeclaredBlock(
      { sessionId: 's-cursor', mailboxId: 'm1', host: 'zion', runtime: 'claude' },
      { text: 'Need a decision?', ts },
    );
    expect(block.sourceCursor).toEqual({ lastActivityMs: Date.parse(ts) });
    expect(block.generation).toBe(ts);
  });

  it.runIf(hasPython)('real hook publishes every question and runtime into the shared feed', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-hook-'));
    const mailbox = path.join(home, '.agents', '.history', 'mailbox', 'session-123');
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-123',
        tool_input: {
          questions: [
            { question: 'First?', header: 'One', options: [{ label: 'A', description: 'alpha' }], multiSelect: false },
            { question: 'Second?', header: 'Two', options: [{ label: 'B', description: 'beta' }], multiSelect: true },
          ],
        },
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'teams' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].mailboxId).toBe('session-123');
    expect(blocks[0].runtime).toBe('teams');
    expect(blocks[0].kind).toBe('question');
    expect(blocks[0].questions.map((q) => q.text)).toEqual(['First?', 'Second?']);

    const replace = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-123',
        tool_input: { questions: [{ question: 'Replacement?', header: 'New' }] },
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'teams' },
      encoding: 'utf-8',
    });
    expect(replace.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toMatchObject([
      { questions: [{ text: 'Replacement?' }] },
    ]);
    const stats = listAskStats(path.join(home, '.agents', '.history', 'feed'));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      sessionId: 'session-123',
      mailboxId: 'session-123',
      totalAskCount: 2,
    });
    expect(stats[0].recentAskTimestamps).toHaveLength(2);
  });

  it.runIf(hasPython)('real hook stamps project from cwd, folding worktrees to repo name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-hook-project-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-project',
        tool_input: { questions: [{ question: 'Which approach?' }] },
        cwd: '/home/muqsit/src/agents-cli/.agents/worktrees/feature-x',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].project).toBe('agents-cli');
  });

  it.runIf(hasPython)('real hook stamps sourceCursor at publish time', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-hook-cursor-'));
    const before = Date.now();
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-cursor',
        tool_input: { questions: [{ question: 'Which approach?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    const after = Date.now();
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    const cursor = blocks[0].sourceCursor?.lastActivityMs;
    expect(typeof cursor).toBe('number');
    expect(cursor).toBeGreaterThanOrEqual(before - 1000);
    expect(cursor).toBeLessThanOrEqual(after + 1000);
  });

  it.runIf(hasPython)('real hook publishes waiting notifications with routing identity', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-notification-'));
    const mailbox = path.join(home, '.agents', '.history', 'mailbox', 'session-notify');
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-notify',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Permission needed',
        message: 'Claude needs permission to use Bash',
      }),
      env: { ...process.env, HOME: home, AGENTS_MAILBOX_DIR: mailbox, AGENTS_RUNTIME: 'headless' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      mailboxId: 'session-notify',
      runtime: 'headless',
      kind: 'notification',
      notificationType: 'permission_prompt',
    });
    expect(blocks[0].questions).toEqual([{
      text: 'Claude needs permission to use Bash',
      header: 'Permission needed',
      multiSelect: false,
    }]);
  });

  it.runIf(hasPython)('real hook keeps AskUserQuestion details when Claude emits its permission notification', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-question-notification-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const question = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-question-notify',
        hook_event_name: 'PreToolUse',
        tool_input: {
          questions: [{
            question: 'Which environment?',
            header: 'Deploy',
            options: [
              { label: 'Staging', description: 'Deploy to staging' },
              { label: 'Production', description: 'Deploy to production' },
            ],
          }],
        },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(question.status).toBe(0);

    const notification = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-question-notify',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Permission Prompt',
        message: 'Claude needs your permission',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(notification.status).toBe(0);
    expect(listBlocks(feedDir)).toMatchObject([{
      kind: 'question',
      questions: [{
        text: 'Which environment?',
        header: 'Deploy',
        options: [
          { label: 'Staging', description: 'Deploy to staging' },
          { label: 'Production', description: 'Deploy to production' },
        ],
      }],
    }]);
  });

  it.runIf(hasPython)('real hook ignores notifications that do not represent a wait', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-notification-ignore-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-auth',
        hook_event_name: 'Notification',
        notification_type: 'auth_success',
        message: 'Authentication succeeded',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toEqual([]);
  });

  it.runIf(hasPython)('real hook clears a question after AskUserQuestion completes', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-answer-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-answer',
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-answer',
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clear.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it.runIf(hasPython)('real hook publishes nothing for an idle_prompt — a finished turn is not a request (PHNX-3999)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-idle-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-idle',
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
    // The ask ledger is untouched too: an idle reminder is not an ask.
    expect(fs.existsSync(path.join(feedDir, 'asks'))).toBe(false);
  });

  it.runIf(hasPython)('real hook clears a permission notification when the user answers in the terminal', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-resume-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-perm',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-perm', hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clear.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it.runIf(hasPython)('real hook does NOT clear a declared (--blocked) block on Stop/SessionEnd/PostToolUse', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-declared-persist-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    fs.mkdirSync(feedDir, { recursive: true });
    // `agents feed post --blocked` writes a declared block here (CLI side).
    const agent: DeclaringAgent = {
      sessionId: 'session-declared',
      mailboxId: 'session-declared',
      host: 'testbox',
      runtime: 'headless',
    };
    publishBlock(buildDeclaredBlock(agent, { text: 'npm token expired, cannot publish' }), feedDir);
    expect(listBlocks(feedDir)).toHaveLength(1);
    expect(listBlocks(feedDir)[0].kind).toBe('declared');

    // The agent parks the block and its turn ends: Stop fires, then SessionEnd,
    // and any PostToolUse in between. None may drop it -- the owner still has to
    // answer it, and it must stay in `agents feed` until they do.
    for (const hook_event_name of ['Stop', 'SessionEnd', 'PostToolUse'] as const) {
      const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
        input: JSON.stringify({ session_id: 'session-declared', hook_event_name }),
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      expect(clear.status).toBe(0);
    }
    expect(listBlocks(feedDir).filter(b => b.kind === 'declared')).toHaveLength(1);

    // Contrast: a notification block (harness permission prompt) STILL clears on
    // Stop -- the fix is scoped to declared blocks, not a blanket "never clear on Stop".
    spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-notif',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(listBlocks(feedDir).some(b => b.sessionId === 'session-notif')).toBe(true);
    const clearNotif = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-notif', hook_event_name: 'Stop' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clearNotif.status).toBe(0);
    expect(listBlocks(feedDir).some(b => b.sessionId === 'session-notif')).toBe(false);
    // The declared block for the other session is still present.
    expect(listBlocks(feedDir).filter(b => b.kind === 'declared')).toHaveLength(1);

    // Once the declared block is ANSWERED, a lifecycle clear DOES remove it AND its
    // answered marker -- so a later --blocked in the same session is not falsely
    // locked as already-answered (recordAnswer creates the marker with O_EXCL).
    const declaredBlockId = blockIdForSession('session-declared');
    recordAnswer(declaredBlockId, { answeredFrom: 'terminal' }, feedDir);
    expect(isBlockAnswered(declaredBlockId, feedDir)).toBe(true);
    const clearAnswered = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-declared', hook_event_name: 'Stop' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clearAnswered.status).toBe(0);
    expect(listBlocks(feedDir).some(b => b.sessionId === 'session-declared')).toBe(false);
    expect(isBlockAnswered(declaredBlockId, feedDir)).toBe(false);
  });

  it.runIf(hasPython)('real hook captures multi-operator control metadata', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-controls-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-controls',
        hook_event_name: 'PreToolUse',
        tool_input: {
          questions: [{ question: 'Merge this PR?', options: [{ label: 'Yes' }, { label: 'No' }] }],
          blockClass: 'approval',
          consequence: 'merge',
          allowedOperators: ['muqsit'],
          timeoutMinutes: 15,
          safeDefault: 'No',
          costOfDelay: 'high',
        },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(path.join(home, '.agents', '.history', 'feed'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      blockClass: 'approval',
      consequence: 'merge',
      allowedOperators: ['muqsit'],
      timeoutMinutes: 15,
      safeDefault: 'No',
      costOfDelay: 'high',
    });
  });

  it.runIf(hasPython)('real hook gates Task subagents out', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-subagent-'));
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-subagent',
        agent_type: 'Explore',
        tool_input: { questions: [{ question: 'Should not publish?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(listBlocks(path.join(home, '.agents', '.history', 'feed'))).toEqual([]);
  });

  it('installs the hook without discarding existing YAML comments', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-install-'));
    fs.mkdirSync(userDir, { recursive: true });
    const agentsYaml = path.join(userDir, 'agents.yaml');
    fs.writeFileSync(agentsYaml, 'hooks:\n  # keep this comment\n  existing:\n    agents: [claude]\n    events: [Stop]\n    script: existing.sh\n');
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: true });
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: false });
    const updated = fs.readFileSync(agentsYaml, 'utf-8');
    expect(updated).toContain('# keep this comment');
    expect(updated).toContain('feed-publish:');
    expect(updated).toContain('feed-publish-notification:');
    expect(updated).toContain('feed-publish-permission:');
    expect(updated).toContain('feed-clear-answered:');
    expect(updated).toContain('feed-clear-permission:');
    expect(updated).toContain('feed-clear-lifecycle:');
    expect(fs.readFileSync(path.join(userDir, 'hooks', '10-feed-publish.py'), 'utf-8')).toBe(FEED_PUBLISH_HOOK_SCRIPT);
  });

  it('preserves committed flow-sequence formatting (no [ a, b ] padding) so ~/.agents pulls are not blocked (RUSH-2505)', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-padding-'));
    fs.mkdirSync(userDir, { recursive: true });
    const agentsYaml = path.join(userDir, 'agents.yaml');
    // The committed form uses unpadded flow sequences. The yaml emitter defaults
    // to padded output, so re-writing this file used to flip [claude] -> [ claude ]
    // and leave the git-backed ~/.agents tree permanently dirty, blocking pulls.
    const committed = 'hooks:\n  notify-owner:\n    command: [agents, notify, "{message}"]\n    agents: [claude, codex]\n    events: [Stop]\n    script: notify.sh\n';
    fs.writeFileSync(agentsYaml, committed);
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: true });
    const updated = fs.readFileSync(agentsYaml, 'utf-8');
    // The pre-existing flow sequences must round-trip byte-identically — no padding.
    expect(updated).toContain('command: [agents, notify, "{message}"]');
    expect(updated).toContain('agents: [claude, codex]');
    expect(updated).toContain('events: [Stop]');
    expect(updated).not.toMatch(/\[ /);
    expect(updated).not.toMatch(/ \]/);
    // And the hooks were still added (semantics intact).
    expect(updated).toContain('feed-publish:');
  });

  it('installs feed hooks for codex as well as claude (RUSH-2039)', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-codex-install-'));
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: true });
    const yamlText = fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8');
    // The Codex-only approval hook subscribes to PermissionRequest.
    expect(yamlText).toContain('feed-publish-permission:');
    expect(yamlText).toContain('PermissionRequest');
    // Every feed hook lists codex so its harness parity is documented.
    const doc = yaml.parse(yamlText) as { hooks: Record<string, { agents?: string[] }> };
    for (const name of ['feed-publish', 'feed-publish-notification', 'feed-publish-permission', 'feed-clear-answered', 'feed-clear-permission', 'feed-clear-lifecycle']) {
      expect(doc.hooks[name].agents).toContain('codex');
    }
  });

  it('scopes the matcher-less PostToolUse clear to codex only, leaving Claude unchanged (RUSH-2039)', () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-clear-scope-'));
    expect(ensureFeedPublishHook(userDir)).toEqual({ installed: true });
    const doc = yaml.parse(fs.readFileSync(path.join(userDir, 'agents.yaml'), 'utf-8')) as {
      hooks: Record<string, { agents?: string[]; events?: string[]; matcher?: string }>;
    };
    // feed-clear-permission fires on EVERY PostToolUse (it has no matcher), so
    // registering it for Claude would add per-tool overhead AND delete Claude's
    // notification-kind blocks the moment any later tool runs. Codex-only keeps
    // Claude's card lifetime (persist to Stop/SessionEnd) exactly as before.
    expect(doc.hooks['feed-clear-permission'].agents).toEqual(['codex']);
    expect(doc.hooks['feed-clear-permission'].agents).not.toContain('claude');
    expect(doc.hooks['feed-clear-permission'].matcher).toBeUndefined();
    // The ONLY PostToolUse feed hook Claude still registers is the answered
    // clear, and it is matcher-scoped to AskUserQuestion -- so an unrelated
    // Claude tool completion never touches a notification-kind block.
    expect(doc.hooks['feed-clear-answered'].agents).toContain('claude');
    expect(doc.hooks['feed-clear-answered'].events).toEqual(['PostToolUse']);
    expect(doc.hooks['feed-clear-answered'].matcher).toBe('AskUserQuestion');
    expect(doc.hooks['feed-clear-permission'].events).toEqual(['PostToolUse']);
  });

  it.runIf(hasPython)('a plain PostToolUse clears a notification block at the script level -- which is why Claude must NOT register the matcher-less clear', () => {
    // The script is agent-blind: it clears on hook_event_name alone. So if a
    // matcher-less PostToolUse (any tool completion) were delivered for Claude,
    // it WOULD delete Claude's notification-kind card -- that is the exact
    // regression. This test pins that causal fact at the script level; the
    // manifest test above pins the fix (Claude does not register the hook, so
    // its plain tool completions never reach the script and the card persists
    // to Stop/SessionEnd as it did before RUSH-2039).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-notif-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'notif-clear-sess',
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        title: 'Permission needed',
        message: 'Claude needs permission to use Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toMatchObject([{ kind: 'notification', notificationType: 'permission_prompt' }]);

    // A plain (non-AskUserQuestion) PostToolUse -- what feed-clear-permission
    // delivered for EVERY Claude tool before the fix -- clears the card. The
    // question-guard at feed.ts:546-553 preserves only kind == 'question'.
    const plainPostToolUse = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'notif-clear-sess',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(plainPostToolUse.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it('recordAnswer claims the first answer and rejects later ones', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-answer', 'Which one?'), dir);
    const blockId = blockIdForSession('sess-answer');

    const first = recordAnswer(blockId, { answeredBy: 'operator-a', answeredFrom: 'feed' }, dir);
    expect(first.ok).toBe(true);
    expect(isBlockAnswered(blockId, dir)).toBe(true);
    expect(getAnswerRecord(blockId, dir)).toMatchObject({ answeredFrom: 'feed', answeredBy: 'operator-a' });
    expect(readBlock(blockId, dir)?.answer).toMatchObject({ answeredFrom: 'feed', answeredBy: 'operator-a' });

    const second = recordAnswer(blockId, { answeredBy: 'operator-b', answeredFrom: 'feed' }, dir);
    expect(second.ok).toBe(false);
    if (!second.ok && 'existing' in second) {
      expect(second.existing.answeredBy).toBe('operator-a');
    }
  });

  it('recordAnswer refuses unverified answers to high-consequence blocks', () => {
    const dir = tmpFeedDir();
    // operators.yaml under the feed root must NOT authorize (RUSH-1618) —
    // the registry lives at ~/.agents/operators.yaml only.
    fs.writeFileSync(path.join(dir, 'operators.yaml'), 'operators:\n  muqsit:\n    admin: true\n', 'utf-8');
    publishBlock(makeBlock('sess-authz', 'Deploy to prod?', {
      consequence: 'merge',
      allowedOperators: ['muqsit'],
    }), dir);
    const blockId = blockIdForSession('sess-authz');

    const unverified = recordAnswer(blockId, { answeredFrom: 'feed', answeredBy: 'stranger' }, dir);
    expect(unverified.ok).toBe(false);
    if (!unverified.ok) {
      expect('unauthorized' in unverified).toBe(true);
    }

    // verified:false still refused even with a known-looking operatorId.
    const claimed = recordAnswer(blockId, {
      answeredFrom: 'feed',
      answeredBy: 'Muqsit',
      operatorId: 'muqsit',
      verified: false,
    }, dir);
    expect(claimed.ok).toBe(false);
  });

  it('recordAnswer ignores operators.yaml colocated with the feed store (RUSH-1618)', () => {
    const dir = tmpFeedDir();
    // Only the feed root has operators.yaml — the canonical registry is separate.
    // Claiming verified:true for an id that exists ONLY here must still fail
    // when that id is not in the real ~/.agents registry. Use a unique id.
    fs.writeFileSync(
      path.join(dir, 'operators.yaml'),
      'operators:\n  feed-only-operator-xyz:\n    admin: true\n',
      'utf-8',
    );
    publishBlock(makeBlock('sess-authz-feed', 'Deploy?', { consequence: 'merge' }), dir);
    const blockId = blockIdForSession('sess-authz-feed');
    const result = recordAnswer(blockId, {
      answeredFrom: 'feed',
      operatorId: 'feed-only-operator-xyz',
      verified: true,
    }, dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect('unauthorized' in result).toBe(true);
  });

  it('recordAnswer permits any answer to normal-consequence blocks', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-normal', 'Which color?', { consequence: 'normal' }), dir);
    const blockId = blockIdForSession('sess-normal');
    expect(recordAnswer(blockId, { answeredFrom: 'feed', answeredBy: 'anyone' }, dir).ok).toBe(true);
  });

  it('recordMessageReceipt tracks queued → consumed → continued lifecycle', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-receipt', 'Confirm?'), dir);
    const blockId = blockIdForSession('sess-receipt');

    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'queued', at: '2026-01-01T00:00:00.000Z' }, dir);
    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'consumed', at: '2026-01-01T00:00:01.000Z' }, dir);
    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'continued', at: '2026-01-01T00:00:02.000Z' }, dir);
    recordContinued(blockId, dir);

    const block = readBlock(blockId, dir)!;
    expect(block.receipts).toHaveLength(1);
    expect(block.receipts![0]).toMatchObject({ msgId: 'msg-1', status: 'continued' });
    expect(block.continuedAt).toBeTruthy();
  });

  it('recordMessageReceipt is monotonic — queued cannot overwrite consumed (RUSH-1614)', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-mono', 'Confirm?'), dir);
    const blockId = blockIdForSession('sess-mono');

    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'consumed', at: '2026-01-01T00:00:01.000Z' }, dir);
    // Late enqueue writer races after drain already recorded consumed.
    recordMessageReceipt(blockId, { msgId: 'msg-1', status: 'queued', at: '2026-01-01T00:00:02.000Z' }, dir);

    const block = readBlock(blockId, dir)!;
    expect(block.receipts).toHaveLength(1);
    expect(block.receipts![0].status).toBe('consumed');
  });

  it('removeBlock clears answered markers and receipts', () => {
    const dir = tmpFeedDir();
    publishBlock(makeBlock('sess-cleanup', 'Clean me?'), dir);
    const blockId = blockIdForSession('sess-cleanup');
    recordAnswer(blockId, { answeredFrom: 'feed' }, dir);
    recordMessageReceipt(blockId, { msgId: 'm', status: 'queued', at: new Date().toISOString() }, dir);

    expect(removeBlock(blockId, dir)).toBe(true);
    expect(listBlocks(dir)).toHaveLength(0);
    expect(isBlockAnswered(blockId, dir)).toBe(false);
  });

  it.runIf(hasPython)('real hook records terminal answers and removes the visible block', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-terminal-answer-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'session-terminal',
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: 'session-terminal', hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
    expect(isBlockAnswered('block-session-terminal', feedDir)).toBe(true);
    expect(getAnswerRecord('block-session-terminal', feedDir)).toMatchObject({ answeredFrom: 'terminal' });
  });

  it.runIf(hasPython)('real hook UserPromptSubmit writes an answered tombstone so a stale re-read cannot resurrect (PHNX-3074)', () => {
    // The Python terminal-answer path used to unlink the block with no
    // resolutions/<id>.json tombstone. Once reconcileAttention is on the
    // read path, a session engine still reporting waiting_input at the same
    // cursor would resurrect the answered ask. This is the producer-side
    // match of TS recordAnswer: tombstone BEFORE unlink.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-terminal-tombstone-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const sessionId = 'session-tombstone';
    const blockId = blockIdForSession(sessionId);

    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    const published = listBlocks(feedDir)[0];
    expect(published).toBeDefined();
    expect(published.sourceCursor?.lastActivityMs).toEqual(expect.any(Number));

    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
    expect(isBlockAnswered(blockId, feedDir)).toBe(true);

    const tombstone = readResolution(blockId, feedDir);
    expect(tombstone).toMatchObject({
      blockId,
      generation: published.ts,
      reason: 'answered',
      sourceCursor: published.sourceCursor,
    });
    expect(tombstone?.resolvedAt).toEqual(expect.any(String));

    const cursorMs = published.sourceCursor!.lastActivityMs!;
    const staleSession = {
      context: 'terminal',
      kind: 'claude',
      status: 'running',
      host: published.host,
      sessionId,
      activity: 'waiting_input',
      awaitingReason: 'question',
      question: { text: 'Choose?', reason: 'question', options: [{ label: 'A' }] },
      lastActivityMs: cursorMs,
    } as ActiveSession;

    // Same cursor as the answered generation: a stale re-read, must stay gone.
    expect(reconcileAttention({
      session: staleSession,
      resolution: tombstone,
      nowMs: cursorMs + 10_000,
    })).toBeUndefined();

    // A strictly later turn is a new generation and is allowed through.
    const fresh = reconcileAttention({
      session: { ...staleSession, lastActivityMs: cursorMs + 1, question: { text: 'A later ask?', reason: 'question' } },
      resolution: tombstone,
      nowMs: cursorMs + 10_000,
    });
    expect(fresh).toBeDefined();
    expect(fresh!.key).toBe(`${published.host}/${sessionId}/t${cursorMs + 1}`);
  });

  it.runIf(hasPython)('real hook clears stale answered marker when a new question is published', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-new-question-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const sessionId = 'session-new-q';
    const blockId = blockIdForSession(sessionId);

    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'First?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);

    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit' }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(isBlockAnswered(blockId, feedDir)).toBe(true);

    const republish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Second?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(republish.status).toBe(0);
    expect(isBlockAnswered(blockId, feedDir)).toBe(false);
    expect(listBlocks(feedDir)).toMatchObject([{ questions: [{ text: 'Second?' }] }]);
  });

  // --- RUSH-2039: Codex approval prompts publish urgent feed blocks ---------

  it.runIf(hasPython)('real hook publishes a Codex PermissionRequest as an urgent approval block', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-codex-perm-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const result = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'codex-sess-1',
        hook_event_name: 'PermissionRequest',
        permission_mode: 'default',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
      }),
      env: { ...process.env, HOME: home, AGENTS_RUNTIME: 'headless' },
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    const blocks = listBlocks(feedDir);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      kind: 'notification',
      notificationType: 'permission_prompt',
      blockClass: 'approval',
      costOfDelay: 'high',
      safeDefault: 'deny',
    });
    // The block names the tool and its command so the operator can judge it.
    expect(blocks[0].questions[0].text).toContain('Bash');
    expect(blocks[0].questions[0].text).toContain('rm -rf build');
    expect(blocks[0].questions[0].header).toBe('Approval needed');
  });

  it.runIf(hasPython)('real hook clears a Codex approval block once the approved tool runs', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-codex-clear-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'codex-sess-2',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    // Codex runs the approved tool -> matcher-less PostToolUse clears the card.
    const clear = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'codex-sess-2',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(clear.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it.runIf(hasPython)('matcher-less PostToolUse does not wipe an open AskUserQuestion mid-turn', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-feed-question-guard-'));
    const feedDir = path.join(home, '.agents', '.history', 'feed');
    const publish = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'sess-q-guard',
        hook_event_name: 'PreToolUse',
        tool_input: { questions: [{ question: 'Which approach?' }] },
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(publish.status).toBe(0);
    expect(listBlocks(feedDir)).toHaveLength(1);

    // An unrelated tool completing must NOT clear the open question.
    const unrelated = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'sess-q-guard',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(unrelated.status).toBe(0);
    expect(listBlocks(feedDir)).toMatchObject([{ kind: 'question', questions: [{ text: 'Which approach?' }] }]);

    // The AskUserQuestion PostToolUse still clears it.
    const answer = spawnSync('python3', ['-c', FEED_PUBLISH_HOOK_SCRIPT], {
      input: JSON.stringify({
        session_id: 'sess-q-guard',
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
      }),
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(answer.status).toBe(0);
    expect(listBlocks(feedDir)).toEqual([]);
  });

  it('feed --dispatch classifies a Codex approval block as urgent and surfaces it', () => {
    // Mirror the block the hook publishes for a Codex PermissionRequest.
    const block = makeBlock('codex-dispatch', 'Codex needs approval to run Bash: rm -rf build', {
      runtime: 'headless',
      kind: 'notification',
      notificationType: 'permission_prompt',
      blockClass: 'approval',
      costOfDelay: 'high',
      safeDefault: 'deny',
      questions: [{ text: 'Codex needs approval to run Bash: rm -rf build', header: 'Approval needed' }],
    });

    // Not suppressed as a stall, and classified as an approval.
    const filtered = filterBlocksForFeed([block]);
    expect(filtered.surfaced).toHaveLength(1);
    expect(classifyBlock(block).class).toBe('approval');

    // Urgent under the default policy (costOfDelay high >= threshold medium).
    expect(isPhoneUrgent(block, DEFAULT_POLICY)).toBe(true);
  });
});
