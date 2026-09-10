import { describe, it, expect } from 'vitest';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { connectLocal, arcAttachRequiredError, attachOnlyRequiredError, foreignInstanceError, storeInUseError } from './local.js';
import type { BrowserProfile, ConnectionKey } from '../types.js';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate free port')));
      }
    });
  });
}

function listenOn(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      // Hold the connection open briefly so the probe's ACK lands cleanly.
      sock.on('data', () => {});
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// A real listener that answers the CDP /json/version probe immediately with a
// non-CDP 404 (a plausible "some other web server squats the port" case), so
// discoverBrowserWsUrl rejects fast on !response.ok instead of waiting out its
// 3s timeout. Used where the test only needs the "non-CDP occupant → never
// launches" outcome, not the hang-until-timeout path.
function respondNotFound(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.on('data', () => {
        sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      });
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// A real listener that answers /json/version with a VALID Comet CDP payload, so
// discoverBrowserWsUrl + verifyBrowserIdentity both pass and the flow reaches
// the attach-only ownership check. The listener is this test process, which
// carries no --user-data-dir, so getProcessUserDataDir returns null — the
// "occupant serves CDP but ownership is unverifiable" case.
function respondCdp(port: number): Promise<net.Server> {
  const body = JSON.stringify({
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/x`,
    Browser: 'Comet/1.0.0',
  });
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sock.on('data', () => {
        sock.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('connectLocal — TCP probe fallback for #43', () => {
  it('refuses to auto-launch when the configured port is held by a non-CDP TCP listener', async () => {
    const port = await freePort();
    // A real occupant that answers the probe fast with a non-CDP 404, so this
    // resolves in ms rather than sitting through discoverBrowserWsUrl's 3s
    // timeout twice. The hang-until-timeout occupant is still covered by the Arc
    // non-CDP-listener test above (which uses listenOn).
    const blocker = await respondNotFound(port);

    const profile: BrowserProfile = {
      name: 'comet-like',
      browser: 'chrome',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    try {
      // Either branch (lsof-based occupant detection or the TCP-probe fallback)
      // is fine — the contract is: surface an actionable error that names the
      // port + the profile, no Node stacktrace. Issue #43 is about UX, not
      // about which detection path catches it first. One real connect attempt;
      // assert the single message names both the port and the profile.
      const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile).then(
        () => {
          throw new Error('expected connectLocal to reject, not launch');
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(new RegExp(`${port}`));
      expect(err.message).toMatch(/comet-like/);
    } finally {
      blocker.close();
    }
  });
});

describe('connectLocal — Arc attaches to a running instance, never launches a duplicate (PHNX-2399)', () => {
  const key = 'my-arc@endpoint-0' as ConnectionKey;

  it('fails loud with the relaunch instruction when the Arc port serves no CDP endpoint', async () => {
    // Nothing is listening on this port. For a Chromium-family browser this is
    // the "fine to launch fresh" case — but Arc is single-instance and cannot be
    // spawned as an isolated debug instance, so it must fail loud rather than
    // spawn the stray window PHNX-2399 exists to end.
    const port = await freePort();
    const profile: BrowserProfile = {
      name: 'my-arc',
      browser: 'arc',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    // One real connect attempt; the single loud message must name the profile,
    // the port, and the single-instance reason — and never reach launchBrowser.
    const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
      () => {
        throw new Error('expected connectLocal to reject, not launch');
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/my-arc/);
    expect(err.message).toMatch(new RegExp(`--remote-debugging-port=${port}`));
    expect(err.message).toMatch(/single-instance/);
  });

  it('still fails loud (never launches) when the Arc port is held by a non-CDP listener', async () => {
    const port = await freePort();
    const blocker = await listenOn(port);
    const profile: BrowserProfile = {
      name: 'held-arc',
      browser: 'arc',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
    try {
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile, key)).rejects.toThrow(
        /held-arc/,
      );
    } finally {
      blocker.close();
    }
  });
});

describe('arcAttachRequiredError', () => {
  it('names the profile, the port, and the exact relaunch', () => {
    const msg = arcAttachRequiredError('work', 9222).message;
    expect(msg).toContain('work');
    expect(msg).toContain('open -a Arc --args --remote-debugging-port=9222');
    expect(msg).toContain('single-instance');
  });
});

describe('connectLocal — an attach-only Comet never spawns a second instance (PHNX-3967)', () => {
  const key = 'agents-comet@endpoint-0' as ConnectionKey;

  it('fails loud with the durable-dir relaunch when nothing serves CDP on the port', async () => {
    // Free port, attach-only Comet: this is the "fine to launch fresh" case for a
    // launch-policy Chromium profile — but an attach-only profile must NEVER reach
    // launchBrowser, or it spawns the second, logged-out dock tile the ticket ends.
    const port = await freePort();
    const profile: BrowserProfile = {
      name: 'agents-comet',
      browser: 'comet',
      launchPolicy: 'attach-only',
      userDataDir: '/tmp/agents-comet-durable',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };

    // One real connect attempt; the single loud message must name the profile,
    // the durable-dir relaunch, and the attach-only reason — never launchBrowser.
    const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
      () => {
        throw new Error('expected connectLocal to reject, not launch');
      },
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/agents-comet/);
    expect(err.message).toMatch(
      new RegExp(`open -a Comet --args --remote-debugging-port=${port} --user-data-dir=/tmp/agents-comet-durable`),
    );
    expect(err.message).toMatch(/attach-only/);
  });

  it('refuses to attach when an occupant serves CDP but its user-data-dir is unverifiable', async () => {
    // discoverBrowserWsUrl + verifyBrowserIdentity pass (valid Comet payload),
    // so the flow reaches verifyEndpointOwnership; the occupant is this test
    // process with no --user-data-dir, so ownership can't be confirmed and the
    // attach-only guard must fail loud rather than drive an unverified instance.
    const port = await freePort();
    const srv = await respondCdp(port);
    const profile: BrowserProfile = {
      name: 'agents-comet',
      browser: 'comet',
      launchPolicy: 'attach-only',
      userDataDir: '/tmp/agents-comet-durable',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
    try {
      const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, 'agents-comet@e0').then(
        () => {
          throw new Error('expected connectLocal to reject, not attach');
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(/agents-comet/);
      expect(err.message).toMatch(/ownership can't be confirmed|could not be read|unverified/i);
    } finally {
      srv.close();
    }
  });

  it('still fails loud (never launches) when the port is held by a non-CDP listener', async () => {
    const port = await freePort();
    // A real listener that answers the CDP probe FAST with a non-CDP 404, rather
    // than the silent hold in listenOn(): discoverBrowserWsUrl rejects on the
    // !response.ok branch in ms instead of waiting out its 3s timeout, so this
    // attach-only branch is covered without adding a real 3s wait to the suite.
    // The timeout-hold path stays covered by the Arc sibling above and the #43
    // probe test.
    const blocker = await respondNotFound(port);
    const profile: BrowserProfile = {
      name: 'agents-comet',
      browser: 'comet',
      launchPolicy: 'attach-only',
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
    try {
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile, key)).rejects.toThrow(/agents-comet/);
    } finally {
      blocker.close();
    }
  });
});

describe('attachOnlyRequiredError (PHNX-3967)', () => {
  it('routes an arc profile to the Arc-specific message', () => {
    const msg = attachOnlyRequiredError({ name: 'work', browser: 'arc' }, 9222).message;
    expect(msg).toContain('open -a Arc --args --remote-debugging-port=9222');
    expect(msg).toContain('single-instance');
  });

  it('names the browser, port, and durable data dir for a Comet profile', () => {
    const msg = attachOnlyRequiredError(
      { name: 'agents-comet', browser: 'comet', userDataDir: '/data/comet' },
      9333,
    ).message;
    expect(msg).toContain('agents-comet');
    expect(msg).toContain('open -a Comet --args --remote-debugging-port=9333 --user-data-dir=/data/comet');
    expect(msg).toContain('never launches a second one');
  });
});

describe('foreignInstanceError — port-squat rejection (PHNX-3967)', () => {
  it('names both dirs, the pid, and the ownership-rejection prefix so the driver re-throws it', () => {
    const err = foreignInstanceError(
      { name: 'agents-comet', browser: 'comet', userDataDir: '/data/comet' },
      9333,
      '/tmp/rush-mockup-comet.abc',
      45995,
    );
    expect(err.message.startsWith('Attach-only ownership check failed')).toBe(true);
    expect(err.message).toContain('/tmp/rush-mockup-comet.abc');
    expect(err.message).toContain('/data/comet');
    expect(err.message).toContain('kill 45995');
  });
});

describe('connectLocal — a store-pinned Comet never doubles a browser that already holds its store (PHNX-4042 review)', () => {
  const key = 'comet-work@endpoint-0' as ConnectionKey;

  // A discovered Comet profile: pinned to the owner's store, no launch policy,
  // so the driver may launch on that store — but only while nothing holds it.
  function storePinned(userDataDir: string, port: number, binary: string): BrowserProfile {
    return {
      name: 'comet-work',
      browser: 'comet',
      userDataDir,
      profileDirectory: 'Default',
      binary,
      endpoints: [`cdp://127.0.0.1:${port}`],
    };
  }

  function tempStore(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-comet-store-'));
  }

  it('refuses with the relaunch command when a live process holds the store (SingletonLock) and the port is silent', async () => {
    const store = tempStore();
    // Chromium's lock: `<host>-<pid>`. This test process is the live holder.
    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(store, 'SingletonLock'));
    const port = await freePort();
    const profile = storePinned(store, port, path.join(store, 'no-such-binary'));
    try {
      const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
        () => {
          throw new Error('expected connectLocal to reject, not launch');
        },
        (e: unknown) => e as Error,
      );
      expect(err.message).toMatch(/comet-work/);
      expect(err.message).toMatch(new RegExp(`\\(pid ${process.pid}\\) already has that store open`));
      expect(err.message).toMatch(
        new RegExp(`open -a Comet --args --remote-debugging-port=${port} --user-data-dir=${store} --profile-directory=Default`),
      );
      // Never reached launchBrowser: that path fails on the missing binary instead.
      expect(err.message).not.toMatch(/Could not start/);
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it('ignores a stale lock (dead pid) and goes on to launch', async () => {
    const store = tempStore();
    // A pid that has already exited: the lock is a leftover, not an owner.
    const dead = spawnSync('true');
    fs.symlinkSync(`${os.hostname()}-${dead.pid}`, path.join(store, 'SingletonLock'));
    const port = await freePort();
    const profile = storePinned(store, port, path.join(store, 'no-such-binary'));
    try {
      // The launch itself fails on the missing binary, which proves the stale
      // lock did not stop the flow before launchBrowser.
      await expect(connectLocal(`cdp://127.0.0.1:${port}`, profile, key)).rejects.toThrow(
        /Could not start comet for profile "comet-work".*Custom binary not found/,
      );
    } finally {
      fs.rmSync(store, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'fails loud with the relaunch command when the launched browser exits before binding its port (singleton hand-off)',
    async () => {
      const store = tempStore();
      // A "browser" that exits at once, exactly what Chromium does after handing
      // its arguments to the instance already holding the store.
      const binary = path.join(store, 'comet-handoff.sh');
      fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const port = await freePort();
      const profile = storePinned(store, port, binary);
      const started = Date.now();
      try {
        const err = await connectLocal(`cdp://127.0.0.1:${port}`, profile, key).then(
          () => {
            throw new Error('expected connectLocal to reject');
          },
          (e: unknown) => e as Error,
        );
        expect(err.message).toMatch(/exited \(code 0\) before serving the DevTools protocol/);
        expect(err.message).toMatch(
          new RegExp(`open -a Comet --args --remote-debugging-port=${port} --user-data-dir=${store} --profile-directory=Default`),
        );
        // The exit is caught on the first poll tick, not after the 20s deadline.
        expect(Date.now() - started).toBeLessThan(10_000);
      } finally {
        fs.rmSync(store, { recursive: true, force: true });
      }
    },
  );
});

describe('storeInUseError (PHNX-4042)', () => {
  it('names the profile, the pid, the store, and the relaunch with the profile directory', () => {
    const message = storeInUseError(
      { name: 'comet-personal', browser: 'comet', userDataDir: '/Users/o/Library/Application Support/Comet', profileDirectory: 'Profile 1' },
      9335,
      4242,
    ).message;
    expect(message).toMatch(/comet-personal/);
    expect(message).toMatch(/Comet \(pid 4242\) already has that store open/);
    expect(message).toMatch(/--remote-debugging-port=9335 --user-data-dir=\/Users\/o\/Library\/Application Support\/Comet --profile-directory=Profile 1/);
  });
});
