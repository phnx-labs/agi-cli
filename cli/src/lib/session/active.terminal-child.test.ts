import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { getTerminalsDir } from '../state.js';
import { writePidSessionEntry, type PidSessionEntry } from './pid-registry.js';
import { clearActiveScanCachesForTest, listTerminalsActive, listUnattributedActive, processTableLiveReadCountForTest } from './active.js';
import { writerProcessView } from './process-view.js';
import { closeDB } from './db.js';
import { claudeProjectDirName } from '../project-key.js';

const fixtures = fileURLToPath(new URL('./testdata/', import.meta.url));
const root = fs.mkdtempSync(path.join(process.env.HOME!, 'terminal-child-'));
let tabCount = 0;
const registry = path.join(getTerminalsDir(), 'live-terminals.json');
const cwd = path.join(root, 'project');
fs.mkdirSync(cwd);
const sessionA = '10000000-0000-4000-8000-000000000001';
const sessionB = '10000000-0000-4000-8000-000000000002';
const sessionC = '10000000-0000-4000-8000-000000000003';
const transcriptDir = path.join(process.env.HOME!, '.claude', 'projects', claudeProjectDirName(cwd));
fs.mkdirSync(transcriptDir, { recursive: true });
for (const id of [sessionA, sessionB, sessionC]) {
  fs.copyFileSync(path.join(fixtures, 'timeline-claude.jsonl'), path.join(transcriptDir, `${id}.jsonl`));
}
let shell: ChildProcess | undefined;

