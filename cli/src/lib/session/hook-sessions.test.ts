import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { getTerminalsDir, getRuntimeStateDir } from '../state.js';
import { loadHookSessionIndex, resolveHookSessionId, resolveHookSessionRecord, readDoneVerdict, readSessionVerdicts } from './hook-sessions.js';
import { foldDoneVerdict, type ActiveSession } from './active.js';
import { readStateSessionRecord, writePidSessionEntry } from './pid-registry.js';
import { hostProcessView } from './process-view.js';

const P1 = 999_100_001;
const P2 = 999_100_002;
const P3 = 999_100_003;
const SESSIONS_DIR = path.join(getTerminalsDir(), 'sessions');

function writeRecord(pid: number, rec: Record<string, unknown>): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SESSIONS_DIR, `${pid}.json`), JSON.stringify(rec), 'utf8');
}

afterEach(() => {
  for (const pid of [P1, P2, P3]) {
    try { fs.unlinkSync(path.join(SESSIONS_DIR, `${pid}.json`)); } catch {  }
    try { fs.unlinkSync(path.join(getTerminalsDir(), 'by-pid', `${pid}.json`)); } catch {  }
    try { fs.unlinkSync(path.join(getRuntimeStateDir(), 'sessions', `${pid}.json`)); } catch {  }
  }
});

