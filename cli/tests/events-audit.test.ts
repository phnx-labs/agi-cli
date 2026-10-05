import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_VERSION = (JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'),
) as { version: string }).version;

const tempHomes: string[] = [];

function makeTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-events-'));
  tempHomes.push(home);
  const systemDir = path.join(home, '.agents', '.system');
  fs.mkdirSync(path.join(systemDir, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(systemDir, '.update-check'),
    JSON.stringify({ lastCheck: Date.now(), latestVersion: PACKAGE_VERSION }),
  );
  return home;
}

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync('node', ['--import', 'tsx', 'src/index.ts', ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, SHELL: '/bin/zsh', AGENTS_EVENTS_PATH: '', ...extraEnv },
    encoding: 'utf-8',
  });
}

function currentEventsPath(home: string): string {
  const now = new Date();
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return path.join(home, '.agents', '.history', 'events', day, 'events.jsonl');
}

function readEvents(home: string): Array<Record<string, unknown>> {
  const eventsPath = currentEventsPath(home);
  if (!fs.existsSync(eventsPath)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean)) {
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}

afterEach(() => {
  for (const h of tempHomes.splice(0)) {
    try {
      fs.rmSync(h, { recursive: true, force: true });
    } catch {
    }
  }
});

describe('audit event log', () => {
  it('records a command.start with module, command path, and local-user attribution', () => {
    const home = makeTempHome();
    runCli(home, ['config', 'list'], { SSH_CONNECTION: '' });

    const events = readEvents(home);
    const start = events.find((e) => e.event === 'command.start' && e.command === 'config list');
    expect(start, `no command.start for "config list" in ${JSON.stringify(events.map((e) => e.command))}`).toBeTruthy();
    expect(start!.module).toBe('config');
    expect(typeof start!.osUser).toBe('string');
    expect((start!.osUser as string).length).toBeGreaterThan(0);
    expect(start!.transport).toBe('local');
    expect(start!.sshClientIp).toBeUndefined();
  });

  it('attributes an SSH origin to a remote user (SSH_CONNECTION → transport + client IP)', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list'], {
      SSH_CONNECTION: '203.0.113.7 51828 10.0.0.3 22',
      SSH_TTY: '/dev/pts/4',
    });

    const events = readEvents(home);
    const start = events.find((e) => e.event === 'command.start');
    expect(start).toBeTruthy();
    expect(start!.transport).toBe('ssh');
    expect(start!.sshClientIp).toBe('203.0.113.7');
  });

  it('reads the trail back out and filters by module', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']);
    runCli(home, ['events', '--json']);

    const res = runCli(home, ['events', '--module', 'secrets', '--json']);
    expect(res.status).toBe(0);
    const records = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.module === 'secrets')).toBe(true);
  });

  it('--command matches a command path by prefix', () => {
    const home = makeTempHome();
    runCli(home, ['config', 'list']);

    const coarse = JSON.parse(runCli(home, ['events', '--command', 'config', '--json']).stdout) as Array<Record<string, unknown>>;
    expect(coarse.some((r) => r.command === 'config list')).toBe(true);
    const none = JSON.parse(runCli(home, ['events', '--command', 'teams', '--json']).stdout) as Array<Record<string, unknown>>;
    expect(none.length).toBe(0);
  });

  it('redacts a token-like positional arg before it hits the log', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'get', 'ghp_FAKETOKENVALUE123'], { SSH_CONNECTION: '' });

    const raw = fs.readFileSync(currentEventsPath(home), 'utf-8');
    expect(raw).not.toContain('ghp_FAKETOKENVALUE123');
    expect(raw).toContain('[REDACTED]');
  });

  it('--since with a sub-day window returns today\'s events (not just whole days)', () => {
    const home = makeTempHome();
    runCli(home, ['secrets', 'list']);

    const res = runCli(home, ['events', '--since', '2h', '--json']);
    expect(res.status).toBe(0);
    const records = JSON.parse(res.stdout) as Array<Record<string, unknown>>;
    expect(records.length).toBeGreaterThan(0);
  });

  it('records command.end with a numeric durationMs', () => {
    const home = makeTempHome();
    runCli(home, ['config', 'list']);

    const end = readEvents(home).find((e) => e.event === 'command.end' && e.command === 'config list');
    expect(end).toBeTruthy();
    expect(typeof end!.durationMs).toBe('number');
    expect(end!.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('the generic perf-warehouse sample for command.end carries sessionId + agent, not just cwd/duration', () => {
    const home = makeTempHome();
    const spoolPath = path.join(home, 'perf-spool.ndjson');
    runCli(home, ['config', 'list'], {
      AGENTS_PERF_SPOOL: spoolPath,
      AGENT_SESSION_ID: 'sess-perf-test-1',
      AGENTS_SESSION_ID: 'sess-perf-test-1',
      AGENTS_AGENT_NAME: 'claude',
    });

    expect(fs.existsSync(spoolPath)).toBe(true);
    const samples = fs
      .readFileSync(spoolPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const sample = samples.find((s) => s.kind === 'command.end' && s.label === 'config list');
    expect(sample).toBeTruthy();
    expect(sample!.session_id).toBe('sess-perf-test-1');
    expect(sample!.agent).toBe('claude');
  });
});
