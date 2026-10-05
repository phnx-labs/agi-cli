import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DAEMON_SERVICE_IDS,
  readDaemonServicesConfig,
  writeDaemonServicesConfig,
  isDaemonServiceEnabled,
  setDaemonServiceEnabled,
  listDaemonServiceStates,
  getDaemonServicesConfigPath,
} from './daemon-services.js';

describe('daemon-services', () => {
  let tmpHome: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-services-test-'));
    originalConfigDir = process.env.AGENTS_DAEMON_CONFIG_DIR;
    process.env.AGENTS_DAEMON_CONFIG_DIR = path.join(tmpHome, 'daemon');
    fs.mkdirSync(process.env.AGENTS_DAEMON_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalConfigDir !== undefined) process.env.AGENTS_DAEMON_CONFIG_DIR = originalConfigDir;
    else delete process.env.AGENTS_DAEMON_CONFIG_DIR;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {  }
  });

  it('defaults every known service to enabled when config is missing', () => {
    const cfg = readDaemonServicesConfig();
    for (const id of DAEMON_SERVICE_IDS) {
      expect(cfg.services[id]).toBe(true);
      expect(isDaemonServiceEnabled(id)).toBe(true);
    }
  });

  it('persists a disabled toggle and reads it back', () => {
    setDaemonServiceEnabled('watchdog', false);
    expect(isDaemonServiceEnabled('watchdog')).toBe(false);

    const cfg = readDaemonServicesConfig();
    expect(cfg.services['watchdog']).toBe(false);
    expect(cfg.services['scheduler']).toBe(true);
  });

  it('listDaemonServiceStates reflects current toggles', () => {
    setDaemonServiceEnabled('scheduler', false);
    const states = listDaemonServiceStates();
    const scheduler = states.find((s) => s.id === 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler!.enabled).toBe(false);

    const watchdog = states.find((s) => s.id === 'watchdog');
    expect(watchdog!.enabled).toBe(true);
  });

  it('ignores unknown service ids without throwing', () => {
    const filePath = getDaemonServicesConfigPath();
    fs.writeFileSync(filePath, 'services:\n  watchdog: false\n  monitors: false\n  browser-ipc: false\n  unknown-service: false\n', 'utf-8');
    const cfg = readDaemonServicesConfig();
    expect(cfg.services['watchdog']).toBe(false);
    expect((cfg.services as Record<string, boolean>)['monitors']).toBeUndefined();
    expect((cfg.services as Record<string, boolean>)['browser-ipc']).toBeUndefined();
    expect(cfg.services['scheduler']).toBe(true);
  });

  it('writeDaemonServicesConfig preserves extra top-level fields', () => {
    const filePath = getDaemonServicesConfigPath();
    fs.writeFileSync(filePath, 'notes: "do not clobber"\nservices:\n  watchdog: false\n', 'utf-8');
    setDaemonServiceEnabled('watchdog', true);
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toContain('notes: do not clobber');
    expect(raw).toContain('watchdog: true');
  });
});