async function startTab(count: number, layout = 'siblings', kind = 'claude'): Promise<number[]> {
  const binary = path.join(root, `bin-${tabCount++}`, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  if (process.platform === 'darwin') fs.symlinkSync('/bin/sleep', binary);
  else {
    fs.copyFileSync('/bin/sleep', binary);
    fs.chmodSync(binary, 0o755);
  }
  shell = spawn('bash', [path.join(fixtures, 'terminal-agent-children.sh'), binary, String(count), layout], {
    cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pids: number[] = [];
  let output = '';
  shell.stdout!.on('data', chunk => {
    output += chunk.toString();
    pids.splice(0, pids.length, ...output.trim().split('\n').filter(Boolean).map(Number));
  });
  await once(shell, 'spawn');
  await expect.poll(() => pids.length).toBe(count * (layout === 'nested' ? 2 : 1));
  expect(writerProcessView()).toBeDefined();
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({ window: {
    at: new Date().toISOString(), entries: [{ pid: shell.pid, sessionId: sessionA,
      kind, cwd, label: 'My tab', startedAtMs: Date.now(), tabIndex: 3 }],
  } }));
  return pids;
}

function record(pid: number, sessionId: string, extra: Partial<PidSessionEntry> = {}): void {
  writePidSessionEntry({ pid, sessionId, agent: 'claude', cwd, startedAtMs: Date.now(), ...extra });
}

async function scan(): Promise<Awaited<ReturnType<typeof listTerminalsActive>>> {
  clearActiveScanCachesForTest();
  return listTerminalsActive();
}

afterEach(async () => {
  if (shell?.pid) {
    const exited = once(shell, 'exit');
    process.kill(-shell.pid, 'SIGTERM');
    await exited;
  }
  shell = undefined;
  fs.rmSync(registry, { force: true });
  clearActiveScanCachesForTest();
});
afterAll(() => closeDB());

describe.skipIf(process.platform === 'win32')('published shell adopts its live agent (PHNX-4218)', () => {
  it('uses B and T through a wrapper, preserves tab metadata and suppresses the duplicate', async () => {
    const [pid] = await startTab(1);
    writePidSessionEntry({ pid: shell!.pid!, agent: 'claude', startedAtMs: Date.now(), launchId: 'wrapper' });
    const published = JSON.parse(fs.readFileSync(registry, 'utf8'));
    published.window.entries[0].terminalId = 'published-T';
    fs.writeFileSync(registry, JSON.stringify(published));
    record(pid, sessionB, { terminalId: 'T', launchId: 'launch-B', actor: 'test-owner', harness: 'custom' });
    const rows = await scan();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: shell!.pid, sessionId: sessionB, terminalId: 'T',
      launchId: 'launch-B', harness: 'custom', owner: 'test-owner', label: 'My tab', kind: 'claude',
      windowId: 'window', tabIndex: 3, sessionFile: path.join(transcriptDir, `${sessionB}.jsonl`) });
    const unattributed = await listUnattributedActive(new Set(rows.map(row => row.pid!)));
    expect(unattributed.some(row => row.pid === pid || row.sessionId === sessionB)).toBe(false);
    expect(processTableLiveReadCountForTest()).toBe(1);
    record(pid, sessionB);
    expect((await scan())[0]).toMatchObject({ sessionId: sessionB, terminalId: 'published-T' });
  });

  it('keeps published A when the shell has no agent child, with optional terminalId', async () => {
    await startTab(0);
    const [before] = await scan();
    expect(before).toMatchObject({ sessionId: sessionA, label: 'My tab', pid: shell!.pid });
    expect(before.terminalId).toBeUndefined();
    const published = JSON.parse(fs.readFileSync(registry, 'utf8'));
    published.window.entries[0].terminalId = 'published-T';
    fs.writeFileSync(registry, JSON.stringify(published));
    expect((await scan())[0]).toMatchObject({ sessionId: sessionA, terminalId: 'published-T' });
  });

  it('lists a tab published with only a terminal id and carries its pid record origin (PHNX-4263)', async () => {
    const [pid] = await startTab(1, 'siblings', 'codex');
    const published = JSON.parse(fs.readFileSync(registry, 'utf8'));
    delete published.window.entries[0].sessionId;
    published.window.entries[0].terminalId = 'cx-only';
    fs.writeFileSync(registry, JSON.stringify(published));
    const [row] = await scan();
    expect(row).toMatchObject({ pid: shell!.pid, kind: 'codex', terminalId: 'cx-only', windowId: 'window', tabIndex: 3 });
    expect(row.originTerminal).toBeUndefined();
    record(pid, sessionB, { agent: 'codex', terminalId: 'cx-only', originTerminal: { device: 'zion', terminalId: 'cx-only' } });
    expect((await scan())[0]).toMatchObject({ sessionId: sessionB, originTerminal: { device: 'zion', terminalId: 'cx-only' } });
  });

  it('selects the latest recorded start and breaks ties by pid, independent of traversal order', async () => {
    const pids = (await startTab(2)).sort((a, b) => a - b);
    const now = Date.now();
    record(pids[0], sessionB, { startedAtMs: now, terminalId: 'newest' });
    record(pids[1], sessionC, { startedAtMs: now - 1 });
    expect((await scan())[0]).toMatchObject({ sessionId: sessionB, terminalId: 'newest', startedAtMs: now });
    record(pids[1], sessionC, { startedAtMs: now });
    expect((await scan())[0].sessionId).toBe(sessionC);
    expect((await scan())[0].sessionId).toBe(sessionC);
  });

  it.each(['claude', 'codex'])('keeps agent A when it launches a newer nested %s agent B', async agent => {
    const [parent, child] = await startTab(1, 'nested');
    const startedAtMs = Date.now();
    record(parent, sessionA, { startedAtMs, launchId: 'launch-A', terminalId: 'tab-A', actor: 'owner-A' });
    record(child, sessionB, { agent, startedAtMs: startedAtMs + 1, launchId: 'launch-B', terminalId: 'tab-B', actor: 'owner-B' });
    const expected = { pid: shell!.pid, kind: 'claude', sessionId: sessionA,
      sessionFile: path.join(transcriptDir, `${sessionA}.jsonl`),
      launchId: 'launch-A', terminalId: 'tab-A', owner: 'owner-A', startedAtMs };
    expect((await scan())[0]).toMatchObject(expected);
    process.kill(child, 'SIGTERM');
    await expect.poll(() => {
      try { process.kill(child, 0); return true; } catch { return false; }
    }).toBe(false);
    expect((await scan())[0]).toMatchObject(expected);
  });

  it('stops at an agent record before its session ID is known', async () => {
    const [parent, child] = await startTab(1, 'nested');
    writePidSessionEntry({ pid: parent, agent: 'claude', startedAtMs: Date.now() });
    record(child, sessionB);
    expect((await scan())[0].sessionId).toBe(sessionA);
  });

  it('prefers the shallowest recorded agent over a newer agent in another branch', async () => {
    const [child, sibling] = await startTab(2);
    const parent = Number(execFileSync('ps', ['-p', String(child), '-o', 'ppid='], { encoding: 'utf8' }).trim());
    const now = Date.now();
    record(parent, sessionB, { startedAtMs: now });
    record(sibling, sessionC, { startedAtMs: now + 1 });
    expect((await scan())[0].sessionId).toBe(sessionB);
  });

  it('keeps the published session when the nearest agent kind differs, even with a matching nested agent', async () => {
    const [parent, child] = await startTab(1, 'nested');
    record(parent, sessionB, { agent: 'codex', launchId: 'wrong-kind' });
    record(child, sessionC);
    const [row] = await scan();
    expect(row).toMatchObject({ kind: 'claude', sessionId: sessionA, sessionFile: path.join(transcriptDir, `${sessionA}.jsonl`) });
    expect(row.launchId).toBeUndefined();
  });

  it('rejects a mismatched direct PID record too', async () => {
    await startTab(0);
    record(shell!.pid!, sessionB, { agent: 'codex' });
    expect((await scan())[0]).toMatchObject({ kind: 'claude', sessionId: sessionA });
  });

  it('uses the adopted kind for both the row and transcript when the published kind is unknown', async () => {
    const [pid] = await startTab(1, 'siblings', 'unknown');
    record(pid, sessionB);
    expect((await scan())[0]).toMatchObject({ kind: 'claude', sessionId: sessionB,
      sessionFile: path.join(transcriptDir, `${sessionB}.jsonl`) });
  });

  it('adopts a bare agent the hook recorded without a kind, by its process name', async () => {
    const [pid] = await startTab(1);
    record(pid, sessionB, { agent: '' });
    expect((await scan())[0]).toMatchObject({ kind: 'claude', sessionId: sessionB,
      sessionFile: path.join(transcriptDir, `${sessionB}.jsonl`) });
  });

  it('passes through a kindless record on a non-agent process to the agent below it', async () => {
    const [wrapper, child] = await startTab(1, 'nested');
    record(wrapper, sessionB, { agent: '' });
    record(child, sessionC);
    expect((await scan())[0].sessionId).toBe(sessionC);
  });

  it('never adopts an unrecorded child or a record for a reused process', async () => {
    const [pid] = await startTab(1);
    expect((await scan())[0].sessionId).toBe(sessionA);
    record(pid, sessionB);
    const file = path.join(getTerminalsDir(), 'by-pid', `${pid}.json`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    entry.processIdentity = { ...entry.processIdentity, startTicks: '0', startTime: 'not this process' };
    fs.writeFileSync(file, JSON.stringify(entry));
    expect((await scan())[0].sessionId).toBe(sessionA);
  });
});
