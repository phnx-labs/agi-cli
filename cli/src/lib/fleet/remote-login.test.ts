import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  scrapeLogin,
  classifyLoginFlow,
  isPendingVerdict,
  selectLoginTargets,
  buildRemoteLoginSshCommand,
  buildDashboardHtml,
  driveRemoteLogin,
  type TermDriver,
} from './remote-login.js';
import { FLEET_LOGIN_FLOWS, type LoginFlow } from './auth-sync.js';
import type { DeviceProfile } from '../devices/registry.js';
import type { AuthHealth } from '../auth-health.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => fs.readFileSync(path.join(here, 'testdata', name), 'utf-8');

const droid = FLEET_LOGIN_FLOWS.droid;
const codex = FLEET_LOGIN_FLOWS.codex;
const kimi = FLEET_LOGIN_FLOWS.kimi;

describe('scrapeLogin', () => {
  it('extracts the exact URL and code from a real droid device-code screen', () => {
    const got = scrapeLogin(fixture('droid-device-code.txt'), droid);
    expect(got.url).toBe('https://auth.factory.ai/device');
    expect(got.code).toBe('MJQW-NQRM');
  });

  it('captures the code with a tight boundary — no trailing words leak in', () => {
    // The word after the code ("to") must NOT become part of the captured value.
    const screen = 'please visit https://auth.factory.ai/device and enter code ABCD-1234 to complete authentication.';
    const got = scrapeLogin(screen, droid);
    expect(got.code).toBe('ABCD-1234');
    expect(got.code).not.toContain(' ');
    expect(got.url).toBe('https://auth.factory.ai/device');
  });

  it('leaves url undefined when the verification phrase is absent', () => {
    // Code present in isolation, but no "please visit <url> and enter code" phrase.
    const screen = 'enter code WXYZ-7890 in your browser';
    const got = scrapeLogin(screen, droid);
    expect(got.code).toBe('WXYZ-7890');
    expect(got.url).toBeUndefined();
  });

  it('returns nothing for the codex menu — the device-code screen is not reached until selected', () => {
    const got = scrapeLogin(fixture('codex-menu.txt'), codex);
    expect(got.url).toBeUndefined();
    expect(got.code).toBeUndefined();
  });

  it('returns nothing for the kimi platform-select prompt (pre-code)', () => {
    const got = scrapeLogin(fixture('kimi-login.txt'), kimi);
    expect(got.url).toBeUndefined();
    expect(got.code).toBeUndefined();
  });

  it('yields nothing when a flow defines no regexes (grok — pattern not yet captured)', () => {
    const grok = FLEET_LOGIN_FLOWS.grok;
    expect(grok.verificationUrlRegex).toBeUndefined();
    const got = scrapeLogin('grok login: visit https://x.ai/device code ABCD-0000', grok);
    expect(got.url).toBeUndefined();
    expect(got.code).toBeUndefined();
  });
});

describe('classifyLoginFlow', () => {
  it('marks a device-code agent remotable', () => {
    expect(classifyLoginFlow('droid', 'linux')).toMatchObject({ remotable: true });
    expect(classifyLoginFlow('codex', 'linux')).toMatchObject({ remotable: true });
  });

  it('flags loopback and unknown flows non-remotable with a reason', () => {
    const anti = classifyLoginFlow('antigravity', 'linux');
    expect(anti.remotable).toBe(false);
    expect(anti.reason).toMatch(/loopback/i);

    const open = classifyLoginFlow('opencode', 'linux');
    expect(open.remotable).toBe(false);
    expect(open.reason).toMatch(/not yet/i);
  });

  it('flags a macOS keychain-bound agent non-remotable even if its flow were device-code', () => {
    const c = classifyLoginFlow('claude', 'macos');
    expect(c.remotable).toBe(false);
    expect(c.reason).toMatch(/keychain/i);
  });

  it('returns no flow for an agent without a defined login flow', () => {
    expect(classifyLoginFlow('cursor', 'linux')).toMatchObject({ flow: null, remotable: false });
  });
});

