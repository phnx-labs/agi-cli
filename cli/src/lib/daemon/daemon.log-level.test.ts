import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDaemonLogPath, log, setDaemonLogLevel } from './daemon.js';
import { readDaemonLogLevel, writeDaemonLogLevel, getDaemonServicesConfigPath } from '../daemon-services.js';

let root = '';
const saved = { dir: process.env.AGENTS_DAEMON_DIR, config: process.env.AGENTS_DAEMON_CONFIG_DIR, level: process.env.AGENTS_DAEMON_LOG_LEVEL };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-daemon-loglevel-'));
  process.env.AGENTS_DAEMON_DIR = path.join(root, 'daemon');
  process.env.AGENTS_DAEMON_CONFIG_DIR = path.join(root, 'config');
  delete process.env.AGENTS_DAEMON_LOG_LEVEL;
  fs.mkdirSync(process.env.AGENTS_DAEMON_DIR, { recursive: true });
});

afterEach(() => {
  setDaemonLogLevel('INFO');
  for (const [key, value] of [['AGENTS_DAEMON_DIR', saved.dir], ['AGENTS_DAEMON_CONFIG_DIR', saved.config], ['AGENTS_DAEMON_LOG_LEVEL', saved.level]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function lines(): Array<{ level: string; message: string; data?: Record<string, unknown> }> {
  return fs.readFileSync(getDaemonLogPath(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('daemon log levels and structured fields', () => {
  it('drops debug at the default info level and writes it once the level is debug', () => {
    log('DEBUG', 'tick start', { event: 'tick.start' });
    log('INFO', 'kept');
    setDaemonLogLevel('DEBUG');
    log('DEBUG', 'tick ok', { event: 'tick.ok', durMs: 12 });
    expect(lines().map((l) => [l.level, l.message])).toEqual([['INFO', 'kept'], ['DEBUG', 'tick ok']]);
    expect(lines()[1].data).toEqual({ event: 'tick.ok', durMs: 12 });
  });

  it('redacts credential-shaped strings inside structured fields, not just the message', () => {
    log('WARN', 'push failed', { event: 'tick.failed', error: 'auth header Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rejected', nested: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } });
    const raw = fs.readFileSync(getDaemonLogPath(), 'utf-8');
    expect(raw).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(raw).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines()[0].data?.event).toBe('tick.failed');
  });

  it('stores the level in services.yaml without touching the service toggles, and the env var overrides it', () => {
    fs.mkdirSync(process.env.AGENTS_DAEMON_CONFIG_DIR!, { recursive: true });
    fs.writeFileSync(getDaemonServicesConfigPath(), 'services:\n  watchdog: false\n');
    expect(readDaemonLogLevel()).toBe('INFO');
    writeDaemonLogLevel('DEBUG');
    expect(readDaemonLogLevel()).toBe('DEBUG');
    expect(fs.readFileSync(getDaemonServicesConfigPath(), 'utf-8')).toMatch(/watchdog: false[\s\S]*logLevel: debug/);
    process.env.AGENTS_DAEMON_LOG_LEVEL = 'warn';
    expect(readDaemonLogLevel()).toBe('WARN');
  });

  it('an unknown stored level fails loud instead of silently logging at some other level', () => {
    fs.mkdirSync(process.env.AGENTS_DAEMON_CONFIG_DIR!, { recursive: true });
    fs.writeFileSync(getDaemonServicesConfigPath(), 'logLevel: verbose\n');
    expect(() => readDaemonLogLevel()).toThrow(/logLevel 'verbose' is not one of debug, info, warn, error/);
  });
});
