import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as state from '../src/lib/state.js';

let TEST_ROOT: string;
let TEST_DAEMON_DIR: string;

vi.spyOn(state, 'getDaemonDir').mockImplementation(() => TEST_DAEMON_DIR);

import {
  readDaemonPid,
  writeDaemonPid,
  removeDaemonPid,
  readDaemonLog,
  log,
  getDaemonStatus,
  generateLaunchdPlist,
  generateSystemdUnit,
} from '../src/lib/daemon/daemon.js';

beforeEach(() => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'agents-cli-daemon-'));
  TEST_DAEMON_DIR = join(TEST_ROOT, 'daemon');
  mkdirSync(TEST_DAEMON_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('PID management', () => {
  it('returns null when no PID file exists', () => {
    expect(readDaemonPid()).toBeNull();
  });

  it('writes and reads PID', () => {
    writeDaemonPid(12345);
    expect(readDaemonPid()).toBe(12345);
  });

  it('removes PID file', () => {
    writeDaemonPid(12345);
    removeDaemonPid();
    expect(readDaemonPid()).toBeNull();
  });

  it('removeDaemonPid does not throw if no file exists', () => {
    expect(() => removeDaemonPid()).not.toThrow();
  });

  it('returns null for invalid PID content', () => {
    writeFileSync(join(TEST_DAEMON_DIR, 'daemon.pid'), 'not-a-number', 'utf-8');
    expect(readDaemonPid()).toBeNull();
  });
});

describe('logging', () => {
  it('appends JSONL log entries to daemon.log', () => {
    log('INFO', 'test message one');
    log('ERROR', 'test message two');

    const content = readDaemonLog();
    expect(content).toContain('"level":"INFO"');
    expect(content).toContain('"message":"test message one"');
    expect(content).toContain('"level":"ERROR"');
    expect(content).toContain('"message":"test message two"');
  });

  it('readDaemonLog with line limit returns last N lines', () => {
    for (let i = 0; i < 10; i++) {
      log('INFO', `line ${i}`);
    }

    const last3 = readDaemonLog(3);
    const lines = last3.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(last3).toContain('line 9');
  });

  it('readDaemonLog returns fallback when no log exists', () => {
    expect(readDaemonLog()).toBe('(no log file)');
  });
});

describe('getDaemonStatus', () => {
  it('reports not running when no PID file', () => {
    const status = getDaemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(typeof status.logPath).toBe('string');
  });

  it('reports not running for stale PID', () => {
    writeDaemonPid(999999999);
    const status = getDaemonStatus();
    expect(status.running).toBe(false);
  });
});

describe('generateLaunchdPlist', () => {
  it('generates valid plist XML', () => {
    const plist = generateLaunchdPlist();
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('com.phnx-labs.agents-daemon');
    expect(plist).toContain('__daemon-run');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
  });
});

describe('generateSystemdUnit', () => {
  it('generates valid systemd unit', () => {
    const unit = generateSystemdUnit();
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('"__daemon-run"');
    expect(unit).toContain('Restart=always');
  });
});
