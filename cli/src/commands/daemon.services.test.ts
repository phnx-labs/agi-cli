import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  DAEMON_TESTS_SUPPORTED,
  makeHome,
  run,
} from './daemon-test-harness.js';
import { DAEMON_SERVICE_IDS } from '../lib/daemon-services.js';

const describeDaemon = DAEMON_TESTS_SUPPORTED ? describe : describe.skip;

describeDaemon('agents daemon — services, broker, webhooks', () => {
  it('services --json reports a reachability-only secrets-broker probe', () => {
    const res = run(makeHome(), ['services', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.secretsBroker.reachable).toBe(false);
    expect(payload.secretsBroker.socketPath).toBeNull();
    expect(payload.browserIpc).toBeUndefined();
  });
  it('services --json additionally reports every registered service with health, live or inferred', () => {
    const res = run(makeHome(), ['services', '--json']);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      secretsBroker: unknown;
      services: Array<{ id: string; enabled: boolean; state: string; supervised: boolean; consecutiveFailures: number }>;
    };
    expect(payload.secretsBroker).toBeDefined();
    expect(Array.isArray(payload.services)).toBe(true);
    expect(payload.services.length).toBe(DAEMON_SERVICE_IDS.length);
    const sessionIndex = payload.services.find((s) => s.id === 'session-index');
    expect(sessionIndex).toBeDefined();
    expect(sessionIndex!.enabled).toBe(true);
    expect(sessionIndex!.state).toBe('stopped');
    expect(sessionIndex!.supervised).toBe(false);
    expect(sessionIndex!.consecutiveFailures).toBe(0);
  });
  it('services (no --json) renders a state column for every registered service', () => {
    const res = run(makeHome(), ['services']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Daemon services');
    expect(res.stdout).toContain('session-index');
    expect(res.stdout).toContain('monitors');
    expect(res.stdout).toContain('Hosted sockets');
  });
  it('services restart rejects an unknown service id and a not-running daemon', () => {
    const home = makeHome();
    const unknown = run(home, ['services', 'restart', 'not-a-service']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr + unknown.stdout).toContain("Unknown service 'not-a-service'");

    const notRunning = run(home, ['services', 'restart', 'session-index']);
    expect(notRunning.status).toBe(1);
    expect(notRunning.stdout).toContain('Daemon is not running');
  });

  it('services list shows every service enabled by default', () => {
    const res = run(makeHome(), ['services', 'list']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('monitors');
    expect(res.stdout).toContain('scheduler');
    expect(res.stdout).toContain('enabled');
  });

  it('webhooks add/list/remove drive the real daemon/webhooks.yaml (RUSH-2548)', () => {
    const home = makeHome();
    const configPath = path.join(home, '.agents', 'daemon', 'webhooks.yaml');

    const empty = run(home, ['webhooks', 'list', '--json']);
    expect(empty.status).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual([]);

    const add = run(home, ['webhooks', 'add', '--secrets-bundle', 'linear-webhook', '--port', '8788', '--funnel-port', '443']);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('127.0.0.1:8788');
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('linear-webhook');

    const listed = JSON.parse(run(home, ['webhooks', 'list', '--json']).stdout);
    expect(listed).toEqual([{ bundle: 'linear-webhook', port: 8788, rateLimit: 60, funnelPort: 443 }]);

    const removed = run(home, ['webhooks', 'remove', '8788']);
    expect(removed.status).toBe(0);
    expect(JSON.parse(run(home, ['webhooks', 'list', '--json']).stdout)).toEqual([]);
  }, 90_000);
  it('webhooks rejects a funnel port Tailscale cannot serve, and an unknown remove', () => {
    const home = makeHome();
    const bad = run(home, ['webhooks', 'add', '--secrets-bundle', 'b', '--funnel-port', '9999']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('443, 8443, 10000');

    const missing = run(home, ['webhooks', 'remove', '8787']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No receiver declared on port 8787');
  });
  it('services disable writes the config and services list reflects it', () => {
    const home = makeHome();
    const disable = run(home, ['services', 'disable', 'monitors']);
    expect(disable.status).toBe(0);
    expect(disable.stdout).toContain("Disabled 'monitors'");

    const list = run(home, ['services', 'list', '--json']);
    expect(list.status).toBe(0);
    const services = JSON.parse(list.stdout) as Array<{ id: string; enabled: boolean }>;
    const monitorsSvc = services.find((s) => s.id === 'monitors');
    expect(monitorsSvc).toBeDefined();
    expect(monitorsSvc!.enabled).toBe(false);

    const cfgPath = path.join(home, '.agents', 'daemon', 'services.yaml');
    expect(fs.readFileSync(cfgPath, 'utf-8')).toContain('monitors: false');
  });
  it('services enable re-enables a disabled service', () => {
    const home = makeHome();
    run(home, ['services', 'disable', 'monitors']);
    const enable = run(home, ['services', 'enable', 'monitors']);
    expect(enable.status).toBe(0);
    expect(enable.stdout).toContain("Enabled 'monitors'");

    const list = run(home, ['services', 'list', '--json']);
    const services = JSON.parse(list.stdout) as Array<{ id: string; enabled: boolean }>;
    expect(services.find((s) => s.id === 'monitors')!.enabled).toBe(true);
  });
  it('services enable|disable reject unknown service ids', () => {
    const home = makeHome();
    const enable = run(home, ['services', 'enable', 'not-a-service']);
    expect(enable.status).toBe(1);
    expect(enable.stderr + enable.stdout).toContain("Unknown service 'not-a-service'");

    const disable = run(home, ['services', 'disable', 'not-a-service']);
    expect(disable.status).toBe(1);
    expect(disable.stderr + disable.stdout).toContain("Unknown service 'not-a-service'");
  });
});
