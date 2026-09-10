import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  deserializeBidi,
  FirefoxCapabilityError,
  firefoxAttachRequiredError,
  connectFirefox,
  bidiCreateTab,
  bidiNavigate,
  bidiEvaluate,
  bidiScreenshot,
  bidiTopLevelContexts,
  bidiCloseTab,
  bidiClickAt,
  type FirefoxConnection,
} from './firefox.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

describe('deserializeBidi', () => {
  it('unwraps primitives, arrays, and plain objects into a JS value', () => {
    expect(deserializeBidi({ type: 'string', value: 'hi' })).toBe('hi');
    expect(deserializeBidi({ type: 'number', value: 42 })).toBe(42);
    expect(deserializeBidi({ type: 'boolean', value: true })).toBe(true);
    expect(deserializeBidi({ type: 'null' })).toBeNull();
    expect(deserializeBidi({ type: 'undefined' })).toBeUndefined();
    expect(
      deserializeBidi({ type: 'array', value: [{ type: 'number', value: 1 }, { type: 'string', value: 'x' }, { type: 'null' }] }),
    ).toEqual([1, 'x', null]);
    expect(
      deserializeBidi({
        type: 'object',
        value: [
          ['t', { type: 'string', value: 'Title' }],
          ['n', { type: 'number', value: 2 }],
          ['nested', { type: 'object', value: [['a', { type: 'boolean', value: true }]] }],
        ],
      }),
    ).toEqual({ t: 'Title', n: 2, nested: { a: true } });
  });

  it('maps the string-encoded specials number BiDi uses', () => {
    expect(deserializeBidi({ type: 'number', value: 'Infinity' })).toBe(Infinity);
    expect(deserializeBidi({ type: 'number', value: '-Infinity' })).toBe(-Infinity);
    expect(Number.isNaN(deserializeBidi({ type: 'number', value: 'NaN' }) as number)).toBe(true);
  });

  it('yields undefined for a node/window RemoteValue that has no JS value', () => {
    expect(deserializeBidi({ type: 'node' })).toBeUndefined();
    expect(deserializeBidi({ type: 'window' })).toBeUndefined();
  });
});

describe('FirefoxCapabilityError', () => {
  it('names the missing capability and steers to a Chromium-family profile', () => {
    const err = new FirefoxCapabilityError('pdf');
    expect(err.capability).toBe('pdf');
    expect(err.message).toContain('pdf');
    expect(err.message.toLowerCase()).toContain('chromium');
  });
});

describe('firefoxAttachRequiredError', () => {
  it('names the exact relaunch command with port and profile directory', () => {
    const err = firefoxAttachRequiredError(
      { name: 'firefox-default', firefox: { profileName: 'default' } },
      9652,
      '/home/u/.mozilla/firefox/abc.default',
    );
    expect(err.message).toContain('firefox-default');
    expect(err.message).toContain('9652');
    expect(err.message).toContain('--remote-debugging-port 9652');
    expect(err.message).toContain('/home/u/.mozilla/firefox/abc.default');
    expect(err.message).toContain('single-instance');
  });
});

// ─── Live BiDi transport against a REAL Firefox (no mocking) ────────────────────
//
// Launches a real headless Firefox bound to a throwaway profile dir, connects the
// repo's real BiDi client, and exercises the driver primitives end to end.
//
// Gated on AGENTS_TEST_FIREFOX=<firefox binary> (e.g. /usr/bin/firefox). Unset →
// the suite skips cleanly, so CI without Firefox needs nothing.
const FIREFOX = process.env.AGENTS_TEST_FIREFOX;
const haveFirefox = !!(FIREFOX && fs.existsSync(FIREFOX));
const live = haveFirefox ? describe : describe.skip;

