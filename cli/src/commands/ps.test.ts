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
    } finally {
      sleeper.kill('SIGTERM');
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});
