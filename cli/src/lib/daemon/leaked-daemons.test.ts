/**
 * Leaked-daemon detection (W4, PHNX-3736) — against REAL daemon-shaped
 * processes, no mocks. A stand-in child (`node -e … __daemon-run`) is exactly
 * what the box-wide `ps` scan matches for a real daemon, and each test owns
 * its child's death.
 *
 * The suite runs under a redirected HOME (tests/setup.ts), so the pid-file
 * ownership record these tests write lands in the fork-private sandbox, never
 * in the developer's real daemon dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { findLeakedDaemons, getDaemonDirForHome, listDaemonRunProcesses } from './leaked-daemons.js';
import { readDaemonPid, writeDaemonPid, removeDaemonPid } from './daemon.js';
import { getDaemonDir } from '../state.js';

async function spawnDaemonStandIn(home?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run'], {
    stdio: 'ignore',
    env: home ? { ...process.env, HOME: home } : process.env,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(child.pid).toBeTruthy();
  return child;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  const pid = child.pid!;
  child.kill('SIGKILL');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === 'win32')('findLeakedDaemons (W4, PHNX-3736)', () => {
  let priorPid: number | null = null;
  const children: ChildProcess[] = [];

  it('getDaemonDirForHome answers the same address state.ts’s DAEMON_DIR layout does (drift guard)', () => {
    // The helper duplicates state.ts's layout because state.ts cannot be
    // edited without blowing the required impact gate's budget (see the
    // helper's comment). If state.ts's DAEMON_DIR chain ever moves, this
    // fails here instead of silently un-owning the production daemon. The
    // suite redirects HOME and deliberately never sets AGENTS_DAEMON_DIR
    // (tests/setup.ts:131), so both sides resolve the same sandbox address.
    expect(getDaemonDirForHome(process.env.HOME!)).toBe(getDaemonDir());
  });

  beforeEach(() => {
    priorPid = readDaemonPid();
    removeDaemonPid();
  });

  afterEach(async () => {
    for (const child of children.splice(0)) await killAndWait(child);
    // Leave any real daemon record exactly as we found it.
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('flags a daemon-shaped process no owner record names — with its HOME and start time', async () => {
    // The incident shape: a daemon launched under a temp HOME, exactly the
    // /tmp/pin-e2e-<pid> leak that ran 4+ days on yosemite-s1.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-leak-home-'));
    const child = await spawnDaemonStandIn(fakeHome);
    children.push(child);
    try {
      const leaked = findLeakedDaemons();
      const hit = leaked.find((d) => d.pid === child.pid);
      expect(hit, `stand-in pid ${child.pid} flagged; scan saw: ${JSON.stringify(leaked.map((d) => d.pid))}`).toBeTruthy();
      if (process.platform === 'linux') expect(hit!.home).toBe(fakeHome);
      expect(hit!.startedAt).toBeTruthy();

      // Once the process is dead it is no longer a running leak.
      await killAndWait(child);
      children.length = 0;
      expect(findLeakedDaemons().some((d) => d.pid === child.pid)).toBe(false);
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not flag a pid the recorded daemon.pid names', async () => {
    const child = await spawnDaemonStandIn();
    children.push(child);

    writeDaemonPid(child.pid!);
    expect(findLeakedDaemons().some((d) => d.pid === child.pid)).toBe(false);

    // Remove the ownership record and the same live process becomes a leak —
    // this is the exact invisibility the /tmp/pin-e2e daemon had: alive, but
    // named by no pid file this install reads.
    removeDaemonPid();
    expect(findLeakedDaemons().some((d) => d.pid === child.pid)).toBe(true);
  });

  it('never flags the daemon the REAL account home’s records name (RUSH-2368 through a new door)', () => {
    // The suite itself runs under a redirected HOME, so this test IS the
    // redirected-HOME caller: the ownership check must reach the real account
    // home's records (getDaemonDirForHome(os.userInfo().homedir)) and exclude
    // whatever they name. On a box with a live production daemon this is the
    // exact assertion that keeps `agents doctor` from printing
    // `kill <production-daemon-pid>`; on a box with no recorded daemon there
    // is nothing to assert.
    const realPid = readDaemonPid(getDaemonDirForHome(os.userInfo().homedir));
    if (!realPid) return;
    expect(findLeakedDaemons().some((d) => d.pid === realPid)).toBe(false);
  });

  it('a process whose argv merely CONTAINS __daemon-run away from the last token is not a daemon', async () => {
    // An `agents run claude "<prompt quoting __daemon-run>"` invocation matched
    // a naive substring scan and produced false "duplicate daemon" rows — the
    // last-token invariant is what keeps those out.
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1e9)', '__daemon-run', 'trailing-arg'],
      { stdio: 'ignore' },
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(listDaemonRunProcesses().some((p) => p.pid === child.pid)).toBe(false);
    expect(findLeakedDaemons().some((d) => d.pid === child.pid)).toBe(false);
  });
});
