/**
 * Socket-service migration (RUSH-3193 P2): each of the three socket services
 * (BrowserIPCService, MonitorEngineService, AccountStateDaemonService) is
 * supervised by ServiceSupervisor. MonitorEngineService is periodic; the other
 * wrappers own lifecycle resources and account-state owns its existing
 * refresh lifecycle. A fourth, SecretsBrokerService, used to live here too;
 * it moved out of this daemon entirely with the standalone `secrets` engine
 * (PHNX-3989 OWN-1) — this daemon no longer hosts or supervises that broker.
 *
 * Tests here exercise:
 * 1. `BaseDaemonService` — the convenience base for lifecycle-only services.
 * 2. `ServiceSupervisor` extended to accept plain `DaemonService` (non-periodic).
 *    - A lifecycle service that fails start() is parked and reported unhealthy.
 *    - A lifecycle service that starts successfully is `running` with lastRunMs set.
 *    - Periodic and lifecycle services coexist on the same supervisor.
 *    - `stopAll()` calls stop() on lifecycle services.
 * 3. The three REAL socket-service classes (BrowserIPCService,
 *    MonitorEngineService, AccountStateDaemonService), imported and driven
 *    through a real `ServiceSupervisor` — start/stop/health run their actual
 *    onStart()/onStop() bodies, not a stand-in. Only the subsystem pieces that
 *    would otherwise touch the real machine (a real daemon's helpers dir for
 *    the browser socket, and the network/fleet calls behind account-state's
 *    refresh ticks) are redirected/stubbed; the wrapper classes themselves are
 *    never mocked. Deleting a real onStart()/onStop() body now fails this
 *    suite (verified manually while writing it).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ServiceSupervisor } from './supervisor.js';
import { BaseDaemonService, BasePeriodicService, isPeriodicService, type DaemonContext } from './service.js';
import type { DaemonServiceId } from '../daemon-services.js';

// ---------------------------------------------------------------------------
// Real-service test infrastructure — redirect the browser IPC socket dir out
// of the real machine's `~/.agents/.cache/helpers`, and stub the daemon-ticks
// account-state relies on so a real `startAccountStateService()` call never
// hits the network/fleet. Both are declared at module scope (vi.mock factories
// are hoisted above any `beforeEach`-scoped const) and the directory itself is
// created/cleaned per test.
// ---------------------------------------------------------------------------

// Unix-domain sockets have a short platform path limit (104 bytes on macOS).
// macOS's per-user os.tmpdir() (/var/folders/…/T) is itself long enough that
// appending `browser/browser.sock` overflows that limit, which parks the real
// BrowserIPCServer's onStart() — so bind under a short root, the same POSIX-`/tmp`
// convention the sibling socket tests use (ipc.test.ts, daemon.registry.test.ts,
// daemon.supervisor-wiring.test.ts). Windows uses a named pipe, no path limit.
const BROWSER_HELPER_DIR = path.join(
  process.platform === 'win32' ? os.tmpdir() : '/tmp',
  `a-sv-${process.pid}`,
);

vi.mock('../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state.js')>()),
  getHelpersDir: vi.fn(() => BROWSER_HELPER_DIR),
  getBrowserRuntimeDir: vi.fn(() => path.join(BROWSER_HELPER_DIR, 'runtime')),
}));

vi.mock('../daemon-ticks.js', () => ({
  runUsageRefreshTick: vi.fn(async () => {}),
  runFleetCacheWarmTick: vi.fn(async () => {}),
  refreshLocalFleetAuthState: vi.fn(async () => ({ row: { host: 'test' }, authRows: [] })),
}));

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let testDaemonDir = '';
const originalDaemonDir = process.env.AGENTS_DAEMON_DIR;

beforeEach(() => {
  testDaemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-socketsvcs-'));
  process.env.AGENTS_DAEMON_DIR = testDaemonDir;
  fs.rmSync(BROWSER_HELPER_DIR, { recursive: true, force: true });
  fs.mkdirSync(BROWSER_HELPER_DIR, { recursive: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDaemonDir === undefined) delete process.env.AGENTS_DAEMON_DIR;
  else process.env.AGENTS_DAEMON_DIR = originalDaemonDir;
  fs.rmSync(testDaemonDir, { recursive: true, force: true });
  fs.rmSync(BROWSER_HELPER_DIR, { recursive: true, force: true });
});

function makeCtx(): DaemonContext {
  return { log: () => {} };
}

// ---------------------------------------------------------------------------
// BaseDaemonService unit tests
// ---------------------------------------------------------------------------

class RecordingLifecycleService extends BaseDaemonService {
  readonly id: DaemonServiceId;
  startCalls = 0;
  stopCalls = 0;
  shouldFailStart = false;

  constructor(id: DaemonServiceId) {
    super();
    this.id = id;
  }

  protected async onStart(_ctx: DaemonContext): Promise<void> {
    this.startCalls += 1;
    if (this.shouldFailStart) throw new Error(`start failure for ${this.id}`);
  }

  protected async onStop(): Promise<void> {
    this.stopCalls += 1;
  }
}

describe('BaseDaemonService', () => {
  it('starts idle, transitions to running on start() and stamps lastRunMs', async () => {
    const svc = new RecordingLifecycleService('catchup');
    expect(svc.health().state).toBe('idle');

    await svc.start(makeCtx());
    expect(svc.startCalls).toBe(1);
    const h = svc.health();
    expect(h.state).toBe('running');
    expect(h.lastRunMs).toBeGreaterThan(0);
  });

  it('stop() transitions to stopped and calls onStop()', async () => {
    const svc = new RecordingLifecycleService('browser-ipc');
    await svc.start(makeCtx());
    await svc.stop();
    expect(svc.stopCalls).toBe(1);
    expect(svc.health().state).toBe('stopped');
  });

  it('restart() is stop() then start() against the cached context', async () => {
    const svc = new RecordingLifecycleService('monitors');
    await svc.start(makeCtx());
    await svc.restart();
    expect(svc.stopCalls).toBe(1);
    expect(svc.startCalls).toBe(2);
    expect(svc.health().state).toBe('running');
  });

  it('restart() before start() throws — no cached context', async () => {
    const svc = new RecordingLifecycleService('account-state');
    await expect(svc.restart()).rejects.toThrow(/cannot restart before it has started once/);
  });

  it('health() returns a snapshot copy, not a live reference', async () => {
    const svc = new RecordingLifecycleService('catchup');
    await svc.start(makeCtx());
    const snapshot = svc.health();
    await svc.stop();
    expect(snapshot.state).toBe('running');
    expect(svc.health().state).toBe('stopped');
  });

  it('isPeriodicService() returns false for a BaseDaemonService', async () => {
    const svc = new RecordingLifecycleService('browser-ipc');
    expect(isPeriodicService(svc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ServiceSupervisor with lifecycle-only (non-periodic) services
// ---------------------------------------------------------------------------

describe('ServiceSupervisor — lifecycle-only DaemonService', () => {
  it('a lifecycle service that starts successfully is running with lastRunMs set', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new RecordingLifecycleService('catchup');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());

    const health = supervisor.health();
    expect(health['catchup'].state).toBe('running');
    expect(health['catchup'].lastRunMs).toBeGreaterThan(0);
    expect(health['catchup'].consecutiveFailures).toBe(0);
    expect(svc.startCalls).toBe(1);

    await supervisor.stopAll();
  });

  it('a lifecycle service that fails start() is parked + reported unhealthy without crashing the daemon', async () => {
    const supervisor = new ServiceSupervisor();
    const failing = new RecordingLifecycleService('browser-ipc');
    failing.shouldFailStart = true;
    const healthy = new RecordingLifecycleService('monitors');
    supervisor.register(failing);
    supervisor.register(healthy);
    await supervisor.startAll(makeCtx());

    const health = supervisor.health();
    expect(health['browser-ipc'].state).toBe('parked');
    expect(health['browser-ipc'].lastError).toMatch(/start failure/);
    expect(health['browser-ipc'].consecutiveFailures).toBeGreaterThanOrEqual(1);

    // The sibling kept starting and is healthy.
    expect(health['monitors'].state).toBe('running');
    expect(healthy.startCalls).toBe(1);

    await supervisor.stopAll();
  });

  it('stopAll() calls stop() on a successfully started lifecycle service', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new RecordingLifecycleService('account-state');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());
    await supervisor.stopAll();
    expect(svc.stopCalls).toBe(1);
    expect(supervisor.health()['account-state'].state).toBe('stopped');
  });

  it('stopAll() does NOT call stop() on a service that never successfully started', async () => {
    const supervisor = new ServiceSupervisor();
    const failing = new RecordingLifecycleService('catchup');
    failing.shouldFailStart = true;
    supervisor.register(failing);
    await supervisor.startAll(makeCtx());
    await supervisor.stopAll();
    // stop() must not be called on a parked-on-start service (nothing to tear down).
    expect(failing.stopCalls).toBe(0);
  });

  it('periodic and lifecycle services coexist on the same supervisor — both start running', async () => {
    class TinyPeriodicService extends BasePeriodicService {
      readonly id: DaemonServiceId = 'session-index';
      readonly intervalMs = 500;
      readonly deadlineMs = 200;
      ticks = 0;
      protected async onStart(): Promise<void> {}
      protected async onStop(): Promise<void> {}
      protected async onTick(): Promise<void> { this.ticks += 1; }
    }

    const supervisor = new ServiceSupervisor();
    const periodic = new TinyPeriodicService();
    const lifecycle = new RecordingLifecycleService('catchup');
    supervisor.register(periodic);
    supervisor.register(lifecycle);
    await supervisor.startAll(makeCtx());
    // Give the immediate periodic tick (void this.runTick(id)) a chance to settle.
    await Promise.resolve();

    const health = supervisor.health();
    expect(health['session-index'].state).toBe('running');
    expect(health['catchup'].state).toBe('running');
    // No timer ticks for the lifecycle service — it stays at the start lastRunMs.
    expect(lifecycle.startCalls).toBe(1);
    expect(isPeriodicService(periodic)).toBe(true);
    expect(isPeriodicService(lifecycle)).toBe(false);

    await supervisor.stopAll();
  });

  it('a parked lifecycle service is retried via restartOne() and becomes running', async () => {
    // Use restartOne() to exercise the restart path directly (avoids needing
    // fake-timer advancement which is not reliable across all bun versions).
    const supervisor = new ServiceSupervisor({ parkAfterFailures: 1 });
    const svc = new RecordingLifecycleService('browser-ipc');
    svc.shouldFailStart = true;
    supervisor.register(svc);
    await supervisor.startAll(makeCtx()); // start() throws → parked immediately
    expect(supervisor.health()['browser-ipc'].state).toBe('parked');

    // Fix the service and force a restart now.
    svc.shouldFailStart = false;
    await supervisor.restartOne('browser-ipc');
    expect(supervisor.health()['browser-ipc'].state).toBe('running');
    expect(supervisor.health()['browser-ipc'].lastRunMs).toBeGreaterThan(0);

    await supervisor.stopAll();
  });

  it('health() records are written to daemon-health.ts on lifecycle service successful start', async () => {
    const supervisor = new ServiceSupervisor();
    const svc = new RecordingLifecycleService('catchup');
    supervisor.register(svc);
    await supervisor.startAll(makeCtx());

    // daemon-health.ts writes a JSON file to AGENTS_DAEMON_DIR/health.json.
    const healthPath = path.join(testDaemonDir, 'health.json');
    expect(fs.existsSync(healthPath)).toBe(true);
    const all = JSON.parse(fs.readFileSync(healthPath, 'utf-8'));
    // SubsystemHealth has lastOkAt (not a `status` field).
    expect(all['catchup']).toBeDefined();
    expect(all['catchup'].consecutiveFailures).toBe(0);
    expect(all['catchup'].lastOkAt).not.toBeNull();

    await supervisor.stopAll();
  });
});

// ---------------------------------------------------------------------------
// The four REAL socket services, through a real ServiceSupervisor
// ---------------------------------------------------------------------------

describe('ServiceSupervisor — real socket services (BrowserIPCService, MonitorEngineService, AccountUsageService, AccountAuthService)', () => {
  it('starts, reports healthy, and cleanly stops all real services together', async () => {
    const { BrowserIPCService } = await import('./browser-ipc-service.js');
    const { MonitorEngineService } = await import('./monitor-engine-service.js');
    const { AccountUsageService, AccountAuthService } = await import('./account-state-daemon-service.js');
    const { BrowserService } = await import('../browser/service.js');
    const { getSocketPath } = await import('../browser/ipc.js');
    const { runUsageRefreshTick, refreshLocalFleetAuthState } = await import('../daemon-ticks.js');

    const supervisor = new ServiceSupervisor();
    const monitors = new MonitorEngineService();
    const accountUsage = new AccountUsageService();
    const accountAuth = new AccountAuthService();
    const browserIpc = new BrowserIPCService(new BrowserService());
    supervisor.register(monitors);
    supervisor.register(accountUsage);
    supervisor.register(accountAuth);
    supervisor.register(browserIpc);

    await supervisor.startAll(makeCtx());

    const health = supervisor.health();
    expect(health['monitors'].state).toBe('running');
    expect(health['account-state'].state).toBe('running');
    expect(health['account-auth'].state).toBe('running');
    expect(health['browser-ipc'].state, JSON.stringify(health['browser-ipc'])).toBe('running');

    // Real-EFFECT assertions, one per service. `state === 'running'` alone only
    // proves onStart() didn't throw (BaseDaemonService sets it unconditionally),
    // so each service needs an observable that its REAL onStart() body produced —
    // otherwise emptying that body leaves the suite green, the exact #3046 gap.
    // browser-ipc: the real BrowserIPCServer bound a unix socket on disk.
    expect(fs.existsSync(getSocketPath())).toBe(true);
    // monitors: the real onStart() constructed a live MonitorEngine.
    expect(monitors.getEngine()).not.toBeNull();
    // account-state / account-auth: each service's supervised first tick ran its
    // real onTick body — usage on AccountUsageService, auth on AccountAuthService
    // (both stubbed here) — proving the two split services are wired (PHNX-3608).
    // Auth now calls refreshLocalFleetAuthState so the tick can publish
    // per-account verdicts and detect live→expired/revoked transitions.
    expect(vi.mocked(runUsageRefreshTick)).toHaveBeenCalled();
    expect(vi.mocked(refreshLocalFleetAuthState)).toHaveBeenCalled();

    await supervisor.stopAll();

    const stopped = supervisor.health();
    expect(stopped['monitors'].state).toBe('stopped');
    expect(stopped['account-state'].state).toBe('stopped');
    expect(stopped['account-auth'].state).toBe('stopped');
    expect(stopped['browser-ipc'].state).toBe('stopped');
    // Real stop() effects: browser socket unlinked, engine released. Emptying
    // each onStop() skips these.
    expect(fs.existsSync(getSocketPath())).toBe(false);
    expect(monitors.getEngine()).toBeNull();
  });

  it('a real service whose onStart() throws is parked and reported unhealthy, without taking down a healthy sibling', async () => {
    const { BrowserIPCService } = await import('./browser-ipc-service.js');
    const { MonitorEngineService } = await import('./monitor-engine-service.js');
    const { BrowserService } = await import('../browser/service.js');
    const { getSocketPath } = await import('../browser/ipc.js');

    // Force BrowserIPCService.onStart() to throw for real: put a plain FILE
    // where its socket directory (getHelpersDir()/browser) must be created, so
    // the real `fs.mkdirSync(socketDir, { recursive: true })` in ipc.ts hits
    // ENOTDIR instead of the stub-only failure a fake service would need.
    const blockerPath = path.dirname(getSocketPath());
    fs.writeFileSync(blockerPath, 'not a directory');

    const supervisor = new ServiceSupervisor();
    const failingBrowserIpc = new BrowserIPCService(new BrowserService());
    const healthyMonitors = new MonitorEngineService();
    supervisor.register(failingBrowserIpc);
    supervisor.register(healthyMonitors);

    await supervisor.startAll(makeCtx());

    const health = supervisor.health();
    expect(health['browser-ipc'].state).toBe('parked');
    expect(health['browser-ipc'].lastError).toBeTruthy();
    expect(health['browser-ipc'].consecutiveFailures).toBeGreaterThanOrEqual(1);

    // The sibling real service kept starting and is healthy.
    expect(health['monitors'].state).toBe('running');

    await supervisor.stopAll();
  });
});
