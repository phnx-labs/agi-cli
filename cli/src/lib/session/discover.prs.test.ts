import { describe, it, expect } from 'vitest';
import { applyClaudeLine, applyCodexLine, finalizeClaudeScan, finalizeCodexScan, hydrateClaudeParseState, hydrateCodexParseState, initClaudeParseState, initCodexParseState, serializeClaudeParserState, serializeCodexParserState } from './discover.js';

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

describe('a PR counts only from the result of its own create call', () => {
  it('a failed create leaves nothing armed, and a gh pr view result in the same turn is not a created PR (Claude)', () => {
    const state = initClaudeParseState();
    applyClaudeLine(state, { type: 'assistant', timestamp: '2026-10-18T12:00:00.000Z', message: { id: 'm1', content: [
      { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'gh pr create --fill' } },
      { type: 'tool_use', id: 'v1', name: 'Bash', input: { command: 'gh pr view 9' } },
    ] } });
    applyClaudeLine(state, { type: 'user', timestamp: '2026-10-18T12:00:01.000Z', message: { content: [
      { type: 'tool_result', tool_use_id: 'v1', content: 'https://github.com/acme/api/pull/9' },
      { type: 'tool_result', tool_use_id: 'c1', content: 'pull request create failed: GraphQL error' },
    ] } });
    applyClaudeLine(state, { type: 'assistant', timestamp: '2026-10-18T12:00:02.000Z', message: { id: 'm2', content: [{ type: 'tool_use', id: 'v2', name: 'Bash', input: { command: 'gh pr list' } }] } });
    applyClaudeLine(state, { type: 'user', timestamp: '2026-10-18T12:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'v2', content: 'https://github.com/acme/api/pull/10' }] } });
    const scan = finalizeClaudeScan(state);
    expect(scan.prUrl).toBeUndefined();
    expect(scan.prUrls).toBeUndefined();
  });

  it('Codex records each created PR by call id, across a checkpoint, and ignores other calls', () => {
    const call = (state: ReturnType<typeof initCodexParseState>, id: string, command: string, output: string) => {
      applyCodexLine(state, { type: 'response_item', timestamp: '2026-10-18T12:00:00.000Z', payload: { type: 'function_call', name: 'shell', call_id: id, arguments: JSON.stringify({ command }) } });
      applyCodexLine(state, { type: 'response_item', timestamp: '2026-10-18T12:00:01.000Z', payload: { type: 'function_call_output', call_id: id, output } });
    };
    const state = initCodexParseState();
    call(state, 'k1', 'gh pr create --fill', 'https://github.com/acme/api/pull/41');
    const resumed = hydrateCodexParseState(serializeCodexParserState(state, 100));
    call(resumed, 'k2', 'gh pr view 3', 'https://github.com/acme/api/pull/3');
    call(resumed, 'k3', 'gh pr create --fill', 'https://github.com/acme/web/pull/7');
    const scan = finalizeCodexScan(resumed);
    expect(scan.prUrl).toBe('https://github.com/acme/api/pull/41');
    expect(scan.prUrls).toEqual(['https://github.com/acme/api/pull/41', 'https://github.com/acme/web/pull/7']);
  });
});