describe('hook session index + resolver', () => {
  it.skipIf(process.platform === 'win32')('joins only a verified live launch to a deployed legacy hook', () => {
    const dir = path.join(getRuntimeStateDir(), 'sessions');
    const pid = process.pid;
    const registryPath = path.join(getTerminalsDir(), 'by-pid', `${pid}.json`);
    const hookPath = path.join(dir, `${pid}.json`);
    fs.mkdirSync(dir, { recursive: true });
    try {
      writePidSessionEntry({ pid, agent: 'codex', launchId: 'legacy-launch', terminalId: 'editor-tab', startedAtMs: Date.now() });
      fs.writeFileSync(hookPath, JSON.stringify({ pid, session_id: 'real-legacy-id', ts: Date.now() / 1000 }));
      let index = loadHookSessionIndex();
      expect(index.byLaunchId.get('legacy-launch')?.session_id).toBe('real-legacy-id');
      expect(index.byTerminalId.get('editor-tab')?.session_id).toBe('real-legacy-id');
      expect(resolveHookSessionId(index, { pid, kind: 'codex', launchId: 'different-launch' })).toBeUndefined();
      const entry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (process.platform === 'darwin') entry.processIdentity.startTime = 'old process incarnation';
      else entry.processIdentity.startTicks = '0';
      fs.writeFileSync(registryPath, JSON.stringify(entry));
      index = loadHookSessionIndex();
      expect(index.byLaunchId.has('legacy-launch')).toBe(false);
      writePidSessionEntry({ pid, agent: 'codex', launchId: 'legacy-launch', startedAtMs: Date.now() });
      fs.writeFileSync(hookPath, JSON.stringify({ pid, session_id: 'stale-legacy-id', ts: 1 }));
      expect(loadHookSessionIndex().byLaunchId.has('legacy-launch')).toBe(false);
    } finally {
      fs.rmSync(registryPath, { force: true });
      fs.rmSync(hookPath, { force: true });
    }
  });

  it('does not resolve an exact new launch to a prior session using the same terminal', () => {
    writeRecord(P1, { session_id: 'old-session', agent: 'codex', pid: P1, terminal_id: 'reused-tab', launch_id: 'old-launch', ts: 10 });
    const index = loadHookSessionIndex();
    expect(resolveHookSessionId(index, { pid: P2, kind: 'codex', terminalId: 'reused-tab', launchId: 'new-launch' })).toBeUndefined();
    expect(resolveHookSessionId(index, { pid: P1, kind: 'codex', launchId: 'new-launch' })).toBeUndefined();
  });
  it('resolves the authoritative id under a direct pid', () => {
    writeRecord(P1, { session_id: 'sess-direct', agent: 'codex', pid: P1, ts: 10 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex' })).toBe('sess-direct');
  });

  it('resolveHookSessionRecord returns the full record incl. ts (the startedAtMs source)', () => {
    writeRecord(P1, { session_id: 'sess-ts', agent: 'claude', pid: P1, ts: 1785544530059 });
    const idx = loadHookSessionIndex();
    const rec = resolveHookSessionRecord(idx, { pid: P1, kind: 'claude' });
    expect(rec?.session_id).toBe('sess-ts');
    expect(rec?.ts).toBe(1785544530059);
    expect(resolveHookSessionRecord(idx, { pid: P1, kind: 'codex' })).toBeUndefined();
  });

  it('joins by launchId even when the hook pid differs from the recorded pid', () => {
    writeRecord(P2, { session_id: 'sess-join', agent: 'codex', pid: P2, launch_id: 'L-xyz', ts: 20 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 999_999_998, kind: 'codex', launchId: 'L-xyz' })).toBe('sess-join');
    expect(resolveHookSessionId(idx, { pid: 999_999_998, kind: 'codex', launchId: 'L-nope' })).toBeUndefined();
  });

  it('joins by terminalId (Factory VS Code tab)', () => {
    writeRecord(P1, { session_id: 'sess-term', agent: 'claude', pid: P1, terminal_id: 'CL-1-1', ts: 5 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 42, kind: 'claude', terminalId: 'CL-1-1' })).toBe('sess-term');
  });

  it('resolves via an immediate child pid (wrapper/shell recorded, agent is a child)', () => {
    writeRecord(P2, { session_id: 'sess-child', agent: 'codex', pid: P2, ts: 7 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex', childPids: [P2] })).toBe('sess-child');
  });

  it('prefers the newest record on a launchId collision (pid reuse)', () => {
    writeRecord(P1, { session_id: 'old', pid: P1, launch_id: 'L-dup', ts: 100 });
    writeRecord(P2, { session_id: 'new', pid: P2, launch_id: 'L-dup', ts: 200 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: 1, kind: 'claude', launchId: 'L-dup' })).toBe('new');
  });

  it('kind-guards a stale reused-pid file: a live codex must NOT inherit a dead claude session', () => {
    writeRecord(P1, { session_id: 'stale-claude', agent: 'claude', pid: P1, ts: 1 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex' })).toBeUndefined();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'claude' })).toBe('stale-claude');
  });

  it('normalizes cursor: ps kind `cursor-agent` matches a hook record agent `cursor`', () => {
    writeRecord(P1, { session_id: 'sess-cursor', agent: 'cursor', pid: P1, ts: 3 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'cursor-agent' })).toBe('sess-cursor');
  });

  it('is permissive when the record omits agent (legacy/unknown)', () => {
    writeRecord(P1, { session_id: 'sess-legacy', pid: P1, ts: 2 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'gemini' })).toBe('sess-legacy');
  });

  it('ignores a record missing session_id', () => {
    writeRecord(P1, { agent: 'codex', pid: P1, launch_id: 'L-empty', ts: 1 });
    const idx = loadHookSessionIndex();
    expect(resolveHookSessionId(idx, { pid: P1, kind: 'codex', launchId: 'L-empty' })).toBeUndefined();
  });
});

const STATE_SESSIONS_DIR = path.join(getRuntimeStateDir(), 'sessions');
const SP = 999_200_001;

function writeStateRecord(pid: number, rec: Record<string, unknown>): void {
  fs.mkdirSync(STATE_SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_SESSIONS_DIR, `${pid}.json`), JSON.stringify(rec), 'utf8');
}

describe('readStateSessionRecord (deployed hook, state/sessions/<pid>.json)', () => {
  afterEach(() => {
    try { fs.unlinkSync(path.join(STATE_SESSIONS_DIR, `${SP}.json`)); } catch {  }
  });

  it('reads the deployed hook record for a specific pid (the real fleet id source)', () => {
    writeStateRecord(SP, { session_id: '33109c18-real', cwd: '/x', pid: SP, ts: 1785640088 });
    expect(readStateSessionRecord(SP)?.session_id).toBe('33109c18-real');
  });

  it('returns undefined when no record exists for the pid (the common miss — no dir scan)', () => {
    expect(readStateSessionRecord(SP)).toBeUndefined();
  });

  it('freshness guard: rejects a record whose ts predates the live process start (reused pid)', () => {
    writeStateRecord(SP, { session_id: 'stale-predecessor', pid: SP, ts: 1000 });
    expect(readStateSessionRecord(SP, 5_000_000)).toBeUndefined();
  });

  it('freshness guard: accepts a record written after the process start (within skew)', () => {
    writeStateRecord(SP, { session_id: 'fresh-current', pid: SP, ts: 1000 });
    expect(readStateSessionRecord(SP, 1_000_000)?.session_id).toBe('fresh-current');
  });

  it('is best-effort without a start time: returns the record when startedAtMs is unknown', () => {
    writeStateRecord(SP, { session_id: 'no-anchor', pid: SP, ts: 1 });
    expect(readStateSessionRecord(SP)?.session_id).toBe('no-anchor');
  });

  it('ignores a record missing session_id', () => {
    writeStateRecord(SP, { cwd: '/x', pid: SP, ts: 1785640088 });
    expect(readStateSessionRecord(SP)).toBeUndefined();
  });
});

