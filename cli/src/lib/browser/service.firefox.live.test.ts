import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir, userInfo } from 'os';
import * as state from '../state.js';
import * as profiles from './profiles.js';

// ─── Service-level BiDi drive against a REAL Firefox (no mocking) ───────────────
//
// The sibling service.reopen.live.test.ts does this for Chromium/CDP. This one
// drives the real BrowserService through its `bidi` backend against a real
// headless Firefox: the same-task reopen contract, tab add, evaluate, refs,
// type, trusted click, and screenshot — end to end, no protocol double.
//
// Gated on AGENTS_TEST_FIREFOX=<firefox binary>. Unset → skips cleanly.
const FIREFOX = process.env.AGENTS_TEST_FIREFOX;
const haveFirefox = !!(FIREFOX && fs.existsSync(FIREFOX));

const TEST_BROWSER_DIR = path.join(tmpdir(), 'agents-cli-firefox-live-test');
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getProfileRuntimeDir').mockImplementation((name: string) =>
  path.join(TEST_BROWSER_DIR, name),
);

const { BrowserService } = await import('./service.js');
const { connectFirefox } = await import('./drivers/firefox.js');

const KEY = 'firefox-live@endpoint-0';
const PORT = 9675;
const d = haveFirefox ? describe : describe.skip;