describe('isPendingVerdict', () => {
  it('treats missing and revoked as pending; live/unverified/expired as logged-in', () => {
    expect(isPendingVerdict(undefined)).toBe(true);
    expect(isPendingVerdict('revoked')).toBe(true);
    expect(isPendingVerdict('live')).toBe(false);
    expect(isPendingVerdict('unverified')).toBe(false);
    expect(isPendingVerdict('expired')).toBe(false);
    expect(isPendingVerdict('rate_limited')).toBe(false);
  });
});

function device(name: string, platform: string): DeviceProfile {
  // A real registry profile always carries auth (upsertDevice defaults
  // { method: 'key' }); the resolver reads it, so the fixture must too.
  return { name, platform, auth: { method: 'key' } } as unknown as DeviceProfile;
}

function health(verdict: AuthHealth['verdict']): AuthHealth {
  return { verdict, checkedAt: Date.now() };
}

describe('selectLoginTargets', () => {
  it('selects only pending pairs and partitions remotable vs non-remotable', () => {
    const devices = [device('box-a', 'linux'), device('box-b', 'linux')];
    const cache: Record<string, AuthHealth> = {
      // box-a droid is already live -> skipped
      'box-a:droid:1.0.0': health('live'),
      // box-b droid revoked -> pending
      'box-b:droid:1.0.0': health('revoked'),
      // box-a codex missing entirely -> pending
    };
    const pending = selectLoginTargets(devices, ['droid', 'codex', 'antigravity'], cache);

    const keys = pending.map((p) => `${p.agent}@${p.device}:${p.remotable}`).sort();
    // box-a droid live -> excluded. box-b droid revoked -> pending remotable.
    // codex missing on both -> pending remotable. antigravity loopback -> pending but not remotable.
    expect(keys).toContain('droid@box-b:true');
    expect(keys).toContain('codex@box-a:true');
    expect(keys).toContain('codex@box-b:true');
    expect(keys).toContain('antigravity@box-a:false');
    expect(keys).not.toContain('droid@box-a:true');
    expect(keys).not.toContain('droid@box-a:false');
  });

  it('includeLoggedIn overrides the pending filter (cold-cache / forced re-login)', () => {
    const devices = [device('box-a', 'linux')];
    const cache: Record<string, AuthHealth> = { 'box-a:droid:1.0.0': health('live') };
    const pending = selectLoginTargets(devices, ['droid'], cache, { includeLoggedIn: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ agent: 'droid', device: 'box-a', remotable: true });
  });

  it('falls back to the bare device name as the ssh target when no address is set', () => {
    const pending = selectLoginTargets([device('box-a', 'linux')], ['droid'], {});
    expect(pending[0].target).toBe('box-a');
  });
});

describe('buildRemoteLoginSshCommand', () => {
  it('builds an ssh -tt invocation that puts the shim dir on the remote PATH so the login command resolves in a non-login shell', () => {
    const cmd = buildRemoteLoginSshCommand('user@box', codex);
    expect(cmd).toContain('ssh -tt');
    expect(cmd).toContain('StrictHostKeyChecking=accept-new');
    expect(cmd).toContain('user@box');
    // The agent CLI is a shim not on the non-login PATH; the remote command must
    // prepend the shim dir (expanded on the box via $HOME) and still run the
    // login command. The whole remote command is single-quoted for the local shell.
    expect(cmd).toContain('.agents/.cache/shims');
    expect(cmd).toContain('$HOME');
    expect(cmd).toContain('codex login');
    expect(cmd).toContain('PATH="$HOME/.agents/.cache/shims:$PATH" codex login');
  });

  it('pins an explicit device identity', () => {
    const cmd = buildRemoteLoginSshCommand('user@box', codex, [
      '-i', '/keys/box', '-o', 'IdentitiesOnly=yes',
    ]);
    expect(cmd).toContain('-i /keys/box');
    expect(cmd).toContain('-o IdentitiesOnly=yes');
  });

  it('rejects an injection-shaped target', () => {
    expect(() => buildRemoteLoginSshCommand('box; rm -rf /', droid)).toThrow();
  });
});