it.skipIf(process.platform !== 'linux')('completes a wrapper launch through the deployed hook ancestor record after its child exits', async () => {
  const { spawn } = await import('node:child_process');
  const { captureLaunchBinding, recordCompletedLaunch } = await import('./hook-sessions.js');
  const launchId = randomUUID();
  const sid = randomUUID();
  const previousStateDir = process.env.AGENTS_STATE_DIR;
  process.env.AGENTS_STATE_DIR = path.join(process.env.HOME!, '.agents', '.cache', 'state');
  const hook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK || fileURLToPath(new URL('./testdata/deployed-session-identity.sh', import.meta.url));
  const program = `const {spawnSync}=require('node:child_process');
    process.stdout.write(String(process.pid)+'\\n');
    const r=spawnSync('bash',[process.argv[1]],{input:JSON.stringify({session_id:process.argv[2],cwd:process.cwd()}),encoding:'utf8'});
    process.exit(r.status ?? 1);`;
  const child = spawn('bash', ['-c', 'read -r ready; "$@"; result=$?; exit "$result"', 'wrapper', process.execPath, '-e', program, hook, sid], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_LAUNCH_ID: launchId },
  });
  const pid = child.pid!;
  const registry = path.join(getTerminalsDir(), 'by-pid', `${pid}.json`);
  const completed = path.join(SESSIONS_DIR, `launch-${createHash('sha256').update(launchId).digest('hex')}.json`);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  try {
    writePidSessionEntry({ pid, agent: 'codex', launchId, startedAtMs: Date.now() });
    const binding = captureLaunchBinding(pid, launchId);
    expect(binding).toBeDefined();
    const closed = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    child.stdin.end('go\n');
    expect(await closed).toBe(0);
    const hookPid = Number(output.trim());
    expect(hookPid).not.toBe(pid);
    expect(readStateSessionRecord(hookPid)?.session_id).toBe(sid);
    expect(readStateSessionRecord(pid)).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(registry, 'utf8')).sessionId).toBe(sid);
    recordCompletedLaunch(binding);
    fs.rmSync(registry);
    expect(resolveHookSessionId(loadHookSessionIndex(), { pid, launchId, kind: 'codex' })).toBe(sid);
    expect(loadHookSessionIndex().byPid.has(pid)).toBe(false);
    fs.rmSync(completed);
    fs.writeFileSync(registry, JSON.stringify({ ...binding, launchId: randomUUID(), sessionId: sid }));
    recordCompletedLaunch(binding);
    expect(fs.existsSync(completed)).toBe(false);
    fs.rmSync(path.join(getRuntimeStateDir(), 'sessions', `${hookPid}.json`), { force: true });
  } finally {
    child.kill();
    fs.rmSync(registry, { force: true });
    fs.rmSync(completed, { force: true });
    if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = previousStateDir;
  }
});

