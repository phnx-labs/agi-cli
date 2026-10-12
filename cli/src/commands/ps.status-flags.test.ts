import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { matchesLiveStatus, requestedLiveStatuses } from './ps-roster.js';
import { isRunningLiveSession, type ActiveSession } from '../lib/session/active.js';
import { describeLive, writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

describeLive('live session status flags', () => {
  const row = (over: Partial<ActiveSession>): ActiveSession => ({
    context: 'terminal', kind: 'codex', status: 'running', ...over,
  });

  it('maps every convenience flag and deduplicates --orphan/--orphaned', () => {
    expect(requestedLiveStatuses({
      working: true, idle: true, waiting: true, orphan: true, orphaned: true,
      crashed: true, closed: true, abandoned: true, queued: true, unknown: true,
    })).toEqual([
      'working', 'idle', 'waiting', 'orphaned', 'crashed', 'closed', 'abandoned', 'queued', 'unknown',
    ]);
  });

  it('distinguishes working from idle and waiting activity', () => {
    expect(matchesLiveStatus(row({ activity: 'working' }), 'working')).toBe(true);
    expect(matchesLiveStatus(row({ status: 'idle', activity: 'idle' }), 'working')).toBe(false);
    expect(matchesLiveStatus(row({ status: 'input_required', activity: 'waiting_input' }), 'waiting')).toBe(true);
  });

  it('matches lifecycle states exactly', () => {
    for (const status of ['idle', 'orphaned', 'crashed', 'closed', 'abandoned', 'queued', 'unknown'] as const) {
      expect(matchesLiveStatus(row({ status }), status)).toBe(true);
    }
  });

  it('distinguishes active rows from dead rows retained for recovery filters', () => {
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'orphaned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'closed', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'crashed', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'queued', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111 }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(true);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'queued', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(false);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush' }))).toBe(false);
  });

  it('routes aliases, unions, and the waiting exit gate through the real CLI', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-status-flags-'));
    const cwd = path.join(tempHome, 'work', 'status-fixture');
    const liveSessionId = 'abcd1111-1111-4111-8111-111111111111';
    const crashedSessionId = 'abcd2222-2222-4222-8222-222222222222';
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
    try {
      writeUpdateCache(tempHome);
      const projectKey = cwd.replace(/[/.]/g, '-');
      writeClaudeSession(
        tempHome,
        projectKey,
        liveSessionId,
        cwd,
        'Waiting for the user to choose',
        new Date(Date.now() - 15 * 60_000).toISOString(),
      );
      fs.appendFileSync(
        path.join(tempHome, '.claude', 'projects', projectKey, `${liveSessionId}.jsonl`),
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(Date.now() - 15 * 60_000).toISOString(),
          sessionId: liveSessionId,
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'ask-status-filter',
              name: 'AskUserQuestion',
              input: {
                questions: [{
                  question: 'Choose the next step',
                  header: 'Scope',
                  options: [
                    { label: 'Continue', description: 'Keep working' },
                    { label: 'Stop', description: 'End the session' },
                  ],
                }],
              },
            }],
          },
        }) + '\n',
        'utf-8',
      );
      const registry = path.join(tempHome, '.agents', '.cache', 'terminals', 'live-terminals.json');
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, JSON.stringify({
        'stale-window': {
          at: new Date(Date.now() - 11 * 60_000).toISOString(),
          entries: [
            { sessionId: liveSessionId, pid: sleeper.pid, kind: 'claude', cwd, startedAtMs: Date.now() },
            { sessionId: crashedSessionId, pid: 2_000_000_003, kind: 'claude', cwd, startedAtMs: Date.now() },
          ],
        },
      }));

      const orphan = runAgents(['ps', '--status', 'orphan', '--json', '--local'], cwd, tempHome);
      const orphaned = runAgents(['ps', '--status', 'orphaned', '--json', '--local'], cwd, tempHome);
      expect(orphan.status, orphan.stderr).toBe(0);
      expect(orphaned.status, orphaned.stderr).toBe(0);
      expect(JSON.parse(orphan.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);
      expect(JSON.parse(orphaned.stdout)).toEqual(JSON.parse(orphan.stdout));

      const union = runAgents(['ps', '--status', 'orphan,crashed', '--json', '--local'], cwd, tempHome);
      expect(union.status, union.stderr).toBe(0);
      const unionIds = JSON.parse(union.stdout).map((row: ActiveSession) => row.sessionId);
      expect(unionIds).toContain(liveSessionId);
      expect(unionIds).toContain(crashedSessionId);

      const waitingUnion = runAgents(['ps', '--status', 'waiting', '--status', 'orphan', '--json', '--local'], cwd, tempHome);
      expect(waitingUnion.status).toBe(1);
      expect(JSON.parse(waitingUnion.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);

      const active = runAgents(['ps', '--json', '--local'], cwd, tempHome);
      expect(active.status, active.stderr).toBe(0);
      const activeIds = JSON.parse(active.stdout).map((row: ActiveSession) => row.sessionId);
      expect(activeIds).toContain(liveSessionId);
      expect(activeIds).not.toContain(crashedSessionId);
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});
