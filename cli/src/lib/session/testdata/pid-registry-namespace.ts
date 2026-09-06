import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prunePidSessionRegistry, readPidSessionEntry, writePidSessionEntry } from '../pid-registry.js';

import { getActiveSessions } from '../active.js';
import { loadLocalActiveSessions, loadFleetActiveSessions, writeActiveSessionsCache, updateImmutableMemos, readActiveSessionsCache } from '../session-cache.js';

// Invoked only by the isolated-HOME test fork, inside a real unshare namespace.
const hostPid = Number(process.argv[2]);
// Names convey no authority: this is PID 1 with its own procfs in one variant.
fs.writeFileSync('/proc/self/comm', 'init');
assert.equal(readPidSessionEntry(hostPid)?.sessionId, 'host-session');
assert.throws(() => process.kill(hostPid, 0), { code: 'ESRCH' });
writePidSessionEntry({ pid: hostPid, agent: 'codex', sessionId: 'namespace-collision', startedAtMs: Date.now() });
assert.equal(readPidSessionEntry(hostPid)?.sessionId, 'host-session');
prunePidSessionRegistry(() => false);
assert.equal(readPidSessionEntry(hostPid)?.sessionId, 'host-session');
const local = await loadLocalActiveSessions({ forceRefresh: true, gather: async () => { throw new Error('partial gather must never run'); } });
assert.equal(local.sessions[0].sessionId, 'host-session');
assert.equal(local.capturedAt, 1);
assert.equal(local.servedFromCache, true);
const fleet = await loadFleetActiveSessions({ forceRefresh: true, gather: async () => { throw new Error('partial fleet gather must never run'); } });
assert.equal(fleet.remoteDeviceCount, 2);
assert.equal(fleet.capturedAt, 1);
assert.equal((await getActiveSessions())[0].sessionId, 'host-session');
assert.throws(() => writeActiveSessionsCache('local', []), /process namespace/);
assert.throws(() => updateImmutableMemos([]), /process namespace/);
assert.equal(readActiveSessionsCache('local')?.capturedAt, 1);
console.log('host pid: ESRCH; overwrite: refused; registry and snapshots: retained');
