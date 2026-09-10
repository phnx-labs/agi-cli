import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { tmpdir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { AddressInfo } from 'net';
import * as state from '../state.js';
import * as profiles from './profiles.js';

// ─── Same-task page reopen, driven against REAL headless Chromium (PHNX-2399) ──
//
// The rest of the browser suite drives a CDP double. This one exercises the
// contract end to end with no mocked CDP: it launches a real chrome-headless-
// shell, connects the repo's real CDPClient, and drives the real BrowserService.
// Only the on-disk runtime dir is redirected to a temp dir (as every other
// service test does) — the browser and the protocol are real.
//
// Gated on AGENTS_TEST_CHROME=<chrome/chromium binary> (and, on Linux where the
// binary's shared libs aren't system-installed, AGENTS_TEST_CHROME_LIBS=<dir> put
// on LD_LIBRARY_PATH). Unset → the suite skips cleanly, so CI needs no browser.
const CHROME = process.env.AGENTS_TEST_CHROME;
const LIBS = process.env.AGENTS_TEST_CHROME_LIBS;
const haveChrome = !!(CHROME && fs.existsSync(CHROME));

const TEST_BROWSER_DIR = path.join(tmpdir(), 'agents-cli-reopen-live-test');
vi.spyOn(state, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getBrowserRuntimeDir').mockReturnValue(TEST_BROWSER_DIR);
vi.spyOn(profiles, 'getProfileRuntimeDir').mockImplementation((name: string) =>
  path.join(TEST_BROWSER_DIR, name),
);

const { BrowserService } = await import('./service.js');
const { CDPClient, discoverBrowserWsUrl } = await import('./cdp.js');

const KEY = 'reopen@endpoint-0';
const TESTDATA = path.join(import.meta.dirname, 'testdata');

const d = haveChrome ? describe : describe.skip;

d('same-task page reopen against real Chromium (PHNX-2399)', () => {
  let chrome: ChildProcess;
  let udd = '';
  let httpServer: http.Server;
  let httpPort: number;
  let cdp: InstanceType<typeof CDPClient>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any;

  const urlFor = (p: string) => `http://127.0.0.1:${httpPort}/reopen-counter.html?p=${p}`;
  const pageTargets = async () => {
    const { targetInfos } = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    return targetInfos.filter((t) => t.type === 'page');
  };
  // Wait until the page's own load-script has run on the intended document — it
  // sets document.title to "<name> loads=N", so this can't be fooled by a stale
  // 'complete' readyState left over from a previous document.
  const settle = async (task: string, tabId: string, name: string, wantLoads?: number) => {
    for (let i = 0; i < 80; i++) {
      const title = String(await service.evaluate(task, tabId, 'document.title'));
      const m = title.match(new RegExp(`^${name} loads=(\\d+)$`));
      if (m && (wantLoads === undefined || Number(m[1]) === wantLoads)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`page ${name} never reached loads=${wantLoads ?? 'any'}`);
  };
  // The document's OWN load count. localStorage would read the per-origin key,
  // which another tab showing the same page also bumps.
  const loadsOf = (task: string, tabId: string) =>
    service.evaluate(task, tabId, 'String(window.__loads)');

  function seedTask(name: string) {
    const now = Date.now();
    const task = { id: name, name, label: name, profile: KEY, tabs: {}, currentTabId: undefined, createdAt: now, lastActionAt: now, pid: conn.pid };
    conn.tasks.set(name, task);
    return task as { tabs: Record<string, string>; currentTabId?: string };
  }

  beforeAll(async () => {
    fs.rmSync(TEST_BROWSER_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_BROWSER_DIR, { recursive: true });

    // Static server for the local HTML testdata.
    httpServer = http.createServer((req, res) => {
      const rel = (req.url || '/').split('?')[0].replace(/^\/+/, '');
      const file = path.join(TESTDATA, path.basename(rel));
      if (!file.startsWith(TESTDATA) || !fs.existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
    httpPort = (httpServer.address() as AddressInfo).port;

    udd = fs.mkdtempSync(path.join(tmpdir(), 'reopen-live-udd-'));
    const cdpPort = 9500 + Math.floor(Date.now() % 400);
    chrome = spawn(
      CHROME!,
      ['--headless', '--no-sandbox', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${udd}`, 'about:blank'],
      { env: { ...process.env, ...(LIBS ? { LD_LIBRARY_PATH: LIBS } : {}) }, stdio: 'ignore' },
    );

    let wsUrl: string | undefined;
    for (let i = 0; i < 60; i++) {
      try { wsUrl = (await discoverBrowserWsUrl(cdpPort, '127.0.0.1', 'reopen')).wsUrl; break; }
      catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!wsUrl) throw new Error('Chromium never exposed a CDP endpoint');

    cdp = new CDPClient();
    await cdp.connect(wsUrl);

    service = new BrowserService();
    conn = {
      cdp,
      port: cdpPort,
      pid: chrome.pid ?? 1, // non-zero → getSessionId skips the attach-mode stealth shim
      browserType: 'chrome',
      key: KEY,
      profile: 'reopen',
      tasks: new Map(),
      sessionCache: new Map(),
    };
    service.connections.set(KEY, conn);
  }, 40_000);

  afterAll(async () => {
    try { await cdp?.close?.(); } catch { /* ignore */ }
    // Kill chrome AND wait for it to exit BEFORE removing its user-data-dir, so
    // a still-live process can't recreate files under the dir mid-remove. Listener
    // is registered before the kill, an already-exited child resolves at once, and
    // a bounded timeout is the fallback.
    if (chrome) {
      const c = chrome;
      await new Promise<void>((resolve) => {
        if (c.exitCode !== null || c.signalCode !== null) { resolve(); return; }
        const t = setTimeout(resolve, 2000);
        c.once('exit', () => { clearTimeout(t); resolve(); });
        try { c.kill('SIGKILL'); } catch { clearTimeout(t); resolve(); }
      });
    }
    try { httpServer?.close(); } catch { /* ignore */ }
    try { fs.rmSync(TEST_BROWSER_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { if (udd) fs.rmSync(udd, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('reopening a URL already in an owned tab reloads THAT tab, keeps its ids, leaves siblings untouched', async () => {
    const task = seedTask('reopentask');
    const a = await service.tabAdd('reopentask', urlFor('A'));
    const b = await service.tabAdd('reopentask', urlFor('B'));
    expect(a).toMatchObject({ created: true, refreshed: false });
    expect(b).toMatchObject({ created: true, refreshed: false });
    const targetIdA = task.tabs[a.tabId];
    const targetIdB = task.tabs[b.tabId];

    await settle('reopentask', a.tabId, 'A', 1);
    await settle('reopentask', b.tabId, 'B', 1);
    await service.evaluate('reopentask', a.tabId, "window.__sentinel = 'A-doc-1'");
    await service.evaluate('reopentask', b.tabId, "window.__sentinel = 'B-doc-1'");
    const before = (await pageTargets()).length;

    // A is NOT the current tab (B is) — the lookup must span every owned tab.
    const reopen = await service.navigate('reopentask', urlFor('A'));

    expect(reopen.tabId).toBe(a.tabId); // SAME short id retained
    expect(task.tabs[reopen.tabId]).toBe(targetIdA); // SAME CDP target retained
    expect(reopen).toMatchObject({ created: false, refreshed: true, message: 'Tab already open—refreshed' });
    expect(task.currentTabId).toBe(a.tabId); // marked current
    expect((await pageTargets()).length).toBe(before); // no extra target

    await settle('reopentask', a.tabId, 'A', 2); // the reopen really reloaded A
    expect(await loadsOf('reopentask', a.tabId)).toBe('2');
    // A genuinely reloaded → its in-document sentinel is gone.
    expect(await service.evaluate('reopentask', a.tabId, 'window.__sentinel ?? null')).toBeNull();
    // B never reloaded → its sentinel and load count survive, id unchanged.
    expect(await loadsOf('reopentask', b.tabId)).toBe('1');
    expect(await service.evaluate('reopentask', b.tabId, 'window.__sentinel ?? null')).toBe('B-doc-1');
    expect(task.tabs[b.tabId]).toBe(targetIdB);
  }, 40_000);

  it('two concurrent tab-adds of one URL create ONE target and return the SAME id (one open, one refresh)', async () => {
    seedTask('concurrent');
    const before = (await pageTargets()).length;
    const [r1, r2] = await Promise.all([
      service.tabAdd('concurrent', urlFor('C')),
      service.tabAdd('concurrent', urlFor('C')),
    ]);
    expect(r1.tabId).toBe(r2.tabId);
    expect([r1, r2].filter((r) => r.created).length).toBe(1);
    expect([r1, r2].filter((r) => r.refreshed).length).toBe(1);
    expect((await pageTargets()).length).toBe(before + 1);
  }, 40_000);

  it('a stale registered target is not a phantom refresh — a fresh tab is created', async () => {
    const task = seedTask('staletask');
    const dd = await service.tabAdd('staletask', urlFor('D'));
    const dTargetId = task.tabs[dd.tabId];
    await cdp.send('Target.closeTarget', { targetId: dTargetId });
    conn.sessionCache.delete(dTargetId);
    for (let i = 0; i < 60; i++) {
      const gone = !(await pageTargets()).some((t) => t.targetId === dTargetId);
      if (gone) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const before = (await pageTargets()).length;
    const reopen = await service.tabAdd('staletask', urlFor('D'));
    expect(reopen).toMatchObject({ created: true, refreshed: false });
    expect((await pageTargets()).length).toBe(before + 1);
  }, 40_000);

  it('a BORROWED owned tab is excluded from reopen — reopening its URL opens another owned tab, never reloads it', async () => {
    const task = seedTask('borrowtask');
    // A: owned + BORROWED (a tab that predated the task — see Task.borrowedTabs),
    // showing url E. H: owned + not borrowed, current, showing a different url.
    const a = await service.tabAdd('borrowtask', urlFor('E'));
    const h = await service.tabAdd('borrowtask', urlFor('H'));
    await settle('borrowtask', a.tabId, 'E', 1);
    await settle('borrowtask', h.tabId, 'H', 1);
    task.borrowedTabs = [a.tabId];
    const aTargetId = task.tabs[a.tabId];
    await service.evaluate('borrowtask', a.tabId, "window.__sentinel = 'E-borrowed-doc'");

    // Reopening E: the only tab showing it is borrowed, so the reopen lookup must
    // SKIP it. tab add therefore opens ANOTHER owned tab rather than reloading the
    // borrowed one (whose document/scroll the task never opened and must not touch).
    const beforeCount = (await pageTargets()).length;
    const added = await service.tabAdd('borrowtask', urlFor('E'));
    expect(added).toMatchObject({ created: true, refreshed: false }); // not a phantom refresh
    expect(added.tabId).not.toBe(a.tabId);
    expect(task.borrowedTabs).not.toContain(added.tabId); // the new tab is owned, not borrowed
    expect((await pageTargets()).length).toBe(beforeCount + 1);

    // The borrowed tab A is byte-for-byte untouched: same CDP target, same
    // in-document sentinel, load counter still 1 (no Page.reload ran on it).
    expect(task.tabs[a.tabId]).toBe(aTargetId);
    expect(await service.evaluate('borrowtask', a.tabId, 'window.__sentinel ?? null')).toBe('E-borrowed-doc');
    expect(await loadsOf('borrowtask', a.tabId)).toBe('1');
  }, 40_000);
});
