import { describe, it, expect } from 'vitest';
import { applyClaudeLine, finalizeClaudeScan, hydrateClaudeParseState, initClaudeParseState, serializeClaudeParserState } from './discover.js';

const prCreate = (state: ReturnType<typeof initClaudeParseState>, id: string, url: string) => {
  applyClaudeLine(state, { type: 'assistant', timestamp: '2026-10-18T12:00:00.000Z', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'gh pr create --fill' } }] } });
  applyClaudeLine(state, { type: 'user', timestamp: '2026-10-18T12:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: id, content: url }] } });
};

describe('the index records every PR a Claude session created (agi-cli#3989)', () => {
  it('lists each PR in order across a checkpoint; prUrl stays the first', () => {
    const state = initClaudeParseState();
    prCreate(state, 't1', 'https://github.com/acme/api/pull/41');
    const resumed = hydrateClaudeParseState(serializeClaudeParserState(state, 100));
    prCreate(resumed, 't2', 'https://github.com/acme/web/pull/7');
    prCreate(resumed, 't3', 'https://github.com/acme/api/pull/41');
    const scan = finalizeClaudeScan(resumed);
    expect(scan.prUrl).toBe('https://github.com/acme/api/pull/41');
    expect(scan.prUrls).toEqual(['https://github.com/acme/api/pull/41', 'https://github.com/acme/web/pull/7']);
  });

  it('a session with one PR has no prUrls, and a checkpoint from before prUrls resumes from its prUrl', () => {
    const one = initClaudeParseState();
    prCreate(one, 't1', 'https://github.com/acme/api/pull/41');
    expect(finalizeClaudeScan(one).prUrls).toBeUndefined();
    const { prUrls: _dropped, ...legacy } = serializeClaudeParserState(one, 100);
    const resumed = hydrateClaudeParseState(legacy as ReturnType<typeof serializeClaudeParserState>);
    prCreate(resumed, 't2', 'https://github.com/acme/web/pull/7');
    expect(finalizeClaudeScan(resumed).prUrls).toEqual(['https://github.com/acme/api/pull/41', 'https://github.com/acme/web/pull/7']);
  });
});