it.skipIf(process.platform !== 'linux')('recovers the surviving live hook launch after its registry was removed without rewriting shared state', async () => {
  const { spawn } = await import('node:child_process');
  expect(hostProcessView()).toBeDefined();
  const launchId = randomUUID();
  const sid = randomUUID();
  const previousStateDir = process.env.AGENTS_STATE_DIR;
  process.env.AGENTS_STATE_DIR = path.join(process.env.HOME!, '.agents', '.cache', 'state');
  const hook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK || fileURLToPath(new URL('./testdata/deployed-session-identity.sh', import.meta.url));
  const child = spawn(process.execPath, ['-e', `
    require('node:child_process').spawnSync('bash',[process.argv[1]],{input:JSON.stringify({session_id:process.argv[2]}),encoding:'utf8'});
    process.stdout.write('ready\\n'); process.stdin.resume();`, hook, sid], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_LAUNCH_ID: launchId, UNRELATED_SECRET: 'must-not-escape' },
  });
  const pid = child.pid!;
  const registryDir = path.join(getTerminalsDir(), 'by-pid');
  const hookPath = path.join(getRuntimeStateDir(), 'sessions', `${pid}.json`);
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hook child did not become ready')), 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  try {
    await ready;
    if (fs.existsSync(registryDir)) for (const name of fs.readdirSync(registryDir)) {
      const file = path.join(registryDir, name);
      if (JSON.parse(fs.readFileSync(file, 'utf8')).sessionId === sid) fs.rmSync(file);
    }
    expect(fs.existsSync(path.join(registryDir, `${pid}.json`))).toBe(false);
    const before = fs.existsSync(registryDir) ? fs.readdirSync(registryDir) : [];
    const index = loadHookSessionIndex();
    expect(index.byLaunchId.get(launchId)).toMatchObject({ session_id: sid, pid, launch_id: launchId });
    expect(JSON.stringify(index.byLaunchId.get(launchId))).not.toContain('must-not-escape');
    expect(fs.existsSync(registryDir) ? fs.readdirSync(registryDir) : []).toEqual(before);
    const realHook = fs.readFileSync(hookPath, 'utf8');
    fs.writeFileSync(hookPath, JSON.stringify({ pid, session_id: 'stale', ts: 1 }));
    expect(loadHookSessionIndex().byLaunchId.has(launchId)).toBe(false);
    fs.writeFileSync(hookPath, realHook);
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.stdin.end(); await exited;
    expect(loadHookSessionIndex().byLaunchId.has(launchId)).toBe(false);
  } finally {
    child.kill();
    fs.rmSync(hookPath, { force: true });
    if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = previousStateDir;
  }
});

describe('readDoneVerdict (the Stop hook verdict merged into state/sessions/<pid>.json)', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'state-record-verdict.json'), 'utf8'));
  const SID = fixture.session_id as string;
  const write = (overrides: Record<string, unknown> = {}) => writeStateRecord(SP, { ...fixture, pid: SP, ...overrides });

  afterEach(() => {
    try { fs.unlinkSync(path.join(STATE_SESSIONS_DIR, `${SP}.json`)); } catch {  }
  });

  it('carries state, gaps and an ISO time for the session the record belongs to', () => {
    write();
    expect(readDoneVerdict(SP, SID, 1792384940_000)).toEqual({ state: 'open', gaps: ['open-pr', 'delivery'], at: '2026-10-19T05:02:01.000Z' });
  });

  it('refuses a record for another session, another pid, or an earlier process', () => {
    write();
    expect(readDoneVerdict(SP, 'another-session')).toBeUndefined();
    write({ pid: SP + 1 });
    expect(readDoneVerdict(SP, SID)).toBeUndefined();
    write();
    expect(readDoneVerdict(SP, SID, 1792390000_000)).toBeUndefined();
  });

  it('carries the turn verdict beside it, under the same checks, and refuses an unknown kind', () => {
    write({ turnVerdict: { kind: 'asks', quote: 'Which one ships?', choices: ['A', '', 7, 'B'], at: 1792386121000, sha256: 'x' } });
    expect(readSessionVerdicts(SP, SID, 1792384940_000).turn).toEqual({ kind: 'asks', quote: 'Which one ships?', choices: ['A', 'B'], atMs: 1792386121000 });
    expect(readSessionVerdicts(SP, 'another-session').turn).toBeUndefined();
    write({ turnVerdict: { kind: 'maybe', quote: '', choices: [], at: 1792386121000 } });
    expect(readSessionVerdicts(SP, SID).turn).toBeUndefined();
  });

  it('refuses a verdict written before this process started, or one of an unknown shape', () => {
    write({ ts: 1792390000, verdict: { ...fixture.verdict, at: 1792380000_000 } });
    expect(readDoneVerdict(SP, SID, 1792390000_000)).toBeUndefined();
    write({ verdict: { state: 'maybe', gaps: [], at: 1792386121000 } });
    expect(readDoneVerdict(SP, SID)).toBeUndefined();
    write({ verdict: { state: 'done', gaps: [], at: '2026-10-18' } });
    expect(readDoneVerdict(SP, SID)).toBeUndefined();
  });

  it('foldDoneVerdict sets the verdict on its live row and clears a stale one elsewhere', () => {
    write({ verdict: { state: 'done', gaps: [], at: 1792386121000 } });
    const rows = [
      { context: 'terminal', kind: 'claude', status: 'idle', pid: SP, sessionId: SID, pidAlive: true, processStartedAtMs: 1792384940_000 },
      { context: 'terminal', kind: 'claude', status: 'idle', pid: SP, sessionId: 'other', pidAlive: true, doneVerdict: { state: 'done', gaps: [], at: 'x' } },
    ] as ActiveSession[];
    foldDoneVerdict(rows);
    expect(rows[0]!.doneVerdict).toEqual({ state: 'done', gaps: [], at: '2026-10-19T05:02:01.000Z' });
    expect(rows[1]!.doneVerdict).toBeUndefined();
  });
});

