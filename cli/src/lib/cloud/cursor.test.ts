import { describe, expect, it } from 'vitest';
import { CursorCloudProvider, buildCursorCreateBody, cursorApiError, parseCursorSseFrame, parseCursorTask } from './cursor.js';

describe('Cursor Cloud request parsing', () => {
  it('builds the documented v1 create body', () => {
    expect(buildCursorCreateBody({
      prompt: 'Fix the test',
      repo: 'https://github.com/acme/app',
      branch: 'main',
      model: 'composer-2',
    })).toEqual({
      prompt: { text: 'Fix the test' },
      model: { id: 'composer-2' },
      repos: [{ url: 'https://github.com/acme/app', startingRef: 'main' }],
      autoCreatePR: true,
    });
  });

  it('maps a Cursor run to a CloudTask', () => {
    expect(parseCursorTask({
      id: 'bc-1', status: 'ACTIVE', createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:01:00Z',
      repos: [{ url: 'https://github.com/acme/app' }],
    }, {
      id: 'run-1', agentId: 'bc-1', status: 'FINISHED', createdAt: '2026-08-05T00:00:00Z', updatedAt: '2026-08-05T00:02:00Z',
      result: 'Fixed it', git: { branches: [{ repoUrl: 'github.com/acme/app', branch: 'cursor/fix', prUrl: 'https://github.com/acme/app/pull/1' }] },
    }, 'Fix it')).toMatchObject({
      id: 'bc-1', provider: 'cursor', status: 'completed', prompt: 'Fix it', repo: 'https://github.com/acme/app',
      branch: 'cursor/fix', prUrl: 'https://github.com/acme/app/pull/1', summary: 'Fixed it',
    });
  });

  it('parses status, text, tool, done, error, and unknown SSE frames', () => {
    expect(parseCursorSseFrame('event: status\ndata: {"status":"RUNNING"}')).toMatchObject({ type: 'status', status: 'running' });
    expect(parseCursorSseFrame('event: assistant\ndata: {"text":"hello"}')).toMatchObject({ type: 'text', content: 'hello' });
    expect(parseCursorSseFrame('event: thinking\ndata: {"text":"considering"}')).toMatchObject({ type: 'thinking', content: 'considering' });
    expect(parseCursorSseFrame('event: tool_call\ndata: {"name":"read_file","args":{"path":"a.ts"}}')).toMatchObject({ type: 'tool_use', tool: 'read_file' });
    expect(parseCursorSseFrame('event: tool_call\ndata: {"name":"read_file","status":"completed","result":{"ok":true}}')).toMatchObject({ type: 'tool_result', tool: 'read_file' });
    expect(parseCursorSseFrame('event: result\ndata: {"status":"FINISHED","text":"ok"}')).toMatchObject({ type: 'done', status: 'completed', summary: 'ok' });
    expect(parseCursorSseFrame('event: error\ndata: {"message":"bad"}')).toMatchObject({ type: 'error', message: 'bad' });
    expect(parseCursorSseFrame('event: future\ndata: value')).toMatchObject({ type: 'unknown', name: 'future', data: 'value' });
  });
});

describe('Cursor Cloud API errors', () => {
  it('distinguishes a free-plan key from invalid authentication', () => {
    expect(cursorApiError('dispatch', 403, JSON.stringify({ error: { code: 'plan_required', message: 'Upgrade required' } })).message)
      .toContain('requires a paid Cursor plan');
    expect(cursorApiError('dispatch', 401, JSON.stringify({ error: { code: 'unauthorized', message: 'Bad key' } })).message)
      .toContain('authentication failed');
  });
});

describe('CursorCloudProvider auth', () => {
  it('fails loud with the secrets command when no key is configured', async () => {
    const old = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const provider = new CursorCloudProvider();
      expect(provider.capabilities().available).toBe(false);
      await expect(provider.dispatch({ prompt: 'test' })).rejects.toThrow('after running: secrets add cursor CURSOR_API_KEY');
    } finally {
      if (old === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = old;
    }
  });
});

describe.skipIf(!process.env.CURSOR_API_KEY)('Cursor Cloud live API (skipped: CURSOR_API_KEY is not present)', () => {
  it('lists agents through the real v1 API', async () => {
    await expect(new CursorCloudProvider().list()).resolves.toBeInstanceOf(Array);
  });
});
