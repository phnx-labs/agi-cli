import { describe, expect, it } from 'vitest';
import { normalizeEvents } from '../parsers.js';

describe('normalizeEvents(antigravity)', () => {
  it('wraps a plain-string raw payload as a complete message event', () => {
    const events = normalizeEvents('antigravity', 'hello from agy');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'antigravity',
      content: 'hello from agy',
      complete: true,
    });
  });

  it('drops an empty string payload', () => {
    expect(normalizeEvents('antigravity', '')).toEqual([]);
  });

  it('emits an unknown event for null / number / non-object input', () => {
    const nullEvents = normalizeEvents('antigravity', null);
    expect(nullEvents).toHaveLength(1);
    expect(nullEvents[0]).toMatchObject({
      type: 'unknown',
      agent: 'antigravity',
    });

    const numEvents = normalizeEvents('antigravity', 42);
    expect(numEvents[0]).toMatchObject({
      type: 'unknown',
      agent: 'antigravity',
    });
  });

  it('normalizes a recognizable init event with sessionId', () => {
    const events = normalizeEvents('antigravity', {
      type: 'init',
      sessionId: 'agy-sess-1',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'init',
      agent: 'antigravity',
      session_id: 'agy-sess-1',
    });
  });

  it('normalizes a message event with content', () => {
    const events = normalizeEvents('antigravity', {
      type: 'message',
      content: 'partial response',
      complete: false,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'message',
      agent: 'antigravity',
      content: 'partial response',
      complete: false,
    });
  });

  it('treats message events without explicit complete as complete:true', () => {
    const events = normalizeEvents('antigravity', {
      type: 'message',
      content: 'one-shot',
    });
    expect(events[0]).toMatchObject({
      type: 'message',
      content: 'one-shot',
      complete: true,
    });
  });

  it('drops message events with empty content', () => {
    expect(normalizeEvents('antigravity', { type: 'message', content: '' })).toEqual([]);
  });

  it('normalizes a result event into success by default', () => {
    const events = normalizeEvents('antigravity', {
      type: 'result',
      sessionId: 'agy-sess-2',
    });
    expect(events[0]).toMatchObject({
      type: 'result',
      agent: 'antigravity',
      status: 'success',
      session_id: 'agy-sess-2',
    });
  });

  it('preserves error status on result events', () => {
    const events = normalizeEvents('antigravity', {
      type: 'result',
      status: 'error',
    });
    expect(events[0]).toMatchObject({
      type: 'result',
      status: 'error',
    });
  });

  it('falls back to a generic shape for unknown event types', () => {
    const events = normalizeEvents('antigravity', {
      type: 'mystery',
      payload: 'x',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'mystery',
      agent: 'antigravity',
    });
    expect(events[0].raw).toMatchObject({ type: 'mystery', payload: 'x' });
  });
});
