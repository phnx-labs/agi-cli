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

  it('defaults the opt-in recordings service off and existing services on', () => {
    const cfg = readDaemonServicesConfig();
    for (const id of DAEMON_SERVICE_IDS) {
      const expected = id !== 'recordings';
      expect(cfg.services[id]).toBe(expected);
      expect(isDaemonServiceEnabled(id)).toBe(expected);
    }
  });

  it('persists a disabled toggle and reads it back', () => {
    setDaemonServiceEnabled('device-probe', false);
    expect(isDaemonServiceEnabled('device-probe')).toBe(false);

    const cfg = readDaemonServicesConfig();
    expect(cfg.services['device-probe']).toBe(false);
    expect(cfg.services['session-index']).toBe(true);
  });

  it('listDaemonServiceStates reflects current toggles', () => {
    setDaemonServiceEnabled('session-index', false);
    const states = listDaemonServiceStates();
    const sessionIndex = states.find((s) => s.id === 'session-index');
    expect(sessionIndex).toBeDefined();
    expect(sessionIndex!.enabled).toBe(false);

    const deviceProbe = states.find((s) => s.id === 'device-probe');
    expect(deviceProbe!.enabled).toBe(true);
  });

  it('ignores unknown service ids without throwing', () => {
    const filePath = getDaemonServicesConfigPath();
    fs.writeFileSync(filePath, 'services:\n  device-probe: false\n  watchdog: false\n  monitors: false\n  browser-ipc: false\n  scheduler: false\n  catchup: false\n  unknown-service: false\n', 'utf-8');
    const cfg = readDaemonServicesConfig();
    expect(cfg.services['device-probe']).toBe(false);
    expect((cfg.services as Record<string, boolean>)['watchdog']).toBeUndefined();
    expect((cfg.services as Record<string, boolean>)['monitors']).toBeUndefined();
    expect((cfg.services as Record<string, boolean>)['browser-ipc']).toBeUndefined();
    expect((cfg.services as Record<string, boolean>)['scheduler']).toBeUndefined();
    expect((cfg.services as Record<string, boolean>)['catchup']).toBeUndefined();
    expect(cfg.services['session-index']).toBe(true);
  });

  it('writeDaemonServicesConfig preserves extra top-level fields', () => {
    const filePath = getDaemonServicesConfigPath();
    fs.writeFileSync(filePath, 'notes: "do not clobber"\nservices:\n  device-probe: false\n', 'utf-8');
    setDaemonServiceEnabled('device-probe', true);
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toContain('notes: do not clobber');
    expect(raw).toContain('device-probe: true');
  });
});
