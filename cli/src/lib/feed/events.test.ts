import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emit, emitAsync, emitStart, emitCommand, emitFriction, query, rotate, stats,
  redactPrompt, redactArgs, truncate,
  detectCaller,
  levelFor, isEventType, EVENT_TYPES,
  getLogsPath, _resetForTest, createTimer,
} from './events.js';
import { resetActorCache } from '../actor.js';

// RUSH-2215: quarantine only I/O-heavy event-bus suites on win32; pure
// event-kind / level tables still run (review: do not skip platform-neutral guards).
const describeEventsIo = process.platform === 'win32' ? describe.skip : describe;
const describeEvents = describe;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-events-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
  tempDirs.length = 0;
  delete process.env.AGENTS_DISABLE_EVENT_LOG;
  _resetForTest();
});

function setupLogsDir(): string {
  const dir = makeTempDir();
  const eventsPath = path.join(dir, 'events.jsonl');
  _resetForTest(eventsPath);
  return dir;
}

describeEventsIo('events', () => {
  describe('createTimer perf persistence (PHNX-3468)', () => {
    it('end() persists sub-phase marks into the spool meta_json SYNCHRONOUSLY (PHNX-3497)', () => {
      const dir = makeTempDir();
      const spool = path.join(dir, 'perf-spool.jsonl');
      process.env.AGENTS_PERF_SPOOL = spool;
      delete process.env.AGENTS_DISABLE_PERF;
      try {
        const timer = createTimer('agent.run', { agent: 'claude', version: '2.1.0' });
        timer.mark('startup');
        timer.end({ exitCode: 0, status: 'success' });

        // The spool append MUST be complete the instant end() returns — no await,
        // no polling. A foreground `agents run` exits the process on the very next
        // tick, so any deferred write is lost (PHNX-3497). Reading immediately is
        // the regression assertion: it fails if recordPerfTiming ever goes async.
        const line = fs.readFileSync(spool, 'utf-8').trim().split('\n').filter(Boolean).pop();
        expect(line).toBeDefined();
        const rec = JSON.parse(line!);
        expect(rec.kind).toBe('perf.timing');
        expect(rec.label).toBe('agent.run');
        expect(rec.meta_json).toBeDefined();
        const meta = JSON.parse(rec.meta_json);
        expect(typeof meta.phases.startup).toBe('number');
      } finally {
        delete process.env.AGENTS_PERF_SPOOL;
      }
    });
  });

  describe('emit', () => {
    it('writes a JSONL record with level and caller fields', () => {
      const logsDir = setupLogsDir();
      emit('info', { module: 'test', input: 'hello' });

      const files = fs.readdirSync(logsDir).filter(f => f === 'events.jsonl');
      expect(files).toEqual(['events.jsonl']);

      const content = fs.readFileSync(path.join(logsDir, 'events.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim().split('\n').pop()!);
      expect(record.event).toBe('info');
      expect(record.level).toBe('info');
      expect(record.ts).toBeDefined();
      expect(record.hostname).toBeDefined();
      expect(record.pid).toBe(process.pid);
      expect(record.caller).toBe(detectCaller().kind);
      expect(record.osUser).toBeDefined();
      expect(['local', 'ssh']).toContain(record.transport);
    });

    it('assigns audit level to secrets events', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets', item: 'test-bundle' });

      const records = query({});
      const last = records[0];
      expect(last.level).toBe('audit');
      expect(last.event).toBe('secrets.get');
    });

    // PHNX-3695: emitAsync is the non-blocking twin for daemon tick paths — it
    // acquires the event-log lock with withFileLockAsync (no sleepSync), and must
    // write the same record emit does.
    it('emitAsync writes the same JSONL record as emit, without a sync lock', async () => {
      const logsDir = setupLogsDir();
      await emitAsync('info', { module: 'test', input: 'async-hello' });
      const content = fs.readFileSync(path.join(logsDir, 'events.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim().split('\n').pop()!);
      expect(record.event).toBe('info');
      expect(record.level).toBe('info');
      expect(record.input).toBe('async-hello');
      expect(record.pid).toBe(process.pid);
    });

    it('emitAsync does not freeze the loop while a peer holds the event-log lock', async () => {
      const logsDir = setupLogsDir();
      const logPath = path.join(logsDir, 'events.jsonl');
      fs.writeFileSync(logPath, ''); // exist so the lock target is present
      // Hold the event-log lock out-of-band for ~500ms.
      const release = await lockfile.lock(logPath, { stale: 2_500 });
      setTimeout(() => { void release(); }, 500);
      let timerFired = false;
      const t = setTimeout(() => { timerFired = true; }, 100);
      await emitAsync('info', { module: 'test' }); // must wait for the lock without blocking the loop
      clearTimeout(t);
      expect(timerFired).toBe(true); // the loop kept turning while contending for the lock
    }, 20_000);

    it('assigns warn level to warn events', () => {
      setupLogsDir();
      emit('warn', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('warn');
    });

    it('stamps the resolved actor + kind on every record (RUSH-2020)', () => {
      // Force an inherited actor via env so the resolve is deterministic offline.
      process.env.AGENTS_ACTOR = 'ada@example.com';
      process.env.AGENTS_ACTOR_KIND = 'human';
      resetActorCache();
      try {
        setupLogsDir();
        emit('info', { module: 'test' });
        const rec = query({})[0];
        expect(rec.actor).toBe('ada@example.com');
        expect(rec.kind).toBe('human');
      } finally {
        delete process.env.AGENTS_ACTOR;
        delete process.env.AGENTS_ACTOR_KIND;
        resetActorCache();
      }
    });

    it('stamps the provenance floor (full sessionId, agent, launchId, parentSessionId, machineId) from env', () => {
      process.env.AGENT_SESSION_ID = '11111111-2222-3333-4444-555555555555';
      process.env.AGENTS_AGENT_NAME = 'claude';
      process.env.AGENT_LAUNCH_ID = 'launch-abc';
      process.env.AGENTS_PARENT_SESSION_ID = '99999999-8888-7777-6666-555555555555';
      try {
        setupLogsDir();
        emit('info', { module: 'test' });
        const rec = query({})[0];
        // Full untruncated session id — the new floor field, stamped unconditionally
        // (unlike the caller-gated 8-char `session`, which needs CLAUDECODE/terminal env).
        expect(rec.sessionId).toBe('11111111-2222-3333-4444-555555555555');
        expect(rec.agent).toBe('claude');
        expect(rec.launchId).toBe('launch-abc');
        expect(rec.parentSessionId).toBe('99999999-8888-7777-6666-555555555555');
        // machineId is always present and joinable (normalized).
        expect(rec.machineId).toBeDefined();
        expect(rec.machineId).toBe(rec.machineId!.toLowerCase());
      } finally {
        delete process.env.AGENT_SESSION_ID;
        delete process.env.AGENTS_AGENT_NAME;
        delete process.env.AGENT_LAUNCH_ID;
        delete process.env.AGENTS_PARENT_SESSION_ID;
      }
    });

    it('lets an explicit payload field override the env provenance default', () => {
      process.env.AGENTS_AGENT_NAME = 'claude';
      try {
        setupLogsDir();
        // cloud.dispatch passes its own task agent — it must win over the env default.
        emit('cloud.dispatch', { module: 'cloud', agent: 'codex' });
        const rec = query({})[0];
        expect(rec.agent).toBe('codex');
      } finally {
        delete process.env.AGENTS_AGENT_NAME;
      }
    });

    it('assigns debug level to debug events', () => {
      setupLogsDir();
      emit('debug', { module: 'test' });

      const records = query({});
      expect(records[0].level).toBe('debug');
    });

    it('does not let payload metadata override the detected caller', () => {
      setupLogsDir();
      emit('info', { module: 'test', caller: 'forged' });

      const records = query({});
      expect(records[0].caller).toBe(detectCaller().kind);
    });

    it('respects AGENTS_DISABLE_EVENT_LOG', () => {
      const logsDir = setupLogsDir();
      process.env.AGENTS_DISABLE_EVENT_LOG = '1';
      emit('info', { module: 'test' });

      const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
      if (files.length > 0) {
        const content = fs.readFileSync(path.join(logsDir, files[0]), 'utf-8').trim();
        expect(content).toBe('');
      } else {
        expect(files.length).toBe(0);
      }
    });

    it('emitFriction writes a friction event with surface and failureId', () => {
      const logsDir = setupLogsDir();
      emitFriction('teams', 'remote-cwd-on-add', { error: 'cannot use --remote-cwd' });

      const files = fs.readdirSync(logsDir).filter(f => f === 'events.jsonl');
      expect(files).toEqual(['events.jsonl']);

      const content = fs.readFileSync(path.join(logsDir, 'events.jsonl'), 'utf-8');
      const record = JSON.parse(content.trim().split('\n').pop()!);
      expect(record.event).toBe('friction');
      expect(record.surface).toBe('teams');
      expect(record.failureId).toBe('remote-cwd-on-add');
      expect(record.error).toBe('cannot use --remote-cwd');
      expect(record.level).toBe('info');
      expect(record.ts).toBeDefined();
      expect(record.hostname).toBeDefined();
    });
  });

  describe('redaction', () => {
    it('redactPrompt returns length and truncated sha256', () => {
      const result = redactPrompt('my secret prompt');
      expect(result.prompt_length).toBe(16);
      expect(result.prompt_sha256).toBeDefined();
      expect(result.prompt_sha256!.length).toBe(16);
    });

    it('redactPrompt returns empty for null', () => {
      expect(redactPrompt(null)).toEqual({});
      expect(redactPrompt(undefined)).toEqual({});
    });

    it('redactArgs masks token-like values', () => {
      const result = redactArgs(['--token', 'sk_live_abc123', '--name', 'safe']);
      expect(result).toEqual(['--token', '[REDACTED]', '--name', 'safe']);
    });

    it('redactArgs masks secret paths', () => {
      const result = redactArgs(['/home/user/.env']);
      expect(result).toEqual(['[REDACTED]']);
    });

    it('redactArgs masks GitHub tokens', () => {
      expect(redactArgs(['ghp_xxxxxxxxxxxx'])).toEqual(['[REDACTED]']);
    });

    it('redactArgs masks sensitive flag values regardless of token format', () => {
      const sentinel = 'plain-value-that-does-not-look-like-a-token';
      expect(redactArgs([
        '--value', sentinel,
        `--body=${sentinel}`,
        '--password', sentinel,
        `--api-key=${sentinel}`,
        '--auth', sentinel,
      ])).toEqual([
        '--value', '[REDACTED]',
        '--body=[REDACTED]',
        '--password', '[REDACTED]',
        '--api-key=[REDACTED]',
        '--auth', '[REDACTED]',
      ]);
    });

    it('redactArgs hashes long prompt values without retaining raw text', () => {
      const prompt = 'sensitive prompt '.repeat(20);
      const result = redactArgs(['--prompt', prompt])!;
      expect(result[1]).toMatch(/^\[REDACTED prompt length=340 sha256=[a-f0-9]{16}\]$/);
      expect(result.join(' ')).not.toContain(prompt);
    });

    it('emit strips raw secrets and prompts from arbitrary payload fields', () => {
      const dir = setupLogsDir();
      const sentinel = 'known-secret-sentinel-460';
      emit('secrets.get', {
        module: 'secrets',
        apiToken: sentinel,
        prompt: `decide using ${sentinel}`,
        nested: { auth: sentinel },
      });

      const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8');
      expect(raw).not.toContain(sentinel);
      const record = JSON.parse(raw);
      expect(record.apiToken).toBe('[REDACTED]');
      expect(record.nested.auth).toBe('[REDACTED]');
      expect(record.prompt_length).toBeDefined();
      expect(record.prompt_sha256).toBeDefined();
    });
  });

  describe('caller detection', () => {
    it('detects Claude Code and preserves its short session', () => {
      expect(detectCaller({ CLAUDECODE: '1', AGENT_SESSION_ID: '12345678-rest' }, true))
        .toEqual({ kind: 'claude-code', session: '12345678' });
    });

    it.each([
      ['CX-123', 'codex'],
      ['GX-123', 'gemini'],
      ['CR-123', 'cursor'],
      ['CC-123', 'claude'],
    ])('maps swarmify terminal %s to %s', (terminalId, kind) => {
      expect(detectCaller({ AGENT_TERMINAL_ID: terminalId }, true)).toEqual({ kind });
    });

    it('distinguishes direct terminal and script invocations', () => {
      expect(detectCaller({}, true)).toEqual({ kind: 'terminal' });
      expect(detectCaller({}, false)).toEqual({ kind: 'script' });
    });
  });

  describe('truncate', () => {
    it('truncates long strings with ellipsis', () => {
      const long = 'a'.repeat(600);
      const result = truncate(long, 100);
      expect(result!.length).toBe(100);
      expect(result!.endsWith('...')).toBe(true);
    });

    it('returns short strings unchanged', () => {
      expect(truncate('short', 100)).toBe('short');
    });

    it('returns undefined for null', () => {
      expect(truncate(null)).toBeUndefined();
    });
  });

  describe('query', () => {
    it('reads and filters events by event type', () => {
      setupLogsDir();
      emit('info', { module: 'test', input: 'a' });
      emit('warn', { module: 'test', input: 'b' });
      emit('info', { module: 'test', input: 'c' });

      const results = query({ eventTypes: ['info'] });
      expect(results.length).toBe(2);
      for (const r of results) expect(r.event).toBe('info');
    });

    it('filters by level', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const audits = query({ level: 'audit' });
      expect(audits.length).toBe(1);
      expect(audits[0].event).toBe('secrets.get');

      const warns = query({ level: 'warn' });
      expect(warns.length).toBe(1);
    });

    it('filters by module', () => {
      setupLogsDir();
      emit('info', { module: 'secrets' });
      emit('info', { module: 'teams' });

      const results = query({ module: 'secrets' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('secrets');
    });

    it('filters by sessionId — the scoped read enrichCachedSessionMeta uses instead of a transcript re-scan', () => {
      setupLogsDir();
      emit('browser.navigate', { sessionId: 'sess-a', url: 'https://x' });
      emit('browser.navigate', { sessionId: 'sess-b', url: 'https://y' });
      emit('computer.action', { sessionId: 'sess-a', command: 'click' });

      const forA = query({ sessionId: 'sess-a' });
      expect(forA).toHaveLength(2);
      expect(forA.every((r) => r.sessionId === 'sess-a')).toBe(true);

      expect(query({ sessionId: 'sess-b' })).toHaveLength(1);
      expect(query({ sessionId: 'sess-does-not-exist' })).toHaveLength(0);
    });

    it('filters by environment-derived caller identity', () => {
      setupLogsDir();
      emit('info', { module: 'test' });

      expect(query({ caller: detectCaller().kind })).toHaveLength(1);
      expect(query({ caller: 'not-this-caller' })).toHaveLength(0);
    });

    it('filters by command prefix', () => {
      setupLogsDir();
      emit('command.start', { command: 'teams create', module: 'teams' });
      emit('command.start', { command: 'teams add', module: 'teams' });
      emit('command.start', { command: 'secrets get', module: 'secrets' });

      const results = query({ command: 'teams' });
      expect(results.length).toBe(2);
    });

    it('respects limit', () => {
      setupLogsDir();
      for (let i = 0; i < 10; i++) emit('info', { module: 'test', i });

      const results = query({ limit: 3 });
      expect(results.length).toBe(3);
    });

    it('reads gzipped log files', () => {
      const logsDir = setupLogsDir();
      const record = {
        ts: new Date().toISOString(),
        tz: '+00:00', tzName: 'UTC',
        hostname: 'test', platform: 'linux', arch: 'x64',
        pid: 1, ppid: 0,
        event: 'info', level: 'info',
        osUser: 'test', transport: 'local',
        module: 'gztest',
      };
      const gzPath = path.join(logsDir, 'events.1.jsonl.gz');
      fs.writeFileSync(gzPath, gzipSync(Buffer.from(JSON.stringify(record) + '\n')));

      const results = query({ module: 'gztest' });
      expect(results.length).toBe(1);
      expect(results[0].module).toBe('gztest');
    });
  });

  describe('rotation', () => {
    it('rotates repeatedly at 10 MB without overwriting older archives', () => {
      const logsDir = setupLogsDir();
      const active = path.join(logsDir, 'events.jsonl');
      const oversized = (marker: string) => JSON.stringify({ marker, padding: 'x'.repeat(10 * 1024 * 1024) }) + '\n';

      fs.writeFileSync(active, oversized('first'));
      emit('info', { module: 'rotation', marker: 'first-trigger' });
      expect(fs.existsSync(path.join(logsDir, 'events.1.jsonl.gz'))).toBe(true);

      fs.writeFileSync(active, oversized('second'));
      emit('info', { module: 'rotation', marker: 'second-trigger' });
      const newest = gunzipSync(fs.readFileSync(path.join(logsDir, 'events.1.jsonl.gz'))).toString('utf-8');
      const older = gunzipSync(fs.readFileSync(path.join(logsDir, 'events.2.jsonl.gz'))).toString('utf-8');
      expect(newest).toContain('second');
      expect(older).toContain('first');
      expect(fs.statSync(active).size).toBe(0);
    });

    it('removes archives older than the retention period', () => {
      const logsDir = setupLogsDir();
      const gzFile = path.join(logsDir, 'events.1.jsonl.gz');
      fs.writeFileSync(gzFile, gzipSync(Buffer.from('{"event":"info"}\n')));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(gzFile, old, old);

      const result = rotate(7);
      expect(result.removedByAge).toBe(1);
      expect(result.removedBySize).toBe(0);
      expect(fs.existsSync(gzFile)).toBe(false);
    });

    it('runs retention from the central emit path', () => {
      const logsDir = setupLogsDir();
      const gzFile = path.join(logsDir, 'events.1.jsonl.gz');
      fs.writeFileSync(gzFile, gzipSync(Buffer.from('{"event":"info"}\n')));
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(gzFile, old, old);

      emit('info', { module: 'prune-trigger' });

      expect(fs.existsSync(gzFile)).toBe(false);
      expect(query({ module: 'prune-trigger' })).toHaveLength(1);
    });

    it('writes into a local-date directory under .history/events', () => {
      const userDir = makeTempDir();
      _resetForTest(undefined, userDir);

      emit('info', { module: 'dated-layout' });

      const expectedDay = [
        new Date().getFullYear(),
        String(new Date().getMonth() + 1).padStart(2, '0'),
        String(new Date().getDate()).padStart(2, '0'),
      ].join('-');
      const expected = path.join(userDir, '.history', 'events', expectedDay, 'events.jsonl');
      expect(getLogsPath()).toBe(expected);
      expect(fs.existsSync(expected)).toBe(true);
    });

    it('migrates root event files without losing queryable records', () => {
      const userDir = makeTempDir();
      const legacyActive = path.join(userDir, 'events.jsonl');
      const legacyArchive = path.join(userDir, 'events.1.jsonl.gz');
      const record = (module: string) => JSON.stringify({
        ts: new Date().toISOString(), event: 'info', level: 'info', module,
      }) + '\n';
      fs.writeFileSync(legacyActive, record('legacy-active'));
      fs.writeFileSync(legacyArchive, gzipSync(Buffer.from(record('legacy-archive'))));
      _resetForTest(undefined, userDir);

      emit('info', { module: 'new-write' });

      expect(fs.existsSync(legacyActive)).toBe(false);
      expect(fs.existsSync(legacyArchive)).toBe(false);
      expect(query({}).map((entry) => entry.module)).toEqual(
        expect.arrayContaining(['legacy-active', 'legacy-archive', 'new-write']),
      );
    });

    it('migrates the interim flat history layout shipped by v14', () => {
      const userDir = makeTempDir();
      const interimDir = path.join(userDir, '.history', 'events');
      fs.mkdirSync(interimDir, { recursive: true });
      const record = (module: string) => JSON.stringify({
        ts: new Date().toISOString(), event: 'info', level: 'info', module,
      }) + '\n';
      const interimActive = path.join(interimDir, 'events.jsonl');
      const interimArchive = path.join(interimDir, 'events.1.jsonl.gz');
      fs.writeFileSync(interimActive, record('interim-active'));
      fs.writeFileSync(interimArchive, gzipSync(Buffer.from(record('interim-archive'))));
      _resetForTest(undefined, userDir);

      emit('info', { module: 'new-write' });

      expect(fs.existsSync(interimActive)).toBe(false);
      expect(fs.existsSync(interimArchive)).toBe(false);
      expect(query({}).map((entry) => entry.module)).toEqual(
        expect.arrayContaining(['interim-active', 'interim-archive', 'new-write']),
      );
    });

    it('removes the oldest files until the total storage ceiling is met', () => {
      const logsDir = setupLogsDir();
      const active = path.join(logsDir, 'events.jsonl');
      fs.writeFileSync(active, '{"event":"info"}\n');
      for (let i = 1; i <= 3; i++) {
        const archive = path.join(logsDir, `events.${i}.jsonl.gz`);
        fs.writeFileSync(archive, Buffer.alloc(1024, i));
        const stamp = new Date(Date.now() - (4 - i) * 60_000);
        fs.utimesSync(archive, stamp, stamp);
      }

      const result = rotate(365, 1500);
      const remainingBytes = fs.readdirSync(logsDir)
        .filter((name) => name === 'events.jsonl' || name.endsWith('.jsonl.gz'))
        .reduce((sum, name) => sum + fs.statSync(path.join(logsDir, name)).size, 0);
      expect(result.removedBySize).toBe(2);
      expect(result.bytesReclaimed).toBe(2048);
      expect(remainingBytes).toBeLessThanOrEqual(1500);
    });

    it('keeps the source mtime when finalizing a past day so age pruning removes it', () => {
      const userDir = makeTempDir();
      _resetForTest(undefined, userDir);
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const day = [
        old.getFullYear(),
        String(old.getMonth() + 1).padStart(2, '0'),
        String(old.getDate()).padStart(2, '0'),
      ].join('-');
      const dayDir = path.join(userDir, '.history', 'events', day);
      fs.mkdirSync(dayDir, { recursive: true });
      const raw = path.join(dayDir, 'events.jsonl');
      fs.writeFileSync(raw, '{"event":"info"}\n');
      fs.utimesSync(raw, old, old);

      const result = rotate(7);

      expect(result.removedByAge).toBe(1);
      expect(fs.existsSync(dayDir)).toBe(false);
    });

    it('serializes past-day finalization with migration archive allocation', async () => {
      const home = makeTempDir();
      const dayDir = path.join(home, '.agents', '.history', 'events', '2026-07-01');
      fs.mkdirSync(dayDir, { recursive: true });
      const raw = path.join(dayDir, 'events.jsonl');
      fs.writeFileSync(raw, '{"event":"info"}\n');
      const release = await lockfile.lock(raw);
      const modulePath = path.resolve('src/lib/feed/events.ts');
      const child = spawn(
        'node',
        ['--import', 'tsx', '-e', `console.log('READY'); const { rotate } = await import(${JSON.stringify(modulePath)}); rotate(365);`],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home, AGENTS_EVENTS_PATH: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.once('data', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(path.join(dayDir, 'events.1.jsonl.gz'))).toBe(false);

      await release();
      const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));

      expect(exitCode).toBe(0);
      expect(fs.existsSync(path.join(dayDir, 'events.1.jsonl.gz'))).toBe(true);
    });

    it('queries rotated archives when AGENTS_EVENTS_PATH has a custom filename', () => {
      const logsDir = makeTempDir();
      _resetForTest(path.join(logsDir, 'custom-events.jsonl'));
      fs.writeFileSync(getLogsPath(), `${' '.repeat(10 * 1024 * 1024)}\n`);

      emit('info', { module: 'custom-override-trigger' });

      expect(query({ module: 'custom-override-trigger' })).toHaveLength(1);
      expect(fs.existsSync(path.join(logsDir, 'events.1.jsonl.gz'))).toBe(true);
    });
  });

  describe('stats', () => {
    it('returns aggregate statistics', () => {
      setupLogsDir();
      emit('secrets.get', { module: 'secrets' });
      emit('info', { module: 'test' });
      emit('warn', { module: 'test' });

      const s = stats({ days: 1 });
      expect(s.totalEvents).toBe(3);
      expect(s.byLevel.audit).toBe(1);
      expect(s.byLevel.info).toBe(1);
      expect(s.byLevel.warn).toBe(1);
      expect(s.byEvent['secrets.get']).toBe(1);
      expect(s.byModule.secrets).toBe(1);
      expect(s.fileCount).toBe(1);
    });

    it('groups events by actor (RUSH-2020)', () => {
      process.env.AGENTS_ACTOR = 'grace@example.com';
      process.env.AGENTS_ACTOR_KIND = 'human';
      resetActorCache();
      try {
        setupLogsDir();
        emit('info', { module: 'test' });
        emit('warn', { module: 'test' });
        const s = stats({ days: 1 });
        expect(s.byActor['grace@example.com']).toBe(2);
      } finally {
        delete process.env.AGENTS_ACTOR;
        delete process.env.AGENTS_ACTOR_KIND;
        resetActorCache();
      }
    });
  });

  describe('performance', () => {
    it('handles 10k records without excessive time', () => {
      setupLogsDir();
      const start = Date.now();
      for (let i = 0; i < 10_000; i++) {
        emit('info', { module: 'perf', i });
      }
      const writeMs = Date.now() - start;

      const qStart = Date.now();
      const results = query({ module: 'perf', limit: 10_000 });
      const readMs = Date.now() - qStart;

      expect(results.length).toBe(10_000);
      expect(writeMs).toBeLessThan(30_000);
      expect(readMs).toBeLessThan(10_000);
    });
  });

  describe('emitStart / emitCommand', () => {
    it('emitStart pairs start/end events with duration', () => {
      setupLogsDir();
      const done = emitStart('agent.run.start', { agent: 'claude' });
      done({ exitCode: 0 });

      const results = query({});
      const startRec = results.find(r => r.event === 'agent.run.start');
      const endRec = results.find(r => r.event === 'agent.run.end');
      expect(startRec).toBeDefined();
      expect(endRec).toBeDefined();
      expect(endRec!.durationMs).toBeGreaterThanOrEqual(0);
      expect(endRec!.exitCode).toBe(0);
    });

    it('emitCommand captures command name and args', () => {
      setupLogsDir();
      const done = emitCommand('run', ['claude', '-p', 'hi']);
      done({ exitCode: 0 });

      const results = query({ eventTypes: ['command.start'] });
      expect(results.length).toBe(1);
      expect(results[0].command).toBe('run');
      expect(results[0].args).toEqual(['claude', '-p', 'hi']);
    });
  });

  describe('activity event types', () => {
    it('accepts checklist events in the EventType union through emit/query', () => {
      setupLogsDir();
      emit('task.completed', { agent: 'claude', detail: 'Write tests 2/3 done' });
      emit('checklist.created', { agent: 'claude', detail: '3 tasks' });

      const tasks = query({ eventTypes: ['task.completed'] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].event).toBe('task.completed');
      expect(tasks[0].detail).toBe('Write tests 2/3 done');

      const lists = query({ eventTypes: ['checklist.created'] });
      expect(lists).toHaveLength(1);
      expect(lists[0].event).toBe('checklist.created');
    });
  });
});

describeEvents('event-kind table (the drift guard for out-of-process producers)', () => {
  it('exposes every union member at runtime, including the factory.* kinds', () => {
    // EVENT_TYPES is derived from a Record<EventType, true>, so tsc already
    // rejects a union member with no table entry. This pins the runtime half:
    // isEventType is what `agents events emit` uses to reject an unknown kind.
    for (const kind of ['factory.command', 'factory.action', 'factory.uri', 'factory.launch']) {
      expect(EVENT_TYPES).toContain(kind);
      expect(isEventType(kind)).toBe(true);
    }
    expect(EVENT_TYPES).toContain('command.start');
    expect(EVENT_TYPES).toContain('status.posted');
  });

  it('registers browser.navigate, browser.screenshot, and computer.action as real, non-audit kinds (#11)', () => {
    // browser.navigate/browser.screenshot were declared in the EventType union
    // but never emitted anywhere — this pins them (and the new computer.action
    // kind) as accepted, info-level events now that BrowserService and the
    // computer action recording actually calls emit() with them.
    for (const kind of ['browser.navigate', 'browser.screenshot', 'computer.action']) {
      expect(EVENT_TYPES).toContain(kind);
      expect(isEventType(kind)).toBe(true);
      expect(levelFor(kind as never)).toBe('info');
    }
  });

  it('rejects a near-miss kind rather than accepting a typo', () => {
    expect(isEventType('factory.clik')).toBe(false);
    expect(isEventType('')).toBe(false);
    expect(isEventType('Factory.Command')).toBe(false);
  });

  it('registers routine.start/end and watchdog.action as info (daemon scheduler coverage)', () => {
    for (const kind of ['routine.start', 'routine.end', 'watchdog.action'] as const) {
      expect(EVENT_TYPES).toContain(kind);
      expect(isEventType(kind)).toBe(true);
      expect(levelFor(kind)).toBe('info');
    }
    expect(levelFor('daemon.start')).toBe('audit');
    expect(levelFor('daemon.info')).toBe('info');
  });

  it('classifies run.launch as audit — the sibling of run.dispatched, the reliable stuck-launch signal', () => {
    expect(EVENT_TYPES).toContain('run.launch');
    expect(isEventType('run.launch')).toBe(true);
    expect(levelFor('run.launch')).toBe('audit');
    // Same lane as its finalize-time sibling, so `--level audit --include runs`
    // surfaces both.
    expect(levelFor('run.dispatched')).toBe('audit');
  });

  it('classifies factory.uri as audit and the other factory kinds as info', () => {
    // An external process driving the user's editor is a "who reached in" fact.
    expect(levelFor('factory.uri')).toBe('audit');
    // A palette press is not.
    expect(levelFor('factory.command')).toBe('info');
    expect(levelFor('factory.action')).toBe('info');
    expect(levelFor('factory.launch')).toBe('info');
  });

  it('writes routine and watchdog events onto the unified stream with filterable modules', () => {
    setupLogsDir();
    emit('routine.start', { module: 'routine', name: 'check-updates', kind: 'command' });
    emit('routine.end', { module: 'routine', name: 'check-updates', status: 'completed', durationMs: 12 });
    emit('watchdog.action', { module: 'watchdog', total: 3, stalled: 1, nudged: 1 });

    const records = query({});
    expect(records.map((r) => r.event)).toEqual([
      'watchdog.action',
      'routine.end',
      'routine.start',
    ]);
    expect(records.every((r) => r.level === 'info')).toBe(true);
    expect(query({ module: 'routine' }).map((r) => r.event)).toEqual([
      'routine.end',
      'routine.start',
    ]);
    expect(query({ module: 'watchdog' })).toHaveLength(1);
    expect(query({ module: 'watchdog' })[0]).toMatchObject({
      event: 'watchdog.action',
      total: 3,
      stalled: 1,
      nudged: 1,
    });
  });
});

describeEventsIo('emit() timestamp override', () => {
  it('honours a caller-supplied ts so a batched producer keeps real event times', () => {
    setupLogsDir();
    const happenedAt = '2026-08-03T01:02:03.000Z';

    emit('factory.command', { module: 'factory' }, { ts: happenedAt });

    const records = query({});
    expect(records).toHaveLength(1);
    expect(records[0].ts).toBe(happenedAt);
  });

  it('still refuses a ts smuggled through the PAYLOAD', () => {
    setupLogsDir();
    const forged = '1999-01-01T00:00:00.000Z';

    // ts stays in RESERVED_META_KEYS: only the explicit override channel may set
    // it, so an arbitrary payload cannot backdate a record.
    emit('factory.command', { ts: forged } as unknown as Record<string, unknown>);

    const records = query({});
    expect(records).toHaveLength(1);
    expect(records[0].ts).not.toBe(forged);
  });

  it('defaults to write time when no override is passed', () => {
    setupLogsDir();
    const before = Date.now();
    emit('factory.command', {});
    const ts = Date.parse(query({})[0].ts);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
