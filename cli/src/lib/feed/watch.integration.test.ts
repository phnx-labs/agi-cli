import { expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { machineId } from '../machine-id.js';
import { getTerminalsDir } from '../state.js';
import { upsertSession, closeDB, getDBPath } from '../session/db.js';
import { writePidSessionEntry, readLivePidSessionEntry } from '../session/pid-registry.js';
import { loadHookSessionIndex } from '../session/hook-sessions.js';
import { writeActiveSessionsCache, clearActiveSnapshotMemoryForTest } from '../session/session-cache.js';
import type { ActiveSession } from '../session/active.js';
import { appendActivityEvent } from './activity.js';
import { buildDeclaredBlock, publishBlock, recordResolution, blockGeneration } from './feed.js';
import { watchLocalFeed, FeedSessionProjection, type FeedWatchEnvelope } from './watch.js';

it.skipIf(process.platform !== 'linux')('composes a real hook owner, SQLite history, snapshot journal, block resolution and activity into one stream', async () => {
  const scope = machineId();
  const sid = randomUUID();
  const historicalId = randomUUID();
  const launchId = randomUUID();
  const hook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK || fileURLToPath(new URL('../session/testdata/deployed-session-identity.sh', import.meta.url));
  const program = `const {spawnSync}=require('node:child_process');
    process.stdin.once('data',()=>{
      const r=spawnSync('bash',[process.argv[1]],{input:JSON.stringify({session_id:process.argv[2],cwd:process.cwd()}),encoding:'utf8'});
      if(r.status!==0) process.exit(1);
      process.stdout.write('hook-ready\\n');
    }); process.stdin.resume();`;
  const child = spawn(process.execPath, ['-e', program, hook, sid], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_LAUNCH_ID: launchId },
  });
  const controller = new AbortController();
  // All waits have a hard failure boundary; teardown always stops the watcher.
  const deadline = setTimeout(() => controller.abort(new Error('composed stream timed out')), 8_000);
  const projection = new FeedSessionProjection();
  const events: FeedWatchEnvelope[] = [];
  const listeners = new Set<() => void>();
  const until = (predicate: () => boolean): Promise<void> => new Promise((resolve, reject) => {
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(controller.signal.reason); };
    const cleanup = () => { listeners.delete(check); controller.signal.removeEventListener('abort', abort); };
    listeners.add(check); controller.signal.addEventListener('abort', abort, { once: true }); check();
  });
  let watching: Promise<void> | undefined;
  try {
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve()); child.once('error', reject);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    writePidSessionEntry({ pid: child.pid!, agent: 'codex', launchId, startedAtMs: Date.now() });
    child.stdin.write('go\n');
    await ready;
    const owner = readLivePidSessionEntry(child.pid!);
    expect(owner?.sessionId).toBe(sid);
    expect(loadHookSessionIndex().byLaunchId.get(launchId)?.session_id).toBe(sid);
    const row: ActiveSession = {
      context: 'headless', kind: 'codex', host: scope, machine: scope,
      pid: owner!.pid, sessionId: owner!.sessionId, status: 'running', pidAlive: true,
      startedAtMs: owner!.startedAtMs, lastActivityMs: Date.now(), preview: 'Working on the request',
    };
    const transcript = path.join(process.env.HOME!, 'previous-session.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: historicalId } }) + '\n');
    upsertSession({ id: historicalId, shortId: historicalId.slice(0, 8), agent: 'codex',
      machine: scope, timestamp: new Date().toISOString(), filePath: transcript }, 'Previous request');
    expect(fs.readFileSync(getDBPath()).subarray(0, 15).toString()).toBe('SQLite format 3');
    writeActiveSessionsCache('local', [row]);
    clearActiveSnapshotMemoryForTest();
    watching = watchLocalFeed({ scope, signal: controller.signal, activityPollMs: 20, emit: event => {
      events.push(...projection.apply(event));
      for (const listener of listeners) listener();
    } });
    await until(() => events.some(e => e.type === 'reset'));
    const reset = events.find(e => e.type === 'reset');
    if (reset?.type !== 'reset') throw new Error('missing reset');
    expect(reset.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: sid, sourceDevice: scope, previous: false }),
      expect.objectContaining({ sessionId: historicalId, previous: true }),
    ]));
    expect(reset.attention).toEqual([]);

    const block = buildDeclaredBlock({ sessionId: sid, mailboxId: sid, host: scope, runtime: 'headless' }, { text: 'Which destination should receive the output?' });
    publishBlock(block);
    await until(() => events.some(e => e.type === 'attention.upsert'));
    const attention = events.find(e => e.type === 'attention.upsert');
    if (attention?.type !== 'attention.upsert') throw new Error('missing attention');
    expect(attention.rowKey).toBe(attention.attention.key);
    expect(attention.attention).toMatchObject({ sessionId: sid, source: 'declared', state: 'open' });

    recordResolution({ blockId: block.blockId, generation: blockGeneration(block), resolvedAt: new Date().toISOString(), reason: 'answered', sourceCursor: block.sourceCursor });
    await until(() => events.some(e => e.type === 'attention.remove' && e.rowKey === attention.rowKey));
    appendActivityEvent({ ts: new Date(Date.now() + 1).toISOString(), event: 'artifact.created', sessionId: sid, mailboxId: sid,
      host: scope, runtime: 'headless', attachments: [{ kind: 'image', href: 'https://example.test/uploaded.png' }] });
    writeActiveSessionsCache('local', [{ ...row, preview: 'Output saved' }]);
    await until(() => events.some(e => e.type === 'activity.append') && events.some(e => e.type === 'agent.upsert' && e.agent.preview === 'Output saved'));
    expect(events.find(e => e.type === 'activity.append')).toMatchObject({ event: { attachments: [{ href: 'https://example.test/uploaded.png' }] } });
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end();
    await exited;
    writeActiveSessionsCache('local', []);
    await until(() => events.some(e => e.type === 'agent.upsert' && e.agent.sessionId === sid && e.agent.previous));
    expect(events.filter(e => e.type === 'attention.upsert')).toHaveLength(1);
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1));
  } finally {
    clearTimeout(deadline); controller.abort();
    await watching;
    child.stdin.end();
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', () => resolve()); });
    fs.rmSync(path.join(getTerminalsDir(), 'by-pid', `${child.pid}.json`), { force: true });
    closeDB();
  }
});
