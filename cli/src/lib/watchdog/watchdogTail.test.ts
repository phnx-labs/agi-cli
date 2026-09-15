import { describe, it, expect } from 'vitest';
import { summarizeWatchdogTail } from './watchdogTail.js';

describe('summarizeWatchdogTail (claude)', () => {
  it('pulls the last user and assistant text blocks', () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'first ask' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'reading file' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'fix the auth bug' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'investigating tokens' }] } }),
    ];
    const summary = summarizeWatchdogTail(tail, 'claude');
    expect(summary.lastUserMessage).toBe('fix the auth bug');
    expect(summary.lastAssistantMessage).toBe('investigating tokens');
  });

  it('handles string-content shape', () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: 'plain string' } }),
    ];
    expect(summarizeWatchdogTail(tail, 'claude').lastUserMessage).toBe('plain string');
  });

  it('clips very long messages with an ellipsis', () => {
    const long = 'x'.repeat(2000);
    const tail = [JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: long }] } })];
    const summary = summarizeWatchdogTail(tail, 'claude');
    expect(summary.lastUserMessage!.length).toBe(600);
    expect(summary.lastUserMessage!.endsWith('…')).toBe(true);
  });
});

describe('summarizeWatchdogTail (codex)', () => {
  it('reads response_item messages by role', () => {
    const tail = [
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex user msg' }] },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex reply' }] },
      }),
    ];
    const summary = summarizeWatchdogTail(tail, 'codex');
    expect(summary.lastUserMessage).toBe('codex user msg');
    expect(summary.lastAssistantMessage).toBe('codex reply');
  });
});

describe('summarizeWatchdogTail (resilience)', () => {
  it('skips malformed JSON lines', () => {
    const tail = [
      'not json',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'still found' }] } }),
    ];
    expect(summarizeWatchdogTail(tail, 'claude').lastUserMessage).toBe('still found');
  });

  it('skips synthetic <local-command-stdout> and <system-reminder> wrappers', () => {
    const tail = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'real human prompt' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<local-command-stdout>blah</local-command-stdout>' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] } }),
    ];
    // Walks from the end; the synthetic ones should be skipped so the human prompt surfaces.
    expect(summarizeWatchdogTail(tail, 'claude').lastUserMessage).toBe('real human prompt');
  });

  it('returns empty summary for unknown agent', () => {
    const tail = [JSON.stringify({ type: 'user', message: { content: 'x' } })];
    expect(summarizeWatchdogTail(tail, 'unknown')).toEqual({});
  });

  it('returns empty summary when no messages present', () => {
    const tail = [JSON.stringify({ type: 'tool_call', tool_name: 'Read' })];
    expect(summarizeWatchdogTail(tail, 'codex')).toEqual({});
  });
});
