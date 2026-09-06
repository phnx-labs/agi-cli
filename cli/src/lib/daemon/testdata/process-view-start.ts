import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { serviceManagerRegistrationAllowed } from '../../service-manifest.js';
import { startDaemon, stopDaemon } from '../daemon.js';
import { getDaemonDir, getTerminalsDir, getCacheDir } from '../../state.js';

// Tripwire precedes ALL lifecycle calls. Some older Bun versions return HOME
// from os.userInfo(), which would incorrectly allow the real service manager.
assert.equal(serviceManagerRegistrationAllowed().allowed, false, 'isolated fixture must never access the production service manager');
const cold = process.argv[3] === 'cold';
const child = cold ? spawn('bun', [process.argv[4], '__daemon-run'], { stdio: 'ignore', env: process.env }) : undefined;
const started = child ? { pid: child.pid, method: 'detached' } : startDaemon(process.argv[2]);
assert.equal(started.method, 'detached');
assert.ok(started.pid);
fs.writeFileSync(path.join(process.env.HOME!, 'test-child.pid'), String(started.pid));
try {
  if (!cold) assert.ok(fs.existsSync(path.join(getDaemonDir(), 'health.json')), 'ordinary launcher publishes health before daemon starts');
  const socket = path.join(getCacheDir(), 'helpers', 'browser', 'browser.sock');
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await new Promise<boolean>(resolve => {
      const client = net.createConnection(socket);
      const done = (value: boolean) => { client.destroy(); resolve(value); };
      client.setTimeout(100, () => done(false));
      client.once('connect', () => done(true));
      client.once('error', () => done(false));
    });
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'ordinary fresh-home daemon must serve its actual browser socket');
  assert.equal(fs.readFileSync(path.join(getDaemonDir(), 'daemon.pid'), 'utf8').trim(), String(started.pid));
  const owner = JSON.parse(fs.readFileSync(path.join(getTerminalsDir(), 'process-view.json'), 'utf8'));
  assert.equal(owner.pidNamespace, fs.readlinkSync('/proc/self/ns/pid'));
  assert.equal(owner.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  console.log(`${cold ? 'cold runDaemon' : 'ordinary startDaemon: health published'}; canonical socket ready; namespace owner verified`);
} finally {
  stopDaemon();
}
