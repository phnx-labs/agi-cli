/** Tests the pure helpers that enrich the default `agents sessions` listing with live state.
 * Correlating a historical row to a running session hinges on the full-UUID key, and the glyph
 * must reflect the coarse status; both are subtle, so they are tested directly. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { indexActiveBySessionId, liveGlyphAndPreview, formatActiveRowDescription } from '../ps-roster.js';
import type { ActiveSession } from '../../lib/session/active.js';

function mk(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    context: 'terminal',
    kind: 'claude',
    status: 'running',
    ...overrides,
  };
}

describe('indexActiveBySessionId', () => {
  it('keys by the full session UUID', () => {
    const a = mk({ sessionId: 'abc12345-def6-7890-1234-567890abcdef' });
    const idx = indexActiveBySessionId([a]);
    expect(idx.get('abc12345-def6-7890-1234-567890abcdef')).toBe(a);
    expect(idx.get('abc12345')).toBeUndefined();
  });

  it('skips sessions without a sessionId (uncorrelatable probes)', () => {
    const idx = indexActiveBySessionId([
      mk({ sessionId: undefined, context: 'cloud' }),
      mk({ sessionId: 'keep-me' }),
    ]);
    expect(idx.size).toBe(1);
    expect(idx.has('keep-me')).toBe(true);
  });

  it('last write wins when a sessionId repeats', () => {
    const first = mk({ sessionId: 'dup', preview: 'first' });
    const second = mk({ sessionId: 'dup', preview: 'second' });
    const idx = indexActiveBySessionId([first, second]);
    expect(idx.get('dup')).toBe(second);
  });
});

describe('liveGlyphAndPreview', () => {
  it('returns empty strings for no live match (plain historical row)', () => {
    expect(liveGlyphAndPreview(undefined)).toEqual({ glyph: '', preview: '' });
  });

  it('running → ● and the state-engine preview', () => {
    const { glyph, preview } = liveGlyphAndPreview(mk({ status: 'running', preview: 'editing sessions.ts' }));
    expect(glyph).toContain('●');
    expect(preview).toBe('editing sessions.ts');
  });

  it('waiting on input → ◐ (both status and activity forms)', () => {
    expect(liveGlyphAndPreview(mk({ status: 'input_required' })).glyph).toContain('◐');
    expect(liveGlyphAndPreview(mk({ status: 'running', activity: 'waiting_input' })).glyph).toContain('◐');
  });

  it('idle → ○', () => {
    expect(liveGlyphAndPreview(mk({ status: 'idle' })).glyph).toContain('○');
  });

  it('unknown → ◌ (a distinct glyph, never the ○ idle it used to be faked as)', () => {
    const glyph = liveGlyphAndPreview(mk({ status: 'unknown' })).glyph;
    expect(glyph).toContain('◌');
    expect(glyph).not.toContain('○');
  });

  it('lifecycle status wins over stale parsed activity in the glyph', () => {
    expect(liveGlyphAndPreview(mk({ status: 'closed', activity: 'working' })).glyph).toContain('×');
    expect(liveGlyphAndPreview(mk({ status: 'abandoned', activity: 'waiting_input' })).glyph).toContain('⊘');
  });

  it('preview falls back to label then topic when there is no live preview', () => {
    expect(liveGlyphAndPreview(mk({ status: 'running', label: 'my-task' })).preview).toBe('my-task');
    expect(liveGlyphAndPreview(mk({ status: 'running', topic: 'first prompt' })).preview).toBe('first prompt');
  });

  it('prepends compact checklist progress when ActiveSession.todos is set (RUSH-2045)', () => {
    const todos = {
      items: [
        { content: 'a', status: 'completed' as const },
        { content: 'b', status: 'in_progress' as const, activeForm: 'A5 wiring runner' },
      ],
      done: 1,
      total: 2,
      activeForm: 'A5 wiring runner',
    };
    expect(
      liveGlyphAndPreview(mk({ status: 'running', preview: 'editing sessions.ts', todos })).preview,
    ).toBe('✓1/2 · A5 wiring runner · editing sessions.ts');
    expect(
      liveGlyphAndPreview(
        mk({
          context: 'teams',
          teamName: 'checklists',
          status: 'running',
          preview: 'wiring runner',
          todos,
        }),
      ).preview,
    ).toBe('checklists · ✓1/2 · A5 wiring runner · wiring runner');
    expect(liveGlyphAndPreview(mk({ status: 'running', todos })).preview).toBe(
      '✓1/2 · A5 wiring runner',
    );
  });
});

describe('formatActiveRowDescription (RUSH-2045)', () => {
  const savedTerm = process.env.TERM_PROGRAM;
  const savedIsTTY = process.stdout.isTTY;

  beforeAll(() => {
    process.env.TERM_PROGRAM = 'test';
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  });
  afterAll(() => {
    if (savedTerm === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = savedTerm;
    Object.defineProperty(process.stdout, 'isTTY', { value: savedIsTTY, configurable: true });
  });

  it('keeps project OSC 8 hyperlinks (does not run linkUrl through cleanPreview)', () => {
    const desc = formatActiveRowDescription(
      mk({
        status: 'running',
        label: 'views',
        cwd: '/home/u/src/github.com/phnx-labs/agents-cli/cli',
        preview: 'editing sessions.ts',
        todos: { items: [], done: 1, total: 2, activeForm: 'A5 wiring runner' },
      }),
    );
    expect(desc).toContain('views');
    expect(desc).toContain('✓1/2 · A5 wiring runner');
    expect(desc).toContain('editing sessions.ts');
    expect(desc).toContain('agents-cli');
    if (desc.includes('\x1b]8;;')) {
      expect(desc).toContain('https://github.com/phnx-labs/agents-cli');
    }
  });

  it('cleans harness noise from the live snippet without destroying identity', () => {
    const desc = formatActiveRowDescription(
      mk({
        status: 'running',
        label: 'views',
        cwd: '/tmp/scratch',
        preview: '<system-reminder>ignore</system-reminder>real work',
      }),
    );
    expect(desc).toContain('views');
    expect(desc).toContain('real work');
    expect(desc).not.toContain('system-reminder');
  });
});