it.skipIf(process.platform !== 'linux')('a headless run the tab agent starts never takes over the tab agent\'s session', async () => {
  const { spawn } = await import('node:child_process');
  const { readLivePidSessionEntry, liveSessionProcesses } = await import('./pid-registry.js');
  const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'testdata', 'nested-headless-claim.json'), 'utf8'));
  const { tab, nested } = fixture;
  const previousStateDir = process.env.AGENTS_STATE_DIR;
  process.env.AGENTS_STATE_DIR = path.join(process.env.HOME!, '.agents', '.cache', 'state');
  const hook = process.env.AGENTS_SESSION_IDENTITY_TEST_HOOK || fileURLToPath(new URL('./testdata/deployed-session-identity.sh', import.meta.url));
  const program = `const {spawnSync}=require('node:child_process');
    const [hook, own, ownCwd, child, childCwd] = process.argv.slice(1);
    const run = (sid, cwd) => spawnSync('bash', [hook], { input: JSON.stringify({ session_id: sid, cwd }), encoding: 'utf8' });
    const go = () => { run(own, ownCwd);
      spawnSync(process.execPath, ['-e', 'require("node:child_process").spawnSync("bash",[process.argv[1]],{input:process.argv[2],encoding:"utf8"})',
        hook, JSON.stringify({ session_id: child, cwd: childCwd })], { encoding: 'utf8' });
      process.stdout.write('ready\\n'); process.stdin.resume(); };
    process.stdin.once('data', go);`;
  const agent = spawn(process.execPath, ['-e', program, hook, tab.sessionId, tab.cwd, nested.sessionId, nested.cwd], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_TERMINAL_ID: tab.terminalId, AGENT_LAUNCH_ID: tab.launchId, AGENTS_RUNTIME: 'terminal' },
  });
  const pid = agent.pid!;
  const registryDir = path.join(getTerminalsDir(), 'by-pid');
  const before = new Set(fs.existsSync(registryDir) ? fs.readdirSync(registryDir) : []);
  try {
    writePidSessionEntry({ pid, agent: 'claude', sessionId: tab.sessionId, cwd: tab.cwd, launchId: tab.launchId, terminalId: tab.terminalId, startedAtMs: Date.now() });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('tab agent did not become ready')), 10_000);
      agent.once('error', error => { clearTimeout(timer); reject(error); });
      agent.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    agent.stdin.write('go\n');
    await ready;
    expect(readStateSessionRecord(pid)?.session_id).toBe(tab.sessionId);
    expect(readLivePidSessionEntry(pid)?.sessionId).toBe(tab.sessionId);
    const index = loadHookSessionIndex();
    expect(index.byTerminalId.get(tab.terminalId)?.session_id).toBe(tab.sessionId);
    expect(index.byLaunchId.get(tab.launchId)?.session_id).toBe(tab.sessionId);
    expect(liveSessionProcesses(nested.sessionId).map(e => e.pid)).not.toContain(pid);
  } finally {
    agent.kill();
    if (fs.existsSync(registryDir)) for (const name of fs.readdirSync(registryDir)) if (!before.has(name)) fs.rmSync(path.join(registryDir, name), { force: true });
    fs.rmSync(path.join(getRuntimeStateDir(), 'sessions', `${pid}.json`), { force: true });
    if (previousStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
    else process.env.AGENTS_STATE_DIR = previousStateDir;
  }
});
