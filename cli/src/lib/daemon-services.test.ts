/**
 * Unit tests for daemon service catalog and toggle config.
 */
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
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('defaults every known service to enabled when config is missing', () => {
    const cfg = readDaemonServicesConfig();
    for (const id of DAEMON_SERVICE_IDS) {
      expect(cfg.services[id]).toBe(true);
      expect(isDaemonServiceEnabled(id)).toBe(true);
    }
  });

  it('persists a disabled toggle and reads it back', () => {
    setDaemonServiceEnabled('monitors', false);
    expect(isDaemonServiceEnabled('monitors')).toBe(false);

    const cfg = readDaemonServicesConfig();
    expect(cfg.services['monitors']).toBe(false);
    // Other services stay enabled.
    expect(cfg.services['scheduler']).toBe(true);
  });

  it('listDaemonServiceStates reflects current toggles', () => {
    setDaemonServiceEnabled('scheduler', false);
    const states = listDaemonServiceStates();
    const scheduler = states.find((s) => s.id === 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler!.enabled).toBe(false);

    const monitors = states.find((s) => s.id === 'monitors');
    expect(monitors!.enabled).toBe(true);
  });

  it('ignores unknown service ids without throwing', () => {
    const filePath = getDaemonServicesConfigPath();
    // `browser-ipc` is a now-removed id (PHNX-4101), so it is exactly an unknown
    // key: read must ignore it, never resurrect it.
    fs.writeFileSync(filePath, 'services:\n  monitors: false\n  browser-ipc: false\n  unknown-service: false\n', 'utf-8');
    const cfg = readDaemonServicesConfig();
    expect(cfg.services['monitors']).toBe(false);
    expect((cfg.services as Record<string, boolean>)['browser-ipc']).toBeUndefined();
    // Unknown key is ignored, not crashed on.
    expect(cfg.services['scheduler']).toBe(true);
  });

  it('writeDaemonServicesConfig preserves extra top-level fields', () => {
    const filePath = getDaemonServicesConfigPath();
    fs.writeFileSync(filePath, 'notes: "do not clobber"\nservices:\n  monitors: false\n', 'utf-8');
    setDaemonServiceEnabled('monitors', true);
    const raw = fs.readFileSync(filePath, 'utf-8');
    expect(raw).toContain('notes: do not clobber');
    expect(raw).toContain('monitors: true');
  });
});
