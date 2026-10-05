import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emit, query, rotate, stats,
  _resetForTest,
} from '../lib/feed/events.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-logs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
  tempDirs.length = 0;
  _resetForTest();
});

function setupLogsDir(): string {
  const dir = makeTempDir();
  _resetForTest(path.join(dir, 'events.jsonl'));
  return dir;
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    ts: new Date().toISOString(),
    tz: '+00:00',
    tzName: 'UTC',
    hostname: 'testhost',
    platform: 'linux',
    arch: 'x64',
    pid: 1,
    ppid: 0,
    event: 'info',
    level: 'info',
    caller: 'script',
    osUser: 'testuser',
    transport: 'local',
    ...overrides,
  };
}

describe('logs audit subcommand data path', () => {
  it('is a compatibility alias for the canonical events audit reader', () => {
    const logsDir = setupLogsDir();
    const systemDir = path.join(logsDir, '.agents', '.system');
    fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
    const packageVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version;
    fs.writeFileSync(
      path.join(systemDir, '.update-check'),
      JSON.stringify({ lastCheck: Date.now(), latestVersion: packageVersion }),
    );
    emit('info', { module: 'alias-fixture', detail: 'same-reader' });
    const run = (args: string[]) => spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: logsDir,
        AGENTS_EVENTS_PATH: path.join(logsDir, 'events.jsonl'),
        AGENTS_SKIP_MIGRATION: '1',
      },
      encoding: 'utf-8',
    });

    const events = run(['events', '--include', 'ops', '--module', 'alias-fixture', '--json']);
    const logs = run(['logs', 'audit', '--module', 'alias-fixture', '--json']);

    expect(events.status).toBe(0);
    expect(logs.status).toBe(0);
    expect(JSON.parse(logs.stdout)).toEqual(JSON.parse(events.stdout));
  });

  it('query reads events written by emit for audit viewer', () => {
    setupLogsDir();
    emit('teams.create', { module: 'teams', team: 'alpha' });
    emit('secrets.get', { module: 'secrets', item: 'prod-key' });
    emit('info', { module: 'test' });

    const auditOnly = query({ level: 'audit' });
    expect(auditOnly.length).toBe(2);
    expect(auditOnly.every(r => r.level === 'audit')).toBe(true);
  });

  it('query reads gzipped archives transparently', () => {
    const logsDir = setupLogsDir();
    const record = makeRecord({ event: 'cloud.dispatch', level: 'audit', module: 'cloud', taskId: 'gz-task' });
    const gzPath = path.join(logsDir, 'events.1.jsonl.gz');
    fs.writeFileSync(gzPath, gzipSync(Buffer.from(JSON.stringify(record) + '\n')));

    const results = query({ module: 'cloud' });
    expect(results.length).toBe(1);
    expect(results[0].taskId).toBe('gz-task');
  });

  it('stats aggregates across event types and levels', () => {
    setupLogsDir();
    emit('teams.create', { module: 'teams' });
    emit('teams.add', { module: 'teams' });
    emit('info', { module: 'test' });

    const s = stats({ days: 1 });
    expect(s.totalEvents).toBe(3);
    expect(s.byModule.teams).toBe(2);
  });

  it('rotate removes old files and returns count', () => {
    const logsDir = setupLogsDir();
    const archive = path.join(logsDir, 'events.1.jsonl.gz');
    fs.writeFileSync(archive, gzipSync(Buffer.from('{"event":"info"}\n')));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    fs.utimesSync(archive, old, old);

    const result = rotate(7);
    expect(result.removedByAge).toBe(1);
  });
});
