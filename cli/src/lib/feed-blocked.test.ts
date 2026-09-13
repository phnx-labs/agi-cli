/**
 * `agents feed post --blocked` — the declared-block path.
 *
 * Real path throughout: a block is built from a real posted event, written to a
 * real temp feed dir, read back with the real reader, and planned against a real
 * sink config. Nothing is mocked.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDeclaredBlock, publishBlock, listBlocks, type DeclaringAgent } from './feed/feed.js';
import { blockBroadcastContext, planFeedBroadcast, renderSinkArgv, blockDeliveryFailure } from './feed-broadcast.js';
import { MILESTONE_EVENTS, tierForEvent } from './feed/activity.js';

const AGENT: DeclaringAgent = {
  sessionId: '74a4893f-63b3-49ef-bbcb-2437914f792e',
  mailboxId: '74a4893f-63b3-49ef-bbcb-2437914f792e',
  host: 'yosemite-s1',
  runtime: 'headless',
};

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-blocked-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('status.blocked event kind', () => {
  // A blocked post must rank as a milestone, not routine activity — readers
  // collapse `activity` tier to counts, which would bury the one thing that
  // needs a human.
  it('is a milestone, so readers never collapse it into a count', () => {
    expect(MILESTONE_EVENTS).toContain('status.blocked');
    expect(tierForEvent('status.blocked')).toBe('milestone');
  });
});

describe('buildDeclaredBlock', () => {
  it('derives approval from a safe default and decision without one', () => {
    const decision = buildDeclaredBlock(AGENT, { text: 'publish or wait?' });
    expect(decision.blockClass).toBe('decision');
    expect(decision.safeDefault).toBeUndefined();

    const approval = buildDeclaredBlock(AGENT, { text: 'delete stale env?', safeDefault: 'leave it' });
    expect(approval.blockClass).toBe('approval');
    expect(approval.safeDefault).toBe('leave it');
  });

  // costOfDelay drives the urgency filter (isPhoneUrgent). A declared block is by
  // definition an agent that has stopped, so it must not rank as low-cost.
  it('marks a declared block high cost-of-delay', () => {
    expect(buildDeclaredBlock(AGENT, { text: 'stuck' }).costOfDelay).toBe('high');
    expect(buildDeclaredBlock(AGENT, { text: 'stuck' }).kind).toBe('declared');
  });

  it('carries answerable options through as BlockOptions', () => {
    const b = buildDeclaredBlock(AGENT, { text: 'pick', options: ['publish', ' wait ', ''] });
    expect(b.questions[0].options).toEqual([{ label: 'publish' }, { label: 'wait' }]);
  });

  it('refuses empty text rather than opening a block nobody can act on', () => {
    expect(() => buildDeclaredBlock(AGENT, { text: '   ' })).toThrow(/empty/i);
  });

  it('round-trips through the real store and is readable as an open block', () => {
    const block = buildDeclaredBlock(AGENT, { text: 'force-push denied by git-guard on PR #1749' });
    publishBlock(block, root);
    const read = listBlocks(root);
    expect(read).toHaveLength(1);
    expect(read[0].kind).toBe('declared');
    expect(read[0].questions[0].text).toBe('force-push denied by git-guard on PR #1749');
    expect(read[0].sessionId).toBe(AGENT.sessionId);
    expect(read[0].sourceCursor).toEqual({ lastActivityMs: Date.parse(block.ts) });
  });
});

describe('blockBroadcastContext', () => {
  const block = buildDeclaredBlock(AGENT, { text: 'npm token expired, cannot publish' });

  it('always broadcasts a block at important — the state implies the volume', () => {
    expect(blockBroadcastContext(block).level).toBe('important');
  });

  // The operator reading this on a phone should not have to go find the session.
  it('carries the exact command that unblocks it', () => {
    const ctx = blockBroadcastContext(block);
    expect(ctx.focus).toBe('agents focus 74a4893f');
  });

  // A sink gated on minLevel:important must actually receive a block. Before this
  // wiring, publishBlock never reached the broadcast layer at all.
  it('reaches an important-gated sink, with the ask in the message', () => {
    const planned = planFeedBroadcast(
      { owner: { channel: 'owner', minLevel: 'important' } },
      blockBroadcastContext(block, { project: 'agents-cli' }),
    );
    expect(planned).toHaveLength(1);
    const message = planned[0].text!;
    // Title/body when extras provide them; footer names the box + session.
    expect(message).toContain('npm token expired, cannot publish');
    expect(message).toContain('Sent from');
    expect(message).toContain('yosemite-s1');
  });

  // The phone message must be actionable WITHOUT a CLI: it shows the choices and
  // the default-on-timeout, and never `agents focus <id>` (unusable from a phone).
  it('renders options + default-on-timeout, and NOT a CLI reply command', () => {
    const withChoices = buildDeclaredBlock(AGENT, {
      text: 'publish now or wait for review?',
      options: ['publish', 'wait'],
      safeDefault: 'wait',
      timeoutMinutes: 15,
    });
    const message = renderSinkArgv(['{message}'], blockBroadcastContext(withChoices))![0];
    expect(message).toContain('publish now or wait for review?');
    expect(message).toContain('Options: publish / wait');
    expect(message).toContain('Default in 15 min: wait');
    expect(message).not.toContain('agents focus');
  });

  // A decision block with no default still shows its choices, but no default line.
  it('shows choices without a default line when the block has no safe default', () => {
    const noDefault = buildDeclaredBlock(AGENT, { text: 'which config?', options: ['a', 'b'] });
    const message = renderSinkArgv(['{message}'], blockBroadcastContext(noDefault))![0];
    expect(message).toContain('Options: a / b');
    expect(message).not.toContain('Default');
    expect(message).not.toContain('agents focus');
  });

  // The placeholder regex is /\{([a-z]+)\}/g — lowercase only. A camelCase name
  // would never substitute, and renderSinkArgv would silently skip the sink.
  it('exposes block placeholders that the lowercase-only regex can actually match', () => {
    const argv = renderSinkArgv(['x', '{focus}', '{class}', '{cost}', '{block}'], blockBroadcastContext(block));
    expect(argv).toBeDefined();
    expect(argv!.slice(1)).toEqual([
      'agents focus 74a4893f',
      'decision',
      'high',
      block.blockId,
    ]);
  });

  // A status post has no focus command, so the sink must still render for it.
  it('leaves a plain post without a focus line (title + body + footer only)', () => {
    const argv = renderSinkArgv(['{message}'], {
      title: 'CI green',
      text: 'all checks passed',
      level: 'milestone',
      agent: 'grok',
      host: 'mac-mini',
      session: 'aabbccdd-0000-0000-0000-000000000001',
    });
    expect(argv![0]).toContain('CI green');
    expect(argv![0]).toContain('all checks passed');
    expect(argv![0]).toContain('Sent from grok/aabbccdd on mac-mini');
    expect(argv![0]).not.toContain('agents focus');
  });
});

describe('blockDeliveryFailure — the fail-loud contract', () => {
  const ok = { name: 'owner', ok: true };
  const bad = { name: 'owner', ok: false, error: 'rush CLI not found on PATH' };

  // This lived inline in the command action and was therefore never covered,
  // which is exactly how a `--json` early-return silently bypassed it: the
  // machine caller — the one that actually reads the exit code — got 0 while a
  // human got 1. Reviewer caught it; this pins the contract in a pure function.
  it('reports failure when no sink is configured', () => {
    expect(blockDeliveryFailure(true, [])).toMatch(/no feed\.broadcast sink configured/);
  });

  it('reports failure, with the reason, when every sink failed', () => {
    const msg = blockDeliveryFailure(true, [bad, { name: 'other', ok: false, error: 'daemon down' }]);
    expect(msg).toMatch(/every feed\.broadcast sink failed/);
    expect(msg).toContain('rush CLI not found on PATH');
    expect(msg).toContain('daemon down');
  });

  // Redundant channels are the whole point: a dead rush login must not mask a
  // delivered desktop notification.
  it('stays silent when at least one sink got through', () => {
    expect(blockDeliveryFailure(true, [bad, ok])).toBeUndefined();
    expect(blockDeliveryFailure(true, [ok])).toBeUndefined();
  });

  // A plain status post is fire-and-forget; an unconfigured sink is not an error.
  it('never fails a non-blocked post', () => {
    expect(blockDeliveryFailure(false, [])).toBeUndefined();
    expect(blockDeliveryFailure(false, [bad])).toBeUndefined();
  });
});
