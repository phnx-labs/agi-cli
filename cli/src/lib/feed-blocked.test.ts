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

  it('carries the exact command that unblocks it', () => {
    const ctx = blockBroadcastContext(block);
    expect(ctx.focus).toBe('agents focus 74a4893f');
  });

  it('reaches an important-gated sink, with the ask in the message', () => {
    const planned = planFeedBroadcast(
      { owner: { channel: 'owner', minLevel: 'important' } },
      blockBroadcastContext(block, { project: 'agents-cli' }),
    );
    expect(planned).toHaveLength(1);
    const message = planned[0].text!;
    expect(message).toContain('npm token expired, cannot publish');
    expect(message).toContain('Sent from');
    expect(message).toContain('yosemite-s1');
  });

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

  it('shows choices without a default line when the block has no safe default', () => {
    const noDefault = buildDeclaredBlock(AGENT, { text: 'which config?', options: ['a', 'b'] });
    const message = renderSinkArgv(['{message}'], blockBroadcastContext(noDefault))![0];
    expect(message).toContain('Options: a / b');
    expect(message).not.toContain('Default');
    expect(message).not.toContain('agents focus');
  });

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

  it('reports failure when no sink is configured', () => {
    expect(blockDeliveryFailure(true, [])).toMatch(/no feed\.broadcast sink configured/);
  });

  it('reports failure, with the reason, when every sink failed', () => {
    const msg = blockDeliveryFailure(true, [bad, { name: 'other', ok: false, error: 'daemon down' }]);
    expect(msg).toMatch(/every feed\.broadcast sink failed/);
    expect(msg).toContain('rush CLI not found on PATH');
    expect(msg).toContain('daemon down');
  });

  it('stays silent when at least one sink got through', () => {
    expect(blockDeliveryFailure(true, [bad, ok])).toBeUndefined();
    expect(blockDeliveryFailure(true, [ok])).toBeUndefined();
  });

  it('never fails a non-blocked post', () => {
    expect(blockDeliveryFailure(false, [])).toBeUndefined();
    expect(blockDeliveryFailure(false, [bad])).toBeUndefined();
  });
});