// See drivers/firefox.test.ts: a snap Firefox needs the REAL home (recovered via
// os.userInfo(), not the vitest sandbox $HOME) and a profile under ~/snap.
const realHome = userInfo().homedir;
const snapMozilla = path.join(realHome, 'snap', 'firefox', 'common', '.mozilla');
const useSnap = fs.existsSync(path.join(realHome, 'snap', 'firefox'));
function makeProfileDir(prefix: string): string {
  const base = useSnap ? snapMozilla : tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

d('BrowserService over Firefox BiDi against real Firefox', () => {
  let profileDir = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any;

  const dataUrl = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

  function seedTask(name: string) {
    const now = Date.now();
    const task = { id: name, name, label: name, profile: KEY, tabs: {}, currentTabId: undefined, createdAt: now, lastActionAt: now, pid: conn.pid };
    conn.tasks.set(name, task);
    return task as { tabs: Record<string, string>; currentTabId?: string };
  }

  beforeAll(async () => {
    fs.rmSync(TEST_BROWSER_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_BROWSER_DIR, { recursive: true });
    profileDir = makeProfileDir('ff-svc-live-');
    process.env.HOME = realHome;

    const ff = await connectFirefox(
      { name: 'firefox-live', browser: 'firefox', binary: FIREFOX, endpoints: { bidi: { target: `firefox-bidi://127.0.0.1:${PORT}` } }, userDataDir: profileDir, firefox: { profileName: 'live', iniPath: '', isDefault: false } },
      KEY as never,
      PORT,
      { profileDir, headless: true },
    );

    service = new BrowserService();
    conn = {
      backend: 'bidi',
      browserType: 'firefox',
      bidi: ff.bidi,
      firefoxProfile: { profileName: 'live', iniPath: '', isDefault: false },
      sessionId: ff.sessionId,
      profileDir,
      port: ff.port,
      pid: ff.pid,
      key: KEY,
      profile: 'firefox-live',
      tasks: new Map(),
      sessionCache: new Map(),
    };
    service.connections.set(KEY, conn);
  }, 60_000);

  afterAll(async () => {
    try { conn?.bidi?.close?.(); } catch { /* ignore */ }
    if (conn?.pid) { try { process.kill(conn.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { fs.rmSync(TEST_BROWSER_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('tab add opens a tab; a same-URL navigate refreshes it in place, no duplicate', async () => {
    const task = seedTask('reopen');
    const url = dataUrl('<title>A</title><h1>A</h1>');
    const added = await service.tabAdd('reopen', url);
    expect(added).toMatchObject({ created: true, refreshed: false });
    const before = (await service.tabs('reopen')).length;

    const again = await service.navigate('reopen', url);
    expect(again.tabId).toBe(added.tabId); // same short id retained
    expect(again).toMatchObject({ created: false, refreshed: true });
    expect((await service.tabs('reopen')).length).toBe(before); // no duplicate tab
    expect(Object.keys(task.tabs).length).toBe(before);
  }, 60_000);

  it('evaluate returns a structured value deserialized from BiDi', async () => {
    seedTask('evalt');
    await service.tabAdd('evalt', dataUrl('<title>Eval</title><p>hi</p>'));
    const value = await service.evaluate('evalt', undefined, '({ t: document.title, p: document.querySelector("p").textContent, n: 3 })');
    expect(value).toEqual({ t: 'Eval', p: 'hi', n: 3 });
  }, 60_000);

  it('refs → type → trusted click drives a form end to end', async () => {
    seedTask('form');
    await service.tabAdd(
      'form',
      dataUrl('<input id=q><button id=go onclick="document.getElementById(\'out\').textContent=\'clicked:\'+document.getElementById(\'q\').value">Go</button><div id=out></div>'),
    );
    const { refs } = await service.refs('form');
    expect(refs).toContain('textbox');
    expect(refs).toContain('button');

    await service.type('form', 1, 'hello bidi', undefined, false);
    expect(await service.evaluate('form', undefined, 'document.getElementById("q").value')).toBe('hello bidi');

    await service.click('form', 2);
    expect(await service.evaluate('form', undefined, 'document.getElementById("out").textContent')).toBe('clicked:hello bidi');
  }, 60_000);

  it('screenshot writes a real image file for a Firefox tab', async () => {
    seedTask('shot');
    await service.tabAdd('shot', dataUrl('<title>Shot</title><h1>shot</h1>'));
    const out = path.join(TEST_BROWSER_DIR, 'shot.png');
    const res = await service.screenshot('shot', undefined, out, 'raw');
    expect(res.bytes).toBeGreaterThan(100);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }, 60_000);

  it('an unsupported verb fails loud, naming a Chromium-family profile', async () => {
    seedTask('nope');
    await service.tabAdd('nope', dataUrl('<title>x</title>'));
    await expect(service.printToPdf('nope')).rejects.toThrow(/Firefox.*does not support pdf|Chromium/i);
  }, 60_000);

  it('recording is unsupported and says so by name; record status is a truthful "not recording", so the reaper keeps running', async () => {
    seedTask('rec');
    await service.tabAdd('rec', dataUrl('<title>rec</title>'));
    await expect(service.recordStart('rec')).rejects.toThrow(/does not support recording/);
    // hygiene.ts asks every live task this before deciding it is abandoned; a
    // throw here parked the daemon's browser-task-reap service after 3 ticks.
    await expect(service.recordStatus('rec')).resolves.toEqual({ recording: false });
    await expect(service.recordStop('rec')).rejects.toThrow(/does not support recording/);
  }, 60_000);

  it('tabs --all lists every tab in the profile, the owner\'s next to the task\'s (profileTabs)', async () => {
    const { bidiCreateTab, bidiNavigate } = await import('./drivers/firefox.js');
    const task = seedTask('all');
    const mine = await service.tabAdd('all', dataUrl('<title>Agent tab</title>'));
    // A tab nobody's task owns: the owner opened it (or another tool did).
    const foreign = await bidiCreateTab(conn.bidi);
    await bidiNavigate(conn.bidi, foreign, dataUrl('<title>Owner tab</title>'));

    const rows = await service.profileTabs('all');
    const agentRow = rows.find((r: { id: string }) => r.id === mine.tabId);
    expect(agentRow).toMatchObject({ task: 'all', title: 'Agent tab', current: task.currentTabId === mine.tabId });
    const ownerRow = rows.find((r: { id: string }) => r.id === foreign);
    expect(ownerRow).toMatchObject({ title: 'Owner tab' });
    expect(ownerRow.task).toBeUndefined();
    // Read-only: listing changed nothing the task owns.
    expect((await service.tabs('all')).map((t: { id: string }) => t.id)).toEqual([mine.tabId]);
    await service.tabClose('all');
  });

  it('done closes the task tabs without killing Firefox', async () => {
    seedTask('close');
    await service.tabAdd('close', dataUrl('<title>C</title>'));
    await service.done('close');
    expect(conn.tasks.has('close')).toBe(false);
    // Firefox is still up — other tasks can still run.
    expect(conn.bidi.isOpen).toBe(true);
  }, 60_000);
});
