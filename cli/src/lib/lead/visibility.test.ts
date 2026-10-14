import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import {
  hideLeadInFeedEnvelope, hideLeadInSessionEnvelope, isLeadCwd, isLeadSession, leadSessionIds, markLeadSessions, withoutLeadSessions,
} from './visibility.js';
import { toPreviousSessionWatchRow, toSessionWatchRow } from '../session/remote/watch.js';

const lead = { sessionId: 'lead-1', cwd: '/home/u/.agents/lead/agi', status: 'idle' };
const worker = { sessionId: 'work-1', cwd: '/home/u/src/agents-cli', status: 'running' };
const none = new Set<string>();

describe('Lead session visibility', () => {
  it('recognizes a Lead by its cwd on any home, a lead flag, or a host session id', () => {
    expect(isLeadCwd('/home/u/.agents/lead/agi')).toBe(true);
    expect(isLeadCwd('/Users/u/.agents/lead/rush/bin')).toBe(true);
    expect(isLeadCwd('/home/u/.agents/lead')).toBe(true);
    expect(isLeadCwd('/home/u/.agents/leaderboard')).toBe(false);
    expect(isLeadCwd('/home/u/src/lead/app')).toBe(false);
    expect(isLeadCwd(undefined)).toBe(false);
    expect(isLeadSession({ lead: true }, none)).toBe(true);
    expect(isLeadSession({ sessionId: 'abc', cwd: '/elsewhere' }, new Set(['abc']))).toBe(true);
    expect(isLeadSession(worker, none)).toBe(false);
  });

  it('reads the host session ids from every Lead session.json', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-vis-'));
    fs.mkdirSync(path.join(root, 'agi'));
    fs.writeFileSync(path.join(root, 'agi', 'session.json'), JSON.stringify({ sessionId: 's-agi' }));
    fs.mkdirSync(path.join(root, 'rush'));
    fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
    expect([...leadSessionIds(root)]).toEqual(['s-agi']);
    expect(leadSessionIds(path.join(root, 'missing')).size).toBe(0);
  });

  it('marks live rows and drops them from a roster', () => {
    const rows = [{ ...lead }, { ...worker }];
    markLeadSessions(rows, none);
    expect(rows.map((r) => (r as { lead?: boolean }).lead)).toEqual([true, undefined]);
    expect(withoutLeadSessions(rows, none).map((r) => r.sessionId)).toEqual(['work-1']);
  });

  it('carries lead: true onto watch rows, live and history', () => {
    expect(toSessionWatchRow('box', { context: 'terminal', kind: 'claude', ...lead, lead: true } as never).lead).toBe(true);
    const meta = { id: 'lead-h', shortId: 'lead-h', agent: 'claude', timestamp: '2026-10-13T00:00:00.000Z', filePath: '/x.jsonl', cwd: '/home/u/.agents/lead/agi' } as SessionMeta;
    expect(toPreviousSessionWatchRow('box', meta, []).lead).toBe(true);
    expect(toPreviousSessionWatchRow('box', { ...meta, cwd: '/home/u/src/app' }, []).lead).toBeUndefined();
  });

  it('hides Leads on the session stream: resets drop them, an upsert becomes a remove', () => {
    const base = { v: 1, streamId: 's', sequence: 1, scope: 'box' };
    const reset = hideLeadInSessionEnvelope({ ...base, type: 'reset', rows: [{ ...lead, rowKey: 'k1' }, { ...worker, rowKey: 'k2' }] }, none);
    expect((reset as unknown as { rows: Array<{ rowKey: string }> }).rows.map((r) => r.rowKey)).toEqual(['k2']);
    expect(hideLeadInSessionEnvelope({ ...base, type: 'upsert', rowKey: 'k1', row: lead }, none))
      .toEqual({ ...base, type: 'remove', rowKey: 'k1' });
    const keep = { ...base, type: 'upsert', rowKey: 'k2', row: worker };
    expect(hideLeadInSessionEnvelope(keep, none)).toBe(keep);
  });

  it('hides Leads on the feed stream, including their attention items', () => {
    const base = { v: 1, streamId: 's', sequence: 1, scope: 'box' };
    const reset = hideLeadInFeedEnvelope({
      ...base, type: 'reset', agents: [lead, worker],
      attention: [{ sessionId: 'lead-1', key: 'a' }, { sessionId: 'work-1', key: 'b' }], tools: [], setup: [],
    }, none) as unknown as { agents: Array<{ sessionId: string }>; attention: Array<{ key: string }> };
    expect(reset.agents.map((a) => a.sessionId)).toEqual(['work-1']);
    expect(reset.attention.map((a) => a.key)).toEqual(['b']);
    expect(hideLeadInFeedEnvelope({ ...base, type: 'agent.upsert', rowKey: 'k1', agent: lead }, none))
      .toEqual({ ...base, type: 'agent.remove', rowKey: 'k1' });
    const activity = { ...base, type: 'activity.append', event: {} };
    expect(hideLeadInFeedEnvelope(activity, none)).toBe(activity);
  });
});
