import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { ActiveSession } from '../lib/session/active.js';
import { deviceScope, statusFlags } from './ps.js';
import { describeLive, writeUpdateCache, writeClaudeSession, runAgents, tsxLoaderUrl, repoRoot } from './sessions.test-fixture.js';

describe('ps flag parsing', () => {
  it('maps --status values (repeated or comma-separated) onto the live-state flags', () => {
    expect(statusFlags(['waiting', 'orphan,crashed'])).toEqual({ waiting: true, orphaned: true, crashed: true });
    expect(statusFlags(undefined)).toEqual({});
  });

  it('refuses an unknown --status instead of widening the roster', () => {
    expect(() => statusFlags(['runing'])).toThrow(/Unknown --status "runing"/);
  });

  it('treats -D all / -D fleet as the default fleet scope', () => {
    expect(deviceScope(['all'])).toBeUndefined();
    expect(deviceScope(['fleet', 'box-a'])).toEqual(['box-a']);
    expect(deviceScope(undefined)).toBeUndefined();
  });
});

describeLive('agents ps — real CLI against a live process', () => {
  function fixture(windowAgeMs = 0): { tempHome: string; cwd: string; liveId: string; crashedId: string; sleeper: ReturnType<typeof spawn> } {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-'));
    const cwd = path.join(tempHome, 'work', 'ps-fixture');
    const liveId = 'feed1111-1111-4111-8111-111111111111';
    const crashedId = 'feed2222-2222-4222-8222-222222222222';
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    writeUpdateCache(tempHome);
    const projectKey = cwd.replace(/[/.]/g, '-');
    writeClaudeSession(tempHome, projectKey, liveId, cwd, 'Refactor the roster', new Date().toISOString());
    const registry = path.join(tempHome, '.agents', '.cache', 'terminals', 'live-terminals.json');
    fs.mkdirSync(path.dirname(registry), { recursive: true });
    fs.writeFileSync(registry, JSON.stringify({
      'ps-window': {
        at: new Date(Date.now() - windowAgeMs).toISOString(),
        entries: [
          { sessionId: liveId, pid: sleeper.pid, kind: 'claude', cwd, startedAtMs: Date.now() },
          { sessionId: crashedId, pid: 2_000_000_003, kind: 'claude', cwd, startedAtMs: Date.now() },
        ],
      },
    }));
    return { tempHome, cwd, liveId, crashedId, sleeper };
  }

  it('lists the same live roster as sessions --active, and filters by --status', () => {
    const { tempHome, cwd, liveId, crashedId, sleeper } = fixture(11 * 60_000);
    try {
      const ps = runAgents(['ps', '--json', '--local'], cwd, tempHome);
      expect(ps.status, ps.stderr).toBe(0);
      const rows = JSON.parse(ps.stdout) as ActiveSession[];
      const ids = rows.map((row) => row.sessionId);
      expect(ids).toContain(liveId);
      expect(ids).not.toContain(crashedId);
      expect(rows.find((row) => row.sessionId === liveId)).toMatchObject({ pid: sleeper.pid, pidAlive: true });

      const legacy = runAgents(['sessions', '--active', '--json', '--local'], cwd, tempHome);
      expect(legacy.status, legacy.stderr).toBe(0);
      expect((JSON.parse(legacy.stdout) as ActiveSession[]).map((row) => row.sessionId).sort()).toEqual([...ids].sort());

      const crashed = runAgents(['ps', '--status', 'crashed', '--json', '--local'], cwd, tempHome);
      expect(crashed.status, crashed.stderr).toBe(0);
      expect((JSON.parse(crashed.stdout) as ActiveSession[]).map((row) => row.sessionId)).toEqual([crashedId]);

      const union = runAgents(['ps', '--status', 'orphan,crashed', '--json', '--local'], cwd, tempHome);
      expect(union.status, union.stderr).toBe(0);
      expect((JSON.parse(union.stdout) as ActiveSession[]).map((row) => row.sessionId).sort()).toEqual([liveId, crashedId].sort());

      const bogus = runAgents(['ps', '--status', 'runing', '--local'], cwd, tempHome);
      expect(bogus.status).toBe(2);
      expect(bogus.stderr).toContain('Unknown --status "runing"');

      const text = runAgents(['ps', '--local', '--no-interactive'], cwd, tempHome);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain(liveId.slice(0, 8));
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('reads a daemon-published snapshot as live (rows carry their machine)', () => {
    const { tempHome, cwd, liveId, sleeper } = fixture();
    try {
      const publish = spawnSync(process.execPath, [
        '--import', tsxLoaderUrl, '-e',
        `const m = await import(${JSON.stringify(path.join(repoRoot, 'src/lib/session/session-cache.ts'))});
         const r = await m.publishLocalActiveSessions();
         console.log(JSON.stringify(r.sessions.map((s) => ({ id: s.sessionId, machine: s.machine }))));`,
      ], {
        cwd,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' },
        encoding: 'utf-8',
      });
      expect(publish.status, publish.stderr).toBe(0);
      const published = JSON.parse(publish.stdout.trim().split('\n').pop()!) as Array<{ id?: string; machine?: string }>;
      expect(published.find((row) => row.id === liveId)?.machine).toBeTruthy();

      const ps = runAgents(['ps', '--json', '--local'], cwd, tempHome);
      expect(ps.status, ps.stderr).toBe(0);
      expect((JSON.parse(ps.stdout) as ActiveSession[]).map((row) => row.sessionId)).toContain(liveId);
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('reads a snapshot an older daemon wrote without machine', () => {
    const { tempHome, cwd, liveId, sleeper } = fixture();
    try {
      const write = spawnSync(process.execPath, [
        '--import', tsxLoaderUrl, '-e',
        `const m = await import(${JSON.stringify(path.join(repoRoot, 'src/lib/session/session-cache.ts'))});
         m.writeActiveSessionsCache('local', [{ context: 'terminal', kind: 'claude', status: 'running',
           sessionId: ${JSON.stringify(liveId)}, pid: ${sleeper.pid}, pidAlive: true, cwd: ${JSON.stringify(cwd)} }],
           { capturedAt: Date.now() });`,
      ], {
        cwd,
        env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' },
        encoding: 'utf-8',
      });
      expect(write.status, write.stderr).toBe(0);

      const ps = runAgents(['ps', '--json', '--local'], cwd, tempHome);
      expect(ps.status, ps.stderr).toBe(0);
      const row = (JSON.parse(ps.stdout) as ActiveSession[]).find((r) => r.sessionId === liveId);
      expect(row?.machine).toBeTruthy();
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('ps stop <id> --local ends the live process', async () => {
    const { tempHome, cwd, liveId, sleeper } = fixture();
    const exited = new Promise<void>((resolve) => sleeper.once('exit', () => resolve()));
    try {
      const stop = runAgents(['ps', 'stop', liveId.slice(0, 8), '--local'], cwd, tempHome);
      expect(stop.status, `${stop.stdout}${stop.stderr}`).toBe(0);
      expect(stop.stdout).toContain(`Stopped claude ${liveId.slice(0, 8)}`);
      await exited;
      expect(sleeper.exitCode !== null || sleeper.signalCode !== null).toBe(true);

      const help = runAgents(['ps', 'stop', '--help'], cwd, tempHome);
      expect(help.stdout).toContain('agents ps stop 4b2f1a9c');
      for (const verb of ['focus', 'detach', 'migrate']) {
        const verbHelp = runAgents(['ps', verb, '--help'], cwd, tempHome);
        expect(verbHelp.status, verbHelp.stderr).toBe(0);
        expect(verbHelp.stdout).toContain(`agents ps ${verb}`);
      }
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});

describeLive('agents ps — parity with the sessions --active filters and the migration ledger', () => {
  const bookmarkedId = 'b0000001-1111-4111-8111-111111111111';
  const plainId = 'b0000002-2222-4222-8222-222222222222';
  const waitingId = 'b0000003-3333-4333-8333-333333333333';
  const hookRoutineId = 'b0000004-4444-4444-8444-444444444444';
  const indexedRoutineId = 'b0000005-5555-4555-8555-555555555555';
  const otherRoutineId = 'b0000006-6666-4666-8666-666666666666';

  function ids(result: { stdout: string; stderr: string; status: number | null }): string[] {
    return (JSON.parse(result.stdout) as ActiveSession[]).map((row) => row.sessionId!).sort();
  }

  function liveFixture(): { tempHome: string; cwd: string; sleeper: ReturnType<typeof spawn> } {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-parity-'));
    const cwd = path.join(tempHome, 'work', 'ps-parity');
    fs.mkdirSync(cwd, { recursive: true });
    writeUpdateCache(tempHome);
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' });

    const archiveDir = path.join(
      tempHome, '.agents', '.history', 'runs', 'nightly-review', '2026-10-06T00-00-00-000Z',
      'sessions', 'claude', 'projects', '-ps-parity',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${indexedRoutineId}.jsonl`), [
      { type: 'user', timestamp: '2026-10-06T00:00:00.000Z', cwd, version: '2.1.0', entrypoint: 'cli',
        message: { role: 'user', content: 'run nightly review' } },
      { type: 'assistant', timestamp: '2026-10-06T00:01:00.000Z', uuid: `${indexedRoutineId}-a1`,
        message: { id: `${indexedRoutineId}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 10, output_tokens: 5 } } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const indexed = runAgents(['sessions', '--routine', 'nightly-review', '--all', '--local', '--json'], cwd, tempHome);
    expect(indexed.status, indexed.stderr).toBe(0);

    const row = (sessionId: string, extra: Record<string, unknown> = {}) => ({
      context: 'terminal', kind: 'claude', status: 'running', sessionId, pid: sleeper.pid, pidAlive: true, cwd, ...extra,
    });
    const rows = [
      row(bookmarkedId),
      row(plainId),
      row(waitingId, { status: 'input_required', activity: 'waiting_input' }),
      row(hookRoutineId, { origin: 'routine', routineName: 'nightly-review' }),
      row(indexedRoutineId),
      row(otherRoutineId, { origin: 'routine', routineName: 'weekly-audit' }),
    ];
    const publish = spawnSync(process.execPath, [
      '--import', tsxLoaderUrl, '-e',
      `const m = await import(${JSON.stringify(path.join(repoRoot, 'src/lib/session/session-cache.ts'))});
       m.writeActiveSessionsCache('local', ${JSON.stringify(rows)}, { capturedAt: Date.now() });`,
    ], {
      cwd,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, AGENTS_SKIP_MIGRATION: '1', NODE_NO_WARNINGS: '1' },
      encoding: 'utf-8',
    });
    expect(publish.status, publish.stderr).toBe(0);

    for (const id of [bookmarkedId, waitingId]) {
      const bookmark = runAgents(['sessions', 'bookmark', id], cwd, tempHome);
      expect(bookmark.status, bookmark.stderr).toBe(0);
    }
    return { tempHome, cwd, sleeper };
  }

  it('selects the same rows for --bookmarks, --routine [name], and --status waiting', () => {
    const { tempHome, cwd, sleeper } = liveFixture();
    try {
      const pair = (legacy: string[], replacement: string[]) => {
        const before = runAgents(['sessions', '--active', ...legacy, '--json', '--local'], cwd, tempHome);
        const after = runAgents(['ps', ...replacement, '--json', '--local'], cwd, tempHome);
        expect(after.status, after.stderr).toBe(before.status);
        expect(ids(after)).toEqual(ids(before));
        return { ids: ids(after), status: after.status };
      };

      const everyone = pair([], []);
      expect(everyone.ids).toEqual(
        [bookmarkedId, plainId, waitingId, hookRoutineId, indexedRoutineId, otherRoutineId].sort(),
      );
      expect(pair(['--bookmarks'], ['--bookmarks']).ids).toEqual([bookmarkedId, waitingId].sort());
      expect(pair(['--routine'], ['--routine']).ids).toEqual([hookRoutineId, indexedRoutineId, otherRoutineId].sort());
      expect(pair(['--routines'], ['--routines']).ids).toEqual([hookRoutineId, indexedRoutineId, otherRoutineId].sort());
      expect(pair(['--routine', 'nightly'], ['--routine', 'nightly']).ids).toEqual([hookRoutineId, indexedRoutineId].sort());
      expect(pair(['--routine', 'weekly-audit'], ['--routine', 'weekly-audit']).ids).toEqual([otherRoutineId]);

      const waiting = pair(['--waiting'], ['--status', 'waiting']);
      expect(waiting).toEqual({ ids: [waitingId], status: 1 });
      expect(pair(['--bookmarks', '--waiting'], ['--bookmarks', '--status', 'waiting'])).toEqual({ ids: [waitingId], status: 1 });
      expect(pair(['--routine', '--waiting'], ['--routine', '--status', 'waiting'])).toEqual({ ids: [], status: 0 });

      const help = runAgents(['ps', '--help'], cwd, tempHome);
      expect(help.stdout).toContain('--bookmarks');
      expect(help.stdout).toContain('--routine [name]');
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 180_000);

  it('ps migrations reads the same ledger as sessions migrations, with --session and text output', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-ps-migrations-'));
    const cwd = path.join(tempHome, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    writeUpdateCache(tempHome);
    try {
      const empty = runAgents(['ps', 'migrations'], cwd, tempHome);
      expect(empty.status, empty.stderr).toBe(0);
      expect(empty.stdout).toContain('No migrations recorded yet. Move one: agents ps migrate --auto');
      const legacyEmpty = runAgents(['sessions', 'migrations'], cwd, tempHome);
      expect(legacyEmpty.stdout).toContain('No migrations recorded yet. Move one: agents sessions migrate --auto');

      const ledger = path.join(tempHome, '.agents', '.history', 'migrations.jsonl');
      fs.mkdirSync(path.dirname(ledger), { recursive: true });
      const record = (sessionId: string, shortId: string, to: string, at: string, status: 'completed' | 'failed') => ({
        sessionId, shortId, agent: 'claude', mode: 'rehydrate', move: true,
        from: { host: 'src-box', cwd: '/w' }, to: { host: to }, at, status,
      });
      fs.writeFileSync(ledger, [
        record('aaaa1111-0000-4000-8000-000000000001', 'aaaa1111', 'box-one', '2026-10-06T01:00:00.000Z', 'completed'),
        record('bbbb2222-0000-4000-8000-000000000002', 'bbbb2222', 'box-two', '2026-10-06T02:00:00.000Z', 'failed'),
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');

      for (const args of [['--json'], ['--json', '--session', 'bbbb'], ['--session', 'aaaa1111-0000', '--json']]) {
        const legacy = runAgents(['sessions', 'migrations', ...args], cwd, tempHome);
        const ps = runAgents(['ps', 'migrations', ...args], cwd, tempHome);
        expect(legacy.status, legacy.stderr).toBe(0);
        expect(ps.status, ps.stderr).toBe(0);
        expect(JSON.parse(ps.stdout)).toEqual(JSON.parse(legacy.stdout));
      }
      expect((JSON.parse(runAgents(['ps', 'migrations', '--json'], cwd, tempHome).stdout) as unknown[]).length).toBe(2);
      expect((JSON.parse(runAgents(['ps', 'migrations', '--json', '--session', 'bbbb'], cwd, tempHome).stdout) as Array<{ shortId: string }>)
        .map((r) => r.shortId)).toEqual(['bbbb2222']);

      const inherited = runAgents(['ps', '--json', 'migrations'], cwd, tempHome);
      expect(inherited.status, inherited.stderr).toBe(0);
      expect((JSON.parse(inherited.stdout) as unknown[]).length).toBe(2);

      const text = runAgents(['ps', 'migrations'], cwd, tempHome);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toBe(runAgents(['sessions', 'migrations'], cwd, tempHome).stdout);
      expect(text.stdout).toContain('WHEN');
      expect(text.stdout.indexOf('bbbb2222')).toBeLessThan(text.stdout.indexOf('aaaa1111'));
      expect(text.stdout).toContain('src-box → box-two');

      const migrateHelp = runAgents(['ps', 'migrate', '--help'], cwd, tempHome);
      expect(migrateHelp.stdout).toContain("'agents ps migrations'");
      expect(runAgents(['sessions', 'migrate', '--help'], cwd, tempHome).stdout).toContain("'agents sessions migrations'");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 120_000);
});
