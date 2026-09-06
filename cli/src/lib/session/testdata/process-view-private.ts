import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writePidSessionEntry, readLivePidSessionEntry } from '../pid-registry.js';
import { writeActiveSessionsCache, readActiveSessionsCache } from '../session-cache.js';

// A container owns its private home regardless of the name of PID 1.
assert.equal(process.pid, 1);
fs.writeFileSync('/proc/self/comm', process.argv[2]);
writePidSessionEntry({ pid: process.pid, agent: 'codex', sessionId: 'private-home', startedAtMs: Date.now() });
assert.equal(readLivePidSessionEntry(process.pid)?.sessionId, 'private-home');
writeActiveSessionsCache('local', [{ context: 'headless', kind: 'codex', sessionId: 'private-home', status: 'running' }]);
assert.equal(readActiveSessionsCache('local')?.sessions[0]?.sessionId, 'private-home');
console.log('private home: registry and snapshot published');
