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
    expect(getDaemonDirForHome(process.env.HOME!)).toBe(getDaemonDir());
  });

  beforeEach(() => {
    priorPid = readDaemonPid();
    removeDaemonPid();
  });

  afterEach(async () => {
    for (const child of children.splice(0)) await killAndWait(child);
    if (priorPid === null) removeDaemonPid();
    else writeDaemonPid(priorPid);
  });

  it('flags a daemon-shaped process no owner record names — with its HOME and start time', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agd-leak-home-'));
    const child = await spawnDaemonStandIn(fakeHome);
    children.push(child);
    try {
      const leaked = findLeakedDaemons();
      const hit = leaked.find((d) => d.pid === child.pid);
      expect(hit, `stand-in pid ${child.pid} flagged; scan saw: ${JSON.stringify(leaked.map((d) => d.pid))}`).toBeTruthy();
      if (process.platform === 'linux') expect(hit!.home).toBe(fakeHome);
      expect(hit!.startedAt).toBeTruthy();

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

    removeDaemonPid();
    expect(findLeakedDaemons().some((d) => d.pid === child.pid)).toBe(true);
  });

  it('never flags the daemon the REAL account home’s records name (RUSH-2368 through a new door)', () => {
    const realPid = readDaemonPid(getDaemonDirForHome(os.userInfo().homedir));
    if (!realPid) return;
    expect(findLeakedDaemons().some((d) => d.pid === realPid)).toBe(false);
  });

  it('a process whose argv merely CONTAINS __daemon-run away from the last token is not a daemon', async () => {
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
