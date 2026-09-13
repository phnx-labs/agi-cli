/**
 * PHNX-3999: `buildSessionDetailBlock` must materialize real request/timeline/
 * files on demand — bounded, via the daemon's own pure fold pipeline
 * (`foldTimeline`/`projectTimeline`/`projectSessionFiles`) — when the
 * background `session_timelines` cache has not reached this session yet,
 * rather than returning `null` with a vague "not computed" excuse. It must do
 * so both on a COLD read (a fresh parse already produced events) and on a WARM
 * read (a cached digest hit with no fresh events), the latter via a bounded
 * tail read so the "warm cache collapses to a 2-message summary" gap is closed
 * without ever doing a fresh whole-file parse.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSessionDetailBlock } from './sessions.js';
import type { SessionEvent, SessionMeta } from '../lib/session/types.js';
import { parseSession } from '../lib/session/parse.js';

function claudeFixture(dir: string): string {
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: 'user', timestamp: '2026-08-01T14:00:00.000Z', cwd: dir, sessionId: 'detail-block-session', version: '2.1.112', message: { role: 'user', content: 'Add rate limiting to the login endpoint' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:05.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'Adding a token-bucket limiter to the auth route.' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T14:00:06.000Z', message: { role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(dir, 'auth.ts') } }] } }),
  ].join('\n') + '\n');
  return filePath;
}

function meta(overrides: Partial<SessionMeta>): SessionMeta {
  return {
    id: 'detail-block-session', shortId: 'detailbk', agent: 'claude',
    timestamp: '2026-08-01T14:00:00.000Z', lastActivity: '2026-08-01T14:00:06.000Z',
    ...overrides,
  } as SessionMeta;
}

describe('buildSessionDetailBlock on-demand bounded materialization (PHNX-3999)', () => {
  it('folds real request/timeline/files on a COLD read (fresh-parse events in hand)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-detail-block-cold-'));
    try {
      const filePath = claudeFixture(dir);
      const events: SessionEvent[] = parseSession(filePath, 'claude');
      const session = meta({ filePath, cwd: dir });

      const detail = buildSessionDetailBlock(session, undefined, events);

      expect(detail.partial).toBe(true);
      expect(detail.reason).toMatch(/on-demand bounded fold/);
      expect(detail.request).toBeTruthy();
      expect((detail.request as { text: string }).text).toContain('rate limiting');
      expect(detail.timeline).toBeTruthy();
      expect((detail.timeline as { steps: unknown[] }).steps.length).toBeGreaterThan(0);
      expect(detail.messages.length).toBeGreaterThan(0);
      expect(detail.messages[0].role).toBe('user');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still folds real request/timeline via a bounded tail read on a WARM read (no fresh events)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-detail-block-warm-'));
    try {
      const filePath = claudeFixture(dir);
      const session = meta({ filePath, cwd: dir });

      // Simulate a warm digest-cache hit: no fresh events, but a real
      // transcript file still on disk for the bounded tail reader to find.
      const detail = buildSessionDetailBlock(session, { schemaVersion: 1, firstUser: '', lastAssistant: '' } as never, []);

      expect(detail.partial).toBe(true);
      expect(detail.request).toBeTruthy();
      expect((detail.request as { text: string }).text).toContain('rate limiting');
      expect(detail.timeline).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an explicit unavailable reason, not a silent empty timeline, for a metadata-only session', () => {
    const session = meta({ filePath: '' });
    const detail = buildSessionDetailBlock(session, undefined, []);
    expect(detail.request).toBeNull();
    expect(detail.timeline).toBeNull();
    expect(detail.files).toBeNull();
    expect(detail.partial).toBe(true);
    expect(detail.reason).toMatch(/no transcript available/);
  });

  it('does not label previously read events with the timestamp of an appended transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-detail-race-'));
    try {
      const filePath = claudeFixture(dir);
      const before = fs.statSync(filePath);
      const events = parseSession(filePath, 'claude');
      fs.appendFileSync(filePath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'A newer request' } }) + '\n');
      const detail = buildSessionDetailBlock(meta({ filePath }), undefined, events,
        { fileMtimeMs: before.mtimeMs, fileSize: before.size });
      expect(detail.sourceRevision).toBeNull();
      expect(detail.partial).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
