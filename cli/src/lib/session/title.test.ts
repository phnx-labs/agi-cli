/**
 * Pure title logic (PHNX-3797): the prompt, the sanitizer, the source key that
 * makes generation once-per-session, and the shared headline ladder.
 */
import { describe, expect, it } from 'vitest';
import {
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_MAX_WORDS,
  SESSION_TITLE_PROMPT_MARKER,
  isSessionTitlePrompt,
  renderSessionTitlePrompt,
  sanitizeGeneratedTitle,
  selectSessionsNeedingTitle,
  sessionHeadline,
  sessionTitleSourceKey,
} from './title.js';
import type { SessionTitleCandidateRow } from './db.js';

function candidate(over: Partial<SessionTitleCandidateRow> = {}): SessionTitleCandidateRow {
  return {
    id: 'sess-1',
    agent: 'claude',
    cwd: '/repo',
    project: 'agents-cli',
    topic: 'fix the recap ladder',
    firstUserMessage: 'The sessions list headline shows the agent last message; fix it',
    label: null,
    ticketId: 'PHNX-3797',
    gitBranch: 'phnx-3797',
    generatedTitle: null,
    generatedTitleKey: null,
    ...over,
  };
}

describe('sessionHeadline (the one ladder every surface reads)', () => {
  it('a /rename label wins over a generated title', () => {
    expect(sessionHeadline({ label: 'ship the auth fix', generatedTitle: 'Auth token refresh', topic: 'do auth' }))
      .toBe('ship the auth fix');
  });

  it('the generated title wins over the raw first-prompt topic', () => {
    expect(sessionHeadline({ generatedTitle: 'Session title ladder fix', topic: 'the headline is wrong, fix it' }))
      .toBe('Session title ladder fix');
  });

  it('falls back to the topic — never to an agent line — when nothing is generated yet', () => {
    expect(sessionHeadline({ topic: 'the headline is wrong, fix it' })).toBe('the headline is wrong, fix it');
    expect(sessionHeadline({})).toBeUndefined();
  });
});

describe('sessionTitleSourceKey', () => {
  it('is stable for the same user text and different when it changes', () => {
    const a = sessionTitleSourceKey({ firstUserMessage: 'fix   the ladder\n' });
    const b = sessionTitleSourceKey({ firstUserMessage: 'fix the ladder' });
    const c = sessionTitleSourceKey({ firstUserMessage: 'fix the OTHER ladder' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('falls back to the topic, and is null when there is no user text to title', () => {
    expect(sessionTitleSourceKey({ topic: 'something' })).toEqual(expect.any(String));
    expect(sessionTitleSourceKey({ firstUserMessage: '   ', topic: null })).toBeNull();
  });
});

describe('renderSessionTitlePrompt', () => {
  it('carries the marker, the user text, and the technical context', () => {
    const prompt = renderSessionTitlePrompt({
      firstUserMessage: 'the sessions list headline is wrong',
      project: 'agents-cli',
      ticketId: 'PHNX-3797',
      gitBranch: 'phnx-3797-session-title',
    });
    expect(prompt).toContain(SESSION_TITLE_PROMPT_MARKER);
    expect(prompt).toContain('the sessions list headline is wrong');
    expect(prompt).toContain('Repository: agents-cli');
    expect(prompt).toContain('Ticket: PHNX-3797');
    expect(prompt).toContain('Branch: phnx-3797-session-title');
    // The marker is what keeps the titler from titling its own spawned session.
    expect(isSessionTitlePrompt(prompt)).toBe(true);
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('keeps the first line and strips quoting/punctuation noise', () => {
    expect(sanitizeGeneratedTitle('"Session title ladder fix."\nSome explanation'))
      .toBe('Session title ladder fix');
    expect(sanitizeGeneratedTitle('  **Fleet mirror preview sync**  ')).toBe('Fleet mirror preview sync');
  });

  it('bounds a model that ignored the word budget', () => {
    const long = sanitizeGeneratedTitle('one two three four five six seven eight nine ten')!;
    expect(long.split(' ')).toHaveLength(SESSION_TITLE_MAX_WORDS);
    const wide = sanitizeGeneratedTitle('x'.repeat(200))!;
    expect(wide.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
  });

  it('returns nothing for an empty reply or an echoed prompt', () => {
    expect(sanitizeGeneratedTitle('')).toBeUndefined();
    expect(sanitizeGeneratedTitle('\n \n')).toBeUndefined();
    expect(sanitizeGeneratedTitle(`${SESSION_TITLE_PROMPT_MARKER} naming what this session did`)).toBeUndefined();
  });
});

describe('selectSessionsNeedingTitle (generate once, then cache-hit)', () => {
  it('picks an untitled row', () => {
    const { pending, cached } = selectSessionsNeedingTitle([candidate()], { limit: 5 });
    expect(pending).toHaveLength(1);
    expect(cached).toBe(0);
  });

  it('skips a row already titled for its CURRENT user text', () => {
    const row = candidate();
    const key = sessionTitleSourceKey(row)!;
    const { pending, cached } = selectSessionsNeedingTitle(
      [{ ...row, generatedTitle: 'Recap ladder fix', generatedTitleKey: key }],
      { limit: 5 },
    );
    expect(pending).toHaveLength(0);
    expect(cached).toBe(1);
  });

  it('re-titles when the first user message changed under a stored title', () => {
    const { pending } = selectSessionsNeedingTitle(
      [candidate({ generatedTitle: 'Recap ladder fix', generatedTitleKey: 'stale-key' })],
      { limit: 5 },
    );
    expect(pending).toHaveLength(1);
  });

  it('re-titles a current row only when forced', () => {
    const row = candidate();
    const key = sessionTitleSourceKey(row)!;
    const titled = { ...row, generatedTitle: 'Recap ladder fix', generatedTitleKey: key };
    expect(selectSessionsNeedingTitle([titled], { limit: 5, force: true }).pending).toHaveLength(1);
  });

  it('never queues the titler\'s OWN session — that would spawn one more forever', () => {
    const own = candidate({
      id: 'titler-run',
      firstUserMessage: `${SESSION_TITLE_PROMPT_MARKER} naming what this coding session worked on.`,
      topic: SESSION_TITLE_PROMPT_MARKER,
    });
    const { pending } = selectSessionsNeedingTitle([own], { limit: 5 });
    expect(pending).toHaveLength(0);
  });

  it('skips a row with no user text at all, and honours the batch limit', () => {
    const rows = [
      candidate({ id: 'blank', firstUserMessage: null, topic: null }),
      candidate({ id: 'a' }),
      candidate({ id: 'b', firstUserMessage: 'another request entirely' }),
    ];
    const { pending } = selectSessionsNeedingTitle(rows, { limit: 1 });
    expect(pending.map((p) => p.row.id)).toEqual(['a']);
  });
});