// vitest pins a sandbox $HOME per fork (tests/setup.ts). A snap-confined Firefox
// (/usr/bin/firefox on Ubuntu) cannot start under a foreign HOME and can only
// read a profile under ~/snap/firefox/common. os.userInfo() reads the passwd db,
// not $HOME, so it recovers the REAL home even inside the sandbox. When a snap
// tree is present we launch under it; otherwise a plain temp dir (deb/tarball
// Firefox, macOS Firefox.app, CI) works as-is.
const realHome = os.userInfo().homedir;
const snapMozilla = path.join(realHome, 'snap', 'firefox', 'common', '.mozilla');
const useSnap = fs.existsSync(path.join(realHome, 'snap', 'firefox'));
function makeProfileDir(prefix: string): string {
  const base = useSnap ? snapMozilla : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

live('Firefox BiDi driver against real Firefox', () => {
  const profileDir = makeProfileDir('ff-driver-live-');
  let conn: FirefoxConnection;
  const savedHome = process.env.HOME;
  // Give the spawned Firefox the real HOME (snap needs it); restore after.
  process.env.HOME = realHome;

  const profile: BrowserProfile = {
    name: 'firefox-live-test',
    browser: 'firefox',
    binary: FIREFOX,
    endpoints: { bidi: { target: 'firefox-bidi://127.0.0.1:9671' } },
    defaultEndpoint: 'bidi',
    userDataDir: profileDir,
    firefox: { profileName: 'live-test', iniPath: path.join(profileDir, 'profiles.ini'), isDefault: false },
  };

  afterAll(async () => {
    try { conn?.bidi.close(); } catch { /* ignore */ }
    if (conn?.pid) { try { process.kill(conn.pid, 'SIGKILL'); } catch { /* already gone */ } }
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
  });

  it('launches Firefox, opens a session, and drives create/navigate/evaluate/screenshot', async () => {
    conn = await connectFirefox(profile, 'firefox-live-test@local' as ConnectionKey, 9671, { profileDir, headless: true });
    expect(conn.sessionId).toBeTruthy();
    expect(conn.bidi.isOpen).toBe(true);

    const ctx = await bidiCreateTab(conn.bidi);
    await bidiNavigate(conn.bidi, ctx, 'data:text/html,<title>BiDi</title><h1 id=h>hello</h1>');

    const value = await bidiEvaluate(conn.bidi, ctx, '({ t: document.title, h: document.getElementById("h").textContent })');
    expect(value).toEqual({ t: 'BiDi', h: 'hello' });

    // A thrown expression surfaces as an Error, not a silent undefined.
    await expect(bidiEvaluate(conn.bidi, ctx, 'throw new Error("boom")')).rejects.toThrow(/boom/);

    const png = await bidiScreenshot(conn.bidi, ctx, { type: 'image/png' });
    expect(png.length).toBeGreaterThan(100);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const contexts = await bidiTopLevelContexts(conn.bidi);
    expect(contexts.some((c) => c.context === ctx)).toBe(true);

    await bidiCloseTab(conn.bidi, ctx);
    const after = await bidiTopLevelContexts(conn.bidi);
    expect(after.some((c) => c.context === ctx)).toBe(false);
  }, 60_000);

  it('performs a trusted pointer click via input.performActions', async () => {
    const ctx = await bidiCreateTab(conn.bidi);
    await bidiNavigate(
      conn.bidi,
      ctx,
      'data:text/html,<button id=b style="position:absolute;left:10px;top:10px;width:120px;height:40px" ' +
        'onclick="window.__clicked=true">Go</button>',
    );
    await bidiClickAt(conn.bidi, ctx, 60, 30);
    const clicked = await bidiEvaluate(conn.bidi, ctx, 'window.__clicked === true');
    expect(clicked).toBe(true);
    await bidiCloseTab(conn.bidi, ctx);
  }, 60_000);

  it('fails loud when a Firefox already holds the profile without a debug port', async () => {
    // The profile dir is locked by our launched Firefox; a second connect that is
    // NOT allowed to attach (wrong port with no server) must raise the relaunch
    // error rather than silently launching a rival.
    const busy: BrowserProfile = { ...profile, userDataDir: profileDir };
    await expect(
      connectFirefox(busy, 'firefox-live-test@local2' as ConnectionKey, 9673, { profileDir, headless: true }),
    ).rejects.toThrow(/single-instance|never exposed|already running/i);
  }, 60_000);
});
