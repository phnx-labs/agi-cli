import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  matchesLiveStatus,
  isRunningLiveSession,
  requestedLiveStatuses,
  buildRoutineChoices,
  hasNoBrowserDisqualifyingFlags,
} from './sessions.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from '../lib/session/active.js';
import { describeLive, writeUpdateCache, writeClaudeSession, runAgents } from './sessions.test-fixture.js';

describe('routine session catalog', () => {
  it('keeps a defined routine visible before it has a run or transcript', () => {
    expect(buildRoutineChoices([], ['never-ran'])).toEqual([
      { name: 'never-ran', lastRunAt: '', runCount: 0, latestRunSessionCount: 0 },
    ]);
  });

  it('keeps --routines on the routine-specific picker instead of the generic browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ routine: true }, undefined)).toBe(false);
    expect(hasNoBrowserDisqualifyingFlags({ routine: 'nightly-review' }, undefined)).toBe(false);
  });

  it('finds a named routine archive outside the invoking directory without --all', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routine-cross-cwd-'));
    try {
      writeUpdateCache(tempHome);
      const invokingCwd = path.join(tempHome, 'work', 'unrelated-repo');
      const routineCwd = path.join(tempHome, 'work', 'scheduled-repo');
      const sessionId = 'face2403-1111-4222-8333-444455556666';
      const runId = '2026-08-08T03-00-00-000Z';
      fs.mkdirSync(invokingCwd, { recursive: true });
      const archiveDir = path.join(
        tempHome, '.agents', '.history', 'runs', 'nightly-review', runId,
        'sessions', 'claude', 'projects', '-scheduled-repo',
      );
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(archiveDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'user', timestamp: '2026-08-08T03:00:00.000Z', cwd: routineCwd,
          sessionId, version: '2.1.110', gitBranch: 'main', entrypoint: 'sdk-cli',
          message: { role: 'user', content: 'inspect the scheduled repository' },
        }) + '\n',
        'utf-8',
      );

      const result = runAgents(
        ['sessions', '--routine', 'nightly-review', '--json', '--local'],
        invokingCwd,
        tempHome,
      );
      expect(result.status, result.stderr).toBe(0);
      const rows = JSON.parse(result.stdout) as SessionMeta[];
      expect(rows.map((row) => row.id)).toEqual([sessionId]);
      expect(rows[0]).toMatchObject({
        origin: 'routine', routineName: 'nightly-review', routineRunId: runId,
        cwd: routineCwd,
        isTeamOrigin: true,
      });
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describeLive('routine drilldown — real CLI flow (RUSH-2409)', () => {
  function writeRun(tempHome: string, name: string, runId: string, meta: Record<string, unknown>): void {
    const dir = path.join(tempHome, '.agents', '.history', 'runs', name, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ jobName: name, runId, ...meta }), 'utf-8');
  }

  it('drills a command-only routine into run history with no session synthesized', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routine-cmd-'));
    try {
      writeUpdateCache(tempHome);
      const cwd = path.join(tempHome, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      writeRun(tempHome, 'auto-dispatch', '2026-08-08T05-03-00-002Z', {
        command: 'agents __daemon-tick auto-dispatch', triggerKind: 'schedule', pid: null,
        status: 'skipped', skipReason: 'wrong_owner',
        startedAt: '2026-08-08T05:03:00.000Z', completedAt: '2026-08-08T05:03:00.000Z', exitCode: null, duration: 0,
      });
      writeRun(tempHome, 'auto-dispatch', '2026-08-08T05-00-00-002Z', {
        command: 'echo hi', triggerKind: 'schedule', pid: 1234,
        status: 'completed', startedAt: '2026-08-08T05:00:00.000Z', completedAt: '2026-08-08T05:00:01.000Z', exitCode: 0, duration: 1000,
      });

      const result = runAgents(['sessions', '--routine', 'auto-dispatch', '--local'], cwd, tempHome);
      expect(result.status, result.stderr).toBe(0);
      // eslint-disable-next-line no-control-regex
      const out = result.stdout.replace(/\[[0-9;]*m/g, '');
      expect(out).toContain('2 run records · 0 linked sessions');
      expect(out).toContain('Command routine — runs execute a shell command; no agent session is produced.');
      expect(out).toContain('2026-08-08T05-03-00-002Z');
      expect(out).toContain('skipped');
      expect(out).toContain('wrong owner');
      expect(out).toContain('command · local');
      // The generic "No sessions found" dead-end must NOT appear for a routine.
      expect(out).not.toContain('No sessions found');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('links an indexed agent session to its run record', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-routine-agent-'));
    try {
      writeUpdateCache(tempHome);
      const cwd = path.join(tempHome, 'work');
      fs.mkdirSync(cwd, { recursive: true });
      const routineCwd = path.join(tempHome, 'work', 'scheduled-repo');
      const runId = '2026-08-08T03-00-00-000Z';
      const sessionId = 'abcd2409-1111-4222-8333-444455556666';
      writeRun(tempHome, 'nightly-review', runId, {
        agent: 'claude', version: '2.1.110', triggerKind: 'schedule', pid: 4321,
        status: 'completed', startedAt: '2026-08-08T03:00:00.000Z', completedAt: '2026-08-08T03:12:00.000Z', exitCode: 0, duration: 720000,
      });
      const archiveDir = path.join(
        tempHome, '.agents', '.history', 'runs', 'nightly-review', runId,
        'sessions', 'claude', 'projects', '-scheduled-repo',
      );
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        path.join(archiveDir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'user', timestamp: '2026-08-08T03:00:00.000Z', cwd: routineCwd,
          sessionId, version: '2.1.110', gitBranch: 'main', entrypoint: 'sdk-cli',
          message: { role: 'user', content: 'inspect the scheduled repository' },
        }) + '\n',
        'utf-8',
      );

      const result = runAgents(['sessions', '--routine', 'nightly-review', '--local'], cwd, tempHome);
      expect(result.status, result.stderr).toBe(0);
      // eslint-disable-next-line no-control-regex
      const out = result.stdout.replace(/\[[0-9;]*m/g, '');
      expect(out).toContain('1 run record · 1 linked session');
      expect(out).toContain(runId);
      expect(out).toContain('completed');
      expect(out).toContain('agent · 12m · local');
      // The linked indexed session row + its metadata are present.
      expect(out).toContain(sessionId.slice(0, 8));
      expect(out).toContain('claude v2.1.110');
      expect(out).not.toContain('no agent session archived');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

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
    // A real OS process is active only once it's positively located: a
    // machine, a positive pid, AND verified liveness (RUSH-2336).
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'orphaned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    // A live-but-stuck abandoned row still qualifies — the pid is genuinely alive.
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: true }))).toBe(true);
    expect(isRunningLiveSession(row({ status: 'closed', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'crashed', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'abandoned', machine: 'zion', pid: 111, pidAlive: false }))).toBe(false);
    // Dispatched but not yet started — only the explicit --queued view shows it.
    expect(isRunningLiveSession(row({ status: 'queued', machine: 'zion', pid: 111, pidAlive: true }))).toBe(false);
    // Unverified liveness (unknown pidAlive, no machine, or no pid at all) never
    // counts as active, even when the status itself reads "running".
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pid: 111 }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', pid: 111, pidAlive: true }))).toBe(false);
    expect(isRunningLiveSession(row({ status: 'running', machine: 'zion', pidAlive: true }))).toBe(false);
    // A cloud row has no local pid at all — it's active on the provider's word.
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(true);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'queued', cloudProvider: 'rush', cloudTaskId: 't1' }))).toBe(false);
    expect(isRunningLiveSession(row({ context: 'cloud', status: 'running', cloudProvider: 'rush' }))).toBe(false);
  });

  // 90s, not the default 30s: this test spawns several real `agents` CLI boots
  // (cold `node --import tsx`), measured 9.7s idle and 21.1s under 16 CPU-bound
  // background processes on a 20-core box (RUSH-2839).
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

      const orphan = runAgents(['sessions', '--orphan', '--json', '--local'], cwd, tempHome);
      const orphaned = runAgents(['sessions', '--orphaned', '--json', '--local'], cwd, tempHome);
      expect(orphan.status, orphan.stderr).toBe(0);
      expect(orphaned.status, orphaned.stderr).toBe(0);
      expect(JSON.parse(orphan.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);
      expect(JSON.parse(orphaned.stdout)).toEqual(JSON.parse(orphan.stdout));

      const union = runAgents(['sessions', '--orphan', '--crashed', '--json', '--local'], cwd, tempHome);
      expect(union.status, union.stderr).toBe(0);
      const unionIds = JSON.parse(union.stdout).map((row: ActiveSession) => row.sessionId);
      expect(unionIds).toContain(liveSessionId);
      expect(unionIds).toContain(crashedSessionId);

      const waitingUnion = runAgents(['sessions', '--waiting', '--orphan', '--json', '--local'], cwd, tempHome);
      expect(waitingUnion.status).toBe(1);
      expect(JSON.parse(waitingUnion.stdout).map((row: ActiveSession) => row.sessionId)).toContain(liveSessionId);

      const active = runAgents(['sessions', '--active', '--json', '--local'], cwd, tempHome);
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
