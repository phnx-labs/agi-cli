import { describe, expect, it } from 'vitest';
import { normalizeEvents } from '../parsers.js';
import { summarizeEvents } from '../summarizer.js';

describe('normalizeEvents(grok)', () => {
  it('maps thought events to thinking with content preserved', () => {
    const events = normalizeEvents('grok', { type: 'thought', data: 'hello' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'thinking',
      agent: 'grok',
      content: 'hello',
    });
  });

  it('maps text tokens to streaming message events (complete:false)', () => {
    const events = normalizeEvents('grok', { type: 'text', data: 'Hi' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'grok',
      content: 'Hi',
      complete: false,
    });
  });

  it('maps end events to a success result with sessionId', () => {
    const events = normalizeEvents('grok', {
      type: 'end',
      stopReason: 'EndTurn',
      sessionId: '019e6b6f-ede1-7f91-9297-7415bd36423e',
      requestId: '010520c4-557f-4777-9ec9-1ac331d3e855',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'result',
      agent: 'grok',
      status: 'success',
      stop_reason: 'EndTurn',
      session_id: '019e6b6f-ede1-7f91-9297-7415bd36423e',
    });
  });

  it('treats non-EndTurn stop reasons as error', () => {
    const events = normalizeEvents('grok', {
      type: 'end',
      stopReason: 'MaxTokens',
      sessionId: 'abc',
    });
    expect(events[0]).toMatchObject({
      type: 'result',
      status: 'error',
      stop_reason: 'MaxTokens',
    });
  });

  it('drops empty thought / text payloads', () => {
    expect(normalizeEvents('grok', { type: 'thought', data: '' })).toEqual([]);
    expect(normalizeEvents('grok', { type: 'text', data: '' })).toEqual([]);
  });

  it('passes through unknown event types as raw', () => {
    const events = normalizeEvents('grok', { type: 'mystery', payload: 'x' });
    expect(events[0]).toMatchObject({
      type: 'mystery',
      agent: 'grok',
    });
  });
});

describe('summarizeEvents with grok streaming tokens', () => {
  it('reassembles token-level message events into one finalMessage', () => {
    const tokens = ['Hi', '!', ' How', ' can', ' I', ' help', '?'];
    const events: any[] = [];
    for (const t of tokens) {
      events.push(...normalizeEvents('grok', { type: 'text', data: t }));
    }
    events.push(...normalizeEvents('grok', {
      type: 'end',
      stopReason: 'EndTurn',
      sessionId: 'sess-1',
    }));

    const summary = summarizeEvents('agent-1', 'grok', 'completed', events);
    expect(summary.finalMessage).toBe('Hi! How can I help?');
  });

  it('does not corrupt finalMessage for non-streaming agents (claude)', () => {
    const events = [
      { type: 'message', agent: 'claude', content: 'first turn', complete: true },
      { type: 'message', agent: 'claude', content: 'second turn', complete: true },
    ];
    const summary = summarizeEvents('agent-2', 'claude', 'completed', events);
    expect(summary.finalMessage).toBe('second turn');
  });
});
