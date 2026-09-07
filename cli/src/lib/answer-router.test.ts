import { describe, expect, it } from 'vitest';
import {
  isOpenQuestionBlock,
  isParkedOnInput,
  keystrokesForAnswer,
  matchOptionIndex,
  resolveAnswerRoute,
  resumeArgv,
} from './answer-router.js';
import type { OpenBlock } from './feed/feed.js';
import type { ActiveSession } from './session/active.js';

function block(over: Partial<OpenBlock> = {}): OpenBlock {
  return {
    blockId: 'block-s1',
    sessionId: 's1',
    mailboxId: 's1',
    host: 'zion',
    runtime: 'claude',
    ts: new Date().toISOString(),
    questions: [{
      text: 'Which env?',
      options: [
        { label: 'Staging' },
        { label: 'Production' },
        { label: 'Other' },
      ],
    }],
    ...over,
  };
}

function session(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    sessionId: 's1',
    status: 'running',
    ...over,
  } as ActiveSession;
}

describe('matchOptionIndex / keystrokesForAnswer', () => {
  const opts = [{ label: 'Staging' }, { label: 'Production' }, { label: 'Other' }];

  it('matches exact, prefix, and contains labels', () => {
    expect(matchOptionIndex('Staging', opts)).toBe(0);
    expect(matchOptionIndex('prod', opts)).toBe(1);
    expect(matchOptionIndex('duction', opts)).toBe(1);
    expect(matchOptionIndex('nope', opts)).toBe(-1);
  });

  it('emits a 1-based digit for a matched option', () => {
    expect(keystrokesForAnswer('Production', opts)).toEqual({ payload: '2', matched: 'option' });
  });

  it('routes free text through Other when present', () => {
    expect(keystrokesForAnswer('canary-eu', opts)).toEqual({
      payload: '3\ncanary-eu',
      matched: 'other',
    });
  });

  it('falls back to free-text payload when no Other option', () => {
    expect(keystrokesForAnswer('maybe', [{ label: 'Yes' }, { label: 'No' }])).toEqual({
      payload: 'maybe',
      matched: 'free-text',
    });
  });

  it('delivers a real Escape byte (no trailing Enter) for the esc cancel token', () => {
    // A deny / send-back choice carries deliveryKey 'esc'. It must dismiss the
    // prompt with an actual Escape keystroke, not type the letters e-s-c which a
    // trailing Enter would then submit — potentially confirming the default.
    expect(keystrokesForAnswer('esc')).toEqual({ payload: '\u001b', matched: 'other', enter: false });
    expect(keystrokesForAnswer('Escape')).toEqual({ payload: '\u001b', matched: 'other', enter: false });
  });

  it('lets an option literally labelled "esc" win as a selection over the cancel token', () => {
    expect(keystrokesForAnswer('esc', [{ label: 'esc' }, { label: 'other' }])).toEqual({
      payload: '1',
      matched: 'option',
    });
  });
});

describe('isParkedOnInput / isOpenQuestionBlock', () => {
  it('detects parked states', () => {
    expect(isParkedOnInput(session({ status: 'input_required' }))).toBe(true);
    expect(isParkedOnInput(session({ activity: 'waiting_input' }))).toBe(true);
    expect(isParkedOnInput(session({ awaitingReason: 'question' }))).toBe(true);
    expect(isParkedOnInput(session({ activity: 'working', status: 'running' }))).toBe(false);
    expect(isParkedOnInput(null)).toBe(false);
  });

  it('detects still-open blocks', () => {
    expect(isOpenQuestionBlock(block())).toBe(true);
    expect(isOpenQuestionBlock(block({ answer: { answeredAt: 't', answeredFrom: 'cli' } }))).toBe(false);
    expect(isOpenQuestionBlock(block({ parkedAt: 't' }))).toBe(false);
    expect(isOpenQuestionBlock(null)).toBe(false);
  });
});

describe('resolveAnswerRoute', () => {
  it('uses mailbox for a running agent with no open question', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'keep going',
      session: session({ activity: 'working' }),
      block: null,
    });
    expect(r.kind).toBe('mailbox');
  });

  it('uses mailbox when there is an open block but the agent is still working', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'Staging',
      session: session({ activity: 'working', status: 'running' }),
      block: block(),
    });
    expect(r.kind).toBe('mailbox');
  });

  it('drives tmux when parked with a tmux reply rail', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'Staging',
      block: block(),
      session: session({
        activity: 'waiting_input',
        awaitingReason: 'question',
        provenance: {
          host: 'zion',
          transport: 'local',
          reply: { rail: 'tmux', target: '%3', socket: '/tmp/tmux-1' },
        },
      }),
    });
    expect(r.kind).toBe('tmux');
    expect(r.payload).toBe('1');
    expect(r.inject).toEqual({ backend: 'tmux', pane: '%3', socket: '/tmp/tmux-1' });
    // A normal selection keeps the default Enter (omitted).
    expect(r.enter).toBeUndefined();
  });

  it('carries enter:false with a real Escape payload when the answer is the esc cancel token', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'esc',
      block: block(),
      session: session({
        activity: 'waiting_input',
        awaitingReason: 'permission',
        provenance: {
          host: 'zion',
          transport: 'local',
          reply: { rail: 'tmux', target: '%3', socket: '/tmp/tmux-1' },
        },
      }),
    });
    expect(r.kind).toBe('tmux');
    expect(r.payload).toBe('\u001b');
    expect(r.enter).toBe(false);
  });

  it('drives pty when parked headless with session id', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'Production',
      block: block(),
      session: session({
        context: 'headless',
        activity: 'waiting_input',
        status: 'input_required',
      }),
    });
    // headless with no rail still prefers resume over pty unless host is pty
    expect(r.kind).toBe('resume');
    expect(r.resume).toEqual({ sessionId: 's1', agent: 'claude' });
    expect(r.payload).toBe('Production');
  });

  it('uses pty backend when host is pty', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'Staging',
      block: block(),
      session: session({
        host: 'pty',
        context: 'headless',
        activity: 'waiting_input',
        status: 'input_required',
      }),
    });
    expect(r.kind).toBe('pty');
    expect(r.inject).toEqual({ backend: 'pty', id: 's1' });
  });

  it('refuses a parked interactive agent with no rail and surfaces a recovery hint', () => {
    const r = resolveAnswerRoute({
      mailboxId: 's1',
      answer: 'Staging',
      block: block(),
      session: session({
        context: 'terminal',
        tty: 'ttys001',
        activity: 'waiting_input',
        provenance: { host: 'zion', transport: 'local', reply: null },
      }),
    });
    expect(r.kind).toBe('refuse');
    expect(r.reason).toMatch(/no addressable terminal/i);
    expect(r.reason).toContain('agents sessions resume');
    expect(r.reason).toContain('tmux');
  });
});

describe('resumeArgv', () => {
  it('builds agents run --resume argv', () => {
    expect(resumeArgv({
      kind: 'resume',
      reason: 'x',
      payload: 'go',
      resume: { sessionId: 'abc', agent: 'claude' },
    })).toEqual(['run', 'claude', '--resume', 'abc', '--', 'go']);
  });
});
