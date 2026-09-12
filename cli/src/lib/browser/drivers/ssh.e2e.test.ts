/**
 * Opt-in end-to-end coverage for the `agents browser --device <win>` SSH driver.
 *
 * Unlike ssh.test.ts (script-builder units + spawn-stubbed transport tests),
 * this suite drives the REAL remote browser against a live Windows box: it
 * launches Edge over ssh via an interactive scheduled task, opens the ssh -L CDP tunnel, connects over
 * CDP, screenshots a page, then tears the browser down and confirms the remote
 * process is actually gone. It covers the regression class from issue #561 —
 * remote launch, tunnel, and the cleanup gap where `browser stop` left the
 * task-launched browser running on win-mini.
 *
 * GATED: SKIPS cleanly when AGENTS_TEST_WIN_HOST is unset, so CI stays green
 * with no Windows runner. To run it against a registered Windows device:
 *
 *   AGENTS_TEST_WIN_HOST=win-mini bun run test -- src/lib/browser/drivers/ssh.e2e.test.ts
 *
 * Real invocations only — no mocking. Edge ships with Windows, so no remote
 * install step is needed (the computer path's setup is covered separately in
 * ssh-tunnel.e2e.test.ts).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { connectSSH, type SSHConnection } from './ssh.js';
import { resolveRemoteDevice } from '../../ssh-tunnel.js';
import { sshExec } from '../../ssh-exec.js';
import { buildWindowsKillScript, encodePowerShell } from './ssh.js';
import { CDPClient } from '../cdp.js';
import type { BrowserProfile } from '../types.js';

const HOST = process.env.AGENTS_TEST_WIN_HOST ?? '';
const suite = HOST ? describe : describe.skip;

// A fixed CDP port distinct from the 9222 default so a developer's own browser
// session on the box can't collide with the test's tunnel (localPort === this).
const CDP_PORT = 9333;
const LAUNCH_TIMEOUT = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the remote for a listener on `port`; resolve true once none remains. */
async function remotePortFree(target: string, port: number, tries = 30): Promise<boolean> {
  const script =
    `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) ` +
    `{ Write-Output 'LISTEN' } else { Write-Output 'FREE' }`;
  for (let i = 0; i < tries; i++) {
    const res = sshExec(target, encodePowerShell(script), { timeoutMs: 20_000 });
    if (res.code === 0 && res.stdout.includes('FREE')) return true;
    await sleep(500);
  }
  return false;
}

suite('browser --device live remote (AGENTS_TEST_WIN_HOST)', () => {
  let conn: SSHConnection | null = null;
  let target = '';
  let user = '';
  let host = '';

  afterAll(async () => {
    // Guarantee the remote browser is torn down even if the test bailed before
    // calling cleanup() — otherwise a task-launched Edge lingers on the box.
    try {
      conn?.cleanup();
    } catch {
      /* best effort */
    }
    if (target) {
      // Tree-kill via the canonical driver script — Stop-Process on the main
      // pid alone orphans Chromium children that hold the profile lock and
      // wedge every later launch (the bug this suite caught on win-mini).
      sshExec(target, encodePowerShell(buildWindowsKillScript(CDP_PORT)), { timeoutMs: 20_000 });
    }
  }, LAUNCH_TIMEOUT);

  it(
    'browser start + screenshot + stop round-trips against the live Windows host',
    async () => {
      ({ target, user, host } = await resolveRemoteDevice(HOST));

      const endpoint = `ssh://${user}@${host}:${CDP_PORT}?os=windows`;
      const profile: BrowserProfile = {
        name: 'e2e-win-host',
        browser: 'edge',
        endpoints: [endpoint],
        viewport: { width: 1280, height: 800 },
      };

      // Scenario 4: `browser start --device` — scheduled-task-launch Edge on the remote, open
      // the ssh -L CDP tunnel, and connect over CDP. connectSSH throws on any hop
      // failure (missing exe, tunnel timeout, wrong browser identity).
      //
      // Cold-start allowance: Edge on a fresh --user-data-dir can take tens of
      // seconds to bind its CDP port, while the driver's discovery probe is a
      // single 3s window. Retry the whole connect — the relaunch is harmless
      // (a second instance against a locked profile exits immediately) and the
      // tunnel from a failed attempt is reused via the port-occupant path.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 6 && !conn; attempt++) {
        if (attempt > 0) await sleep(5_000);
        try {
          conn = await connectSSH(endpoint, profile);
        } catch (e) {
          lastErr = e;
        }
      }
      if (!conn) throw lastErr;
      expect(conn.port).toBe(CDP_PORT);
      expect(conn.pid).toBeGreaterThan(0);

      // Screenshot a real page target through the tunnel — proves the browser is
      // live and CDP round-trips, not just that the port answered. The page ws is
      // reached via the same tunnel connectSSH established (localhost:conn.port).
      const list = (await (
        await fetch(`http://127.0.0.1:${conn.port}/json`)
      ).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      expect(page?.webSocketDebuggerUrl, 'no CDP page target exposed by remote Edge').toBeTruthy();

      const pageCdp = new CDPClient();
      await pageCdp.connect(page!.webSocketDebuggerUrl!);
      try {
        const shot = await pageCdp.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
        });
        const png = Buffer.from(shot.data, 'base64');
        expect(png.length).toBeGreaterThan(1000);
        expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      } finally {
        pageCdp.close();
      }

      // Scenario 4b (PHNX-2663): a browser-daemon restart on the driving box
      // drops the in-memory connection, but the remote browser AND the tunnel
      // survive. `attachRunningProfile` rehydrates an ssh:// task by re-running
      // connectSSH for the same key — this proves that reconnect path reuses the
      // live tunnel (isOwnTunnel) and returns a working CDP, instead of the old
      // `return null` that surfaced as "Unknown browser task". Do NOT cleanup the
      // reconnection: it shares the tunnel/remote that Scenario 5 tears down.
      const reconn = await connectSSH(endpoint, profile);
      expect(reconn.port).toBe(CDP_PORT);
      expect(reconn.pid).toBeGreaterThan(0);
      const relist = (await (
        await fetch(`http://127.0.0.1:${reconn.port}/json`)
      ).json()) as Array<{ type: string }>;
      expect(relist.some((t) => t.type === 'page'), 'reconnect saw no live page target').toBe(true);

      // Scenario 5: `browser stop` — cleanup() kills the remote browser BEFORE the
      // tunnel (the regression). Confirm the remote process is actually gone by
      // watching the remote CDP port stop listening.
      conn.cleanup();
      conn = null;
      const freed = await remotePortFree(target, CDP_PORT);
      expect(freed, `remote Edge still listening on ${CDP_PORT} after stop`).toBe(true);
    },
    LAUNCH_TIMEOUT,
  );
});
