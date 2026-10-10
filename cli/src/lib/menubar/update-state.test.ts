import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import lockfile from 'proper-lockfile';
import { createServer } from 'node:http';
import { setConfigValue, unsetConfigValue } from '../device-config.js';
import { getMenubarUpdateStatus, prefetchMenubarHelper, updateMenubarHelperIfNewer, serviceLabel } from './install-menubar.js';
import { menubarAutoUpdateEnabled, menubarAutomaticUpdateDue, MENUBAR_AUTO_UPDATE_INTERVAL_MS, readUpdateState, saveUpdateState, updateStatePath } from './update-state.js';
import { resolveMenubarVersion } from './resolve-version.js';

const stateFile = updateStatePath();
afterEach(() => { fs.rmSync(stateFile, { force: true }); unsetConfigValue('menubar.autoUpdate'); });

describe('AGI Menu automatic updates', () => {
  it('defaults on, persists the synced off preference, and suppresses prefetch', async () => {
    expect(menubarAutoUpdateEnabled()).toBe(true);
    setConfigValue('menubar.autoUpdate', false);
    expect(menubarAutoUpdateEnabled()).toBe(false);
    expect(getMenubarUpdateStatus()).toMatchObject({ autoUpdate: false, nextCheckAt: null });
    expect(await prefetchMenubarHelper()).toBeNull();
    expect(() => setConfigValue('menubar.autoUpdate', 'off')).toThrow(/boolean/);
  });
  it('makes the first check due and persists a twelve-hour boundary across a new process', () => {
    const now = Date.now();
    expect(menubarAutomaticUpdateDue(null, now)).toBe(true);
    const checkedAt = new Date(now).toISOString();
    saveUpdateState({ ...getMenubarUpdateStatus(), checkedAt, outcome: 'failed', detail: 'offline' });
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1],"utf8"))', stateFile], { encoding: 'utf8' });
    expect(child.status).toBe(0);
    const saved = JSON.parse(child.stdout);
    expect(menubarAutomaticUpdateDue(saved.checkedAt, now + MENUBAR_AUTO_UPDATE_INTERVAL_MS - 1)).toBe(false);
    expect(menubarAutomaticUpdateDue(saved.checkedAt, now + MENUBAR_AUTO_UPDATE_INTERVAL_MS)).toBe(true);
    expect(readUpdateState().outcome).toBe('failed');
  });
  it('discards malformed persisted timestamps rather than breaking snapshots or stopping checks forever', () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ outcome: 'current', checkedAt: 'bad', detail: 'old' }));
    expect(getMenubarUpdateStatus()).toMatchObject({ outcome: 'unknown', checkedAt: null, nextCheckAt: null });
  });
  it.skipIf(process.platform !== 'darwin')('manual check works off and respects an existing coordinator lock; install refuses sandbox service access', async () => {
    const support = path.join(os.homedir(), 'Library', 'Application Support', 'agents-cli');
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceLabel()}.plist`);
    fs.mkdirSync(support, { recursive: true }); fs.mkdirSync(path.dirname(plist), { recursive: true });
    const stamp = path.join(support, '.menubar-version');
    fs.writeFileSync(stamp, JSON.stringify({ source: 'release', helperVersion: '1.0.0' }));
    fs.writeFileSync(plist, '<plist/>');
    setConfigValue('menubar.autoUpdate', false);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const release = await lockfile.lock(stateFile, { realpath: false });
    try {
      expect((await updateMenubarHelperIfNewer({ manual: true, dryRun: true })).detail).toBe('An update check is already running');
      const denied = await updateMenubarHelperIfNewer({ manual: true });
      expect(denied.outcome).toBe('skipped');
      expect(denied.detail).toContain('refusing service-manager registration');
      expect(JSON.parse(fs.readFileSync(stamp, 'utf8')).helperVersion).toBe('1.0.0');
    } finally { await release(); fs.rmSync(stamp); fs.rmSync(plist); }
  });
  it('reports a real HTTP failure rather than a cached current version', async () => {
    const server = createServer((_request, response) => { response.writeHead(503); response.end('unavailable'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const cacheFile = path.join(path.dirname(stateFile), 'test-latest.json');
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: 0, version: '99.0.0' }));
    try {
      await expect(resolveMenubarVersion({ force: true, strict: true, cacheFile,
        fetchImpl: (_url, options) => fetch(`http://127.0.0.1:${address.port}`, options),
      })).rejects.toThrow('HTTP 503');
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(cacheFile); }
  });
});
