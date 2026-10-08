import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-toolsess-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { getSessionsDir } = await import('../state.js');
fs.mkdirSync(getSessionsDir(), { recursive: true });

const { getDB, recordBrowserSession, recordComputerSession } = await import('./db.js');

function browserRow(profile: string, task: string) {
  return getDB()
    .prepare(`SELECT session_id, actor, screenshot_count FROM browser_sessions WHERE profile = ? AND task = ?`)
    .get(profile, task) as { session_id: string | null; actor: string | null; screenshot_count: number } | undefined;
}

function computerRow(invocationId: string) {
  return getDB()
    .prepare(`SELECT session_id, action_count, task_preview FROM computer_sessions WHERE invocation_id = ?`)
    .get(invocationId) as { session_id: string | null; action_count: number; task_preview: string | null } | undefined;
}

describe('tool session writers', () => {
  it('never blanks a recorded session id when a later browser write carries none', () => {
    recordBrowserSession({ task: 'lucky-lynx-cedar', profile: 'widen@endpoint-0', sessionId: 'sess-keep-me', actor: 'someone@zion' });
    recordBrowserSession({ task: 'lucky-lynx-cedar', profile: 'widen@endpoint-0', counts: { screenshot: 4 } });

    expect(browserRow('widen@endpoint-0', 'lucky-lynx-cedar')).toEqual({ session_id: 'sess-keep-me', actor: 'someone@zion', screenshot_count: 4 });
  });

  it('accumulates action_count across the many calls one computer invocation makes', () => {
    recordComputerSession({ invocationId: 'inv-abc-123', sessionId: 'sess-computer', taskPreview: 'open the dashboard' });
    recordComputerSession({ invocationId: 'inv-abc-123' });
    recordComputerSession({ invocationId: 'inv-abc-123' });

    expect(computerRow('inv-abc-123')).toEqual({ session_id: 'sess-computer', action_count: 3, task_preview: 'open the dashboard' });
  });

  it('keeps both tables bounded from the write path, since nothing here lists them', () => {
    const expired = Date.now() - 400 * 24 * 60 * 60 * 1000;
    recordComputerSession({ invocationId: 'inv-expired', startedAt: expired });
    expect(computerRow('inv-expired')).toBeDefined();
    recordBrowserSession({ task: 'fresh-task', profile: 'old@endpoint-0' });
    expect(computerRow('inv-expired')).toBeUndefined();

    recordBrowserSession({ task: 'expired-task', profile: 'old@endpoint-0', startedAt: expired });
    expect(browserRow('old@endpoint-0', 'expired-task')).toBeDefined();
    recordComputerSession({ invocationId: 'inv-fresh' });
    expect(browserRow('old@endpoint-0', 'expired-task')).toBeUndefined();
    expect(browserRow('old@endpoint-0', 'fresh-task')).toBeDefined();
  });
});