describe('buildDashboardHtml', () => {
  const pending = [
    { device: 'box-a', agent: 'droid', platform: 'linux', target: 'box-a', flow: droid, remotable: true },
    { device: 'box-b', agent: 'antigravity', platform: 'linux', target: 'box-b', flow: FLEET_LOGIN_FLOWS.antigravity, remotable: false, reason: 'loopback' },
  ];

  it('renders a self-contained page naming every pending pair and the mode', () => {
    const html = buildDashboardHtml(pending, 'bulk');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('box-a');
    expect(html).toContain('droid');
    expect(html).toContain('mode: bulk');
    // seeded JSON drives the client — the non-remotable pair seeds as skipped
    expect(html).toContain('"remotable":false');
  });

  it('renders the interactive wizard variant', () => {
    expect(buildDashboardHtml(pending, 'interactive')).toContain('mode: interactive');
  });

  it('does not throw on an empty pending list', () => {
    expect(() => buildDashboardHtml([], 'bulk')).not.toThrow();
  });
});

// A scripted fake PTY driver: `screen` returns each queued frame in order,
// repeating the last. Records every write so we can assert steering keystrokes.
function fakeDriver(frames: { screen: string; exited?: boolean }[]): TermDriver & { writes: string[]; execs: string[] } {
  let i = 0;
  const writes: string[] = [];
  const execs: string[] = [];
  return {
    writes,
    execs,
    async start() { return 'sess1'; },
    async exec(_id, command) { execs.push(command); },
    async write(_id, input) { writes.push(input); },
    async screen() {
      const frame = frames[Math.min(i, frames.length - 1)];
      i++;
      return { screen: frame.screen, exited: Boolean(frame.exited) };
    },
    async stop() { /* noop */ },
  };
}

describe('driveRemoteLogin', () => {
  const fast = { initialDelayMs: 0, pollMs: 1, timeoutMs: 500 };

  it('sends the device-code steering keystrokes and returns the scraped url+code', async () => {
    // codex: first frame is the menu (nothing), after steering the device screen appears.
    const codeScreen = 'please visit https://auth.factory.ai/device and enter code MJQW-NQRM to complete authentication.';
    const driver = fakeDriver([
      { screen: 'menu: choose an option' },
      { screen: codeScreen },
    ]);
    // Use droid's regexes to parse (codex post-selection pattern is not captured);
    // the flow under test is codex (for its deviceCodeSelect keystrokes).
    const flow: LoginFlow = { ...codex, verificationUrlRegex: droid.verificationUrlRegex, userCodeRegex: droid.userCodeRegex };
    const r = await driveRemoteLogin('box-a', flow, driver, fast);

    expect(driver.execs[0]).toContain('ssh -tt');
    expect(driver.writes).toContain(codex.deviceCodeSelect);
    expect(r.url).toBe('https://auth.factory.ai/device');
    expect(r.code).toBe('MJQW-NQRM');
  });

  it('returns partial (no code) when the session exits before a code prints', async () => {
    const driver = fakeDriver([{ screen: 'connection refused', exited: true }]);
    const r = await driveRemoteLogin('box-a', droid, driver, fast);
    expect(r.exited).toBe(true);
    expect(r.code).toBeUndefined();
  });

  it('stops the session (no PTY/ssh leak) when a call throws after start()', async () => {
    // The sidecar drops mid-poll: screen() rejects after start()/exec() succeeded.
    // driveRemoteLogin must tear the session down before rethrowing, else the
    // caller never gets a sessionId and the ssh -tt process leaks until the reaper.
    const stops: string[] = [];
    const driver: TermDriver = {
      async start() { return 'sess1'; },
      async exec() { /* ok */ },
      async write() { /* ok */ },
      async screen() { throw new Error('sidecar connection dropped'); },
      async stop(id) { stops.push(id); },
    };
    await expect(driveRemoteLogin('box-a', droid, driver, fast)).rejects.toThrow('sidecar connection dropped');
    expect(stops).toEqual(['sess1']);
  });
});
