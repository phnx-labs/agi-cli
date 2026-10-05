
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled, runTmux } from './binary.js';
import { createSession, hasSession, killAll, killSession, reapDeadTmuxPanes } from './session.js';
import {
  DETACHED_HELPER_RULES,
  TMUX_SESSION_ENV,
  descendantsOf,
  isProtectedAgentsService,
  parsePaneOwners,
  parsePanePids,
  parseProcessRows,
  parseTmuxSessionMarker,
  readPaneOwners,
  reapOrphanAgentProcesses,
  selectOrphanProcesses,
  type AgentProcess,
  type PaneOwner,
} from './orphan-reap.js';

const posix = process.platform !== 'win32';
const skipReason = !posix ? 'POSIX-only' : (isTmuxInstalled() ? null : 'tmux not installed');
const tier1SkipReason = !fs.existsSync('/proc/self/environ')
  ? 'tier 1 requires Linux /proc environment reads'
  : skipReason;

const proc = (pid: number, ppid: number, args: string, tmuxSession?: string): AgentProcess =>
  ({ pid, ppid, args, tmuxSession });

const owners = (entries: Array<[string, PaneOwner]>): Map<string, PaneOwner> => new Map(entries);

const noneProtected = { protectedPids: new Set<number>() };

describe('parseProcessRows', () => {
  it('splits pid/ppid and keeps the full argv, spaces included', () => {
    const rows = parseProcessRows([
      '  201357  201227 /home/me/.local/bin/cgraph-mcp --root /home/me/src/agents-cli --daemon',
      '       1       0 /sbin/init',
      'garbage line with no pids',
      '',
    ].join('\n'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pid: 201357, ppid: 201227 });
    expect(rows[0].args).toContain('--root /home/me/src/agents-cli --daemon');
    expect(rows[1]).toMatchObject({ pid: 1, ppid: 0, args: '/sbin/init' });
  });
});

describe('parseTmuxSessionMarker', () => {
  it('reads the marker out of a NUL-separated /proc/<pid>/environ blob', () => {
    const environ = ['PATH=/usr/bin', `${TMUX_SESSION_ENV}=ag-codex-ff55f79f`, 'HOME=/home/me'].join('\0') + '\0';
    expect(parseTmuxSessionMarker(environ)).toBe('ag-codex-ff55f79f');
  });

  it('reads the marker out of the space-separated tail macOS `ps -E` appends', () => {
    const line = `node /opt/agents/dist/index.js PATH=/usr/bin ${TMUX_SESSION_ENV}=ag-claude-8f89aab4 SHELL=/bin/zsh`;
    expect(parseTmuxSessionMarker(line)).toBe('ag-claude-8f89aab4');
  });

  it('does not match a variable that merely ends with the marker name', () => {
    expect(parseTmuxSessionMarker(`MY_${TMUX_SESSION_ENV}=ag-claude-1234abcd`)).toBeUndefined();
  });

  it('is undefined when no marker is present', () => {
    expect(parseTmuxSessionMarker('PATH=/usr/bin\0HOME=/home/me\0')).toBeUndefined();
  });
});

describe('parsePaneOwners', () => {
  it('treats a session as owned while ANY of its panes has a live agent', () => {
    const alive = (pid: number) => pid === 100;
    const map = parsePaneOwners(['ag-claude-aaaa\t100\t0', 'ag-claude-aaaa\t101\t0'].join('\n'), alive);
    expect(map.get('ag-claude-aaaa')).toEqual({ agentAlive: true, attached: false });
  });

  it('marks a session attached when any pane reports a client', () => {
    const map = parsePaneOwners(['ag-claude-bbbb\t200\t1'].join('\n'), () => false);
    expect(map.get('ag-claude-bbbb')).toEqual({ agentAlive: false, attached: true });
  });
});

describe('parsePanePids', () => {
  it('collects every pane_pid regardless of session or attached state', () => {
    const pids = parsePanePids(['ag-claude-aaaa\t100\t0', 'ag-claude-bbbb\t200\t1', 'ag-claude-aaaa\t101\t0'].join('\n'));
    expect([...pids].sort((a, b) => a - b)).toEqual([100, 101, 200]);
  });

  it('is empty for empty input', () => {
    expect(parsePanePids('').size).toBe(0);
  });
});

describe('selectOrphanProcesses', () => {
  it('NEVER treats an absent tmux session as proof that a live marked process is orphaned', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-codex-ff55f79f')];
    const picked = selectOrphanProcesses(table, owners([]), noneProtected);
    expect(picked).toEqual([]);
  });

  it('reaps a helper whose session exists but whose agent pane process has exited', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-claude-dead')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-dead', { agentAlive: false, attached: false }]]), noneProtected);
    expect(picked.map(c => c.reason)).toEqual(['tmux-agent-exited']);
  });

  it('NEVER reaps a helper whose agent is still running', () => {
    const table = [proc(500, 400, 'cgraph-mcp --daemon', 'ag-claude-live')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-live', { agentAlive: true, attached: false }]]), noneProtected);
    expect(picked).toEqual([]);
  });

  it('NEVER reaps a helper of a session that has a client attached, even with a dead pane', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-claude-watched')];
    const picked = selectOrphanProcesses(table, owners([['ag-claude-watched', { agentAlive: false, attached: true }]]), noneProtected);
    expect(picked).toEqual([]);
  });

  it('NEVER reaps the routines daemon or the secrets broker, marker or not', () => {
    const table = [
      proc(600, 1, 'node dist/index.js __daemon-run', 'ag-claude-gone'),
      proc(601, 1, 'node dist/index.js secrets _agent-run', 'ag-claude-gone'),
    ];
    expect(selectOrphanProcesses(table, owners([]), noneProtected)).toEqual([]);
    expect(isProtectedAgentsService('node dist/index.js __daemon-run')).toBe(true);
  });

  it('NEVER reaps the menu-bar helper or the keychain broker (space in the executable name)', () => {
    expect(isProtectedAgentsService(
      '/Users/x/Library/Application Support/agents-cli/MenubarHelper.app/Contents/MacOS/AGI Menu',
    )).toBe(true);
    expect(isProtectedAgentsService(
      '/Users/x/Library/Application Support/agents-cli/Agents CLI.app/Contents/MacOS/Agents CLI',
    )).toBe(true);
    expect(isProtectedAgentsService('/bin/zsh -c echo hello')).toBe(false);
  });

  it('NEVER reaps the reaping process itself or its ancestors', () => {
    const table = [proc(700, 699, 'node dist/index.js sessions reap', 'ag-claude-gone')];
    expect(selectOrphanProcesses(table, owners([]), { protectedPids: new Set([700]) })).toEqual([]);
  });

  it('reaps a detached harness daemon whose declared spawner is dead, and its workers', () => {
    const daemonArgs = '/home/me/.agents/.history/versions/claude/2.1.207/node_modules/@anthropic-ai/claude-code/bin/claude.exe '
      + 'daemon run --origin transient --spawned-by {"label":"claude","cwd":"/home/me/src/agents-cli","pid":3834601}';
    const table = [
      proc(3868250, 1, daemonArgs),
      proc(3868356, 3868250, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/cbb199fb/spare/0d113ea8.pty.sock'),
      proc(3868404, 3868356, 'claude bg-spare --bg-spare /tmp/cc-daemon-1000/cbb199fb/spare/0d113ea8.claim.sock'),
      proc(999, 1, 'unrelated-process'),
    ];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: () => false });
    expect(picked.map(c => c.pid).sort((a, b) => a - b)).toEqual([3868250, 3868356, 3868404]);
    expect(picked.every(c => c.reason === 'detached-helper')).toBe(true);
  });

  it('NEVER reaps a detached harness daemon whose declared spawner is still alive', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const table = [
      proc(3868250, 3834601, daemonArgs),
      proc(3868356, 3868250, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-1000/cbb199fb/spare/x.pty.sock'),
    ];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: pid => pid === 3834601 });
    expect(picked).toEqual([]);
  });

  it('claude rule ignores a non-daemon claude command line', () => {
    const rule = DETACHED_HELPER_RULES.find(r => r.agent === 'claude')!;
    expect(rule.spawnerPid('/home/me/.../.bin/claude --permission-mode plan --session-id 978673a2')).toBeUndefined();
    expect(rule.spawnerPid('claude.exe daemon run --spawned-by {"pid":42}')).toBe(42);
  });

  it('NEVER runs tier 1 when the owners read is unreliable — even a process with no matching session survives', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-codex-ff55f79f')];
    const reliable = selectOrphanProcesses(table, owners([]), { ...noneProtected, ownersReliable: true });
    const unreliable = selectOrphanProcesses(table, owners([]), { ...noneProtected, ownersReliable: false });
    expect(reliable).toEqual([]);
    expect(unreliable).toEqual([]);
  });

  it('an unreliable owners read does not block tier 2 (the detached-helper registry is independent of tmux)', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const table = [proc(3868250, 1, daemonArgs)];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, ownersReliable: false, isAlive: () => false });
    expect(picked.map(c => c.pid)).toEqual([3868250]);
  });

  it('ownersReliable defaults to true and still requires a present, dead owner', () => {
    const table = [proc(500, 1, 'cgraph-mcp --daemon', 'ag-codex-dead')];
    const picked = selectOrphanProcesses(table, owners([['ag-codex-dead', { agentAlive: false, attached: false }]]), noneProtected);
    expect(picked.map(c => c.reason)).toEqual(['tmux-agent-exited']);
  });

  it('NEVER seeds tier 2 from a process whose argv merely QUOTES the daemon-run pattern (as this file\'s own docblock does)', () => {
    const quotedText = 'daemon run --origin transient --spawned-by {"label":"claude","cwd":"/home/me/src/agents-cli","pid":3834601}';
    const table = [
      proc(9001, 1, `/usr/bin/cat orphan-reap.ts ${quotedText}`),
      proc(9002, 1, `/usr/bin/grep -n "${quotedText}" orphan-reap.ts`),
    ];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: () => false });
    expect(picked).toEqual([]);
  });

  it('NEVER seeds tier 2 from a process still owned by a LIVE or attached pane, whatever its argv says', () => {
    const daemonShapedPrompt = 'claude --print "please fix daemon run --spawned-by handling for pid 3834601"';
    const table = [proc(4200, 1, daemonShapedPrompt, 'ag-claude-live')];
    const live = owners([['ag-claude-live', { agentAlive: true, attached: false }]]);
    const picked = selectOrphanProcesses(table, live, { ...noneProtected, isAlive: () => false });
    expect(picked).toEqual([]);
  });

  it('REGRESSION (round 2): a live claude pane leaf with NO env marker still seeds a kill without the pane-pid check', () => {
    const daemonShapedPrompt = 'claude --print "please fix daemon run --spawned-by {\"label\":\"claude\",\"pid\":99999999} handling"';
    const table = [proc(55555, 1, daemonShapedPrompt)];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: pid => pid !== 99999999 });
    expect(picked.map(c => c.pid)).toEqual([55555]);
  });

  it('NEVER seeds tier 2 from a LIVE pane leaf pid, even with no env marker at all (the round-2 fix)', () => {
    const daemonShapedPrompt = 'claude --print "please fix daemon run --spawned-by {\"label\":\"claude\",\"pid\":99999999} handling"';
    const table = [proc(55555, 1, daemonShapedPrompt)];
    const picked = selectOrphanProcesses(table, owners([]), {
      ...noneProtected,
      isAlive: pid => pid !== 99999999,
      livePanePids: new Set([55555]),
    });
    expect(picked).toEqual([]);
  });

  it('livePanePids does not protect an unrelated pid that merely shares no session data', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const table = [proc(3868250, 1, daemonArgs)];
    const picked = selectOrphanProcesses(table, owners([]), {
      ...noneProtected,
      isAlive: () => false,
      livePanePids: new Set([424242]),
    });
    expect(picked.map(c => c.pid)).toEqual([3868250]);
  });

  it('NEVER seeds tier 2 from a LIVE CHILD of a pane leaf, even with no env marker and no pane_pid of its own', () => {
    const daemonShapedPrompt = 'claude --print "please fix daemon run --spawned-by {\"label\":\"claude\",\"pid\":99999999} handling"';
    const paneLeaf = proc(100, 1, 'claude');
    const child = proc(55555, 100, daemonShapedPrompt);
    const picked = selectOrphanProcesses([paneLeaf, child], owners([]), {
      ...noneProtected,
      isAlive: pid => pid !== 99999999,
      livePanePids: new Set([100]),
    });
    expect(picked).toEqual([]);
  });

  it('a process that has genuinely reparented away from a live pane leaf remains reapable', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const reparentedDaemon = proc(3868250, 1, daemonArgs);
    const paneLeaf = proc(100, 1, 'claude');
    const picked = selectOrphanProcesses([paneLeaf, reparentedDaemon], owners([]), {
      ...noneProtected,
      isAlive: pid => pid !== 3834601,
      livePanePids: new Set([100]),
    });
    expect(picked.map(c => c.pid)).toEqual([3868250]);
  });

  it('argv0Basename anchor: a real claude daemon nested deep in a quoting process is still reaped', () => {
    const daemonArgs = 'claude.exe daemon run --origin transient --spawned-by {"label":"claude","pid":3834601}';
    const table = [proc(3868250, 1, daemonArgs)];
    const picked = selectOrphanProcesses(table, owners([]), { ...noneProtected, isAlive: () => false });
    expect(picked.map(c => c.pid)).toEqual([3868250]);
  });
});

describe('descendantsOf', () => {
  it('returns the seeds plus everything reachable through ppid links', () => {
    const table = [proc(10, 1, 'a'), proc(11, 10, 'b'), proc(12, 11, 'c'), proc(20, 1, 'other')];
    expect(descendantsOf(table, [10]).sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  it('terminates on a cyclic ppid chain instead of spinning', () => {
    const table = [proc(30, 31, 'a'), proc(31, 30, 'b')];
    expect(descendantsOf(table, [30]).sort((a, b) => a - b)).toEqual([30, 31]);
  });
});

describe('readPaneOwners', () => {
  it('a socket that was never created is a reliable, confident EMPTY read (tmux unlinks its own socket on exit)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orphan-reap-owners-'));
    try {
      const neverCreated = path.join(tempDir, 'never-existed.sock');
      const read = await readPaneOwners(neverCreated);
      expect(read).toEqual({ ok: true, owners: new Map(), panePids: new Set() });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(skipReason)('a socket file that exists but answers with a real, completed nonzero exit is still a reliable EMPTY read', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orphan-reap-owners-'));
    try {
      const garbage = path.join(tempDir, 'not-a-socket.sock');
      fs.writeFileSync(garbage, 'not a unix socket');
      const read = await readPaneOwners(garbage);
      expect(read.ok).toBe(true);
      expect(read.owners.size).toBe(0);
      expect(read.panePids.size).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!fs.existsSync('/proc/self/environ'))('daemon-start regression (RUSH-2603)', () => {
  it('keeps a real live marked agent alive when its tmux server is absent', async () => {
    const missingSocket = path.join(os.tmpdir(), `agents-rush-2603-${process.pid}`, 'server.sock');
    const child = spawn('sleep', ['120'], {
      env: { ...process.env, [TMUX_SESSION_ENV]: `ag-claude-rush2603-${process.pid}` },
      stdio: 'ignore',
    });
    expect(child.pid).toBeTypeOf('number');
    try {
      const result = await reapOrphanAgentProcesses({
        socket: missingSocket,
        pids: [child.pid!],
        graceMs: 10,
      });
      expect(result.candidates).toEqual([]);
      expect(alive(child.pid!)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
    }
  });
});

describe.skipIf(tier1SkipReason)('reaping a real leaked helper', () => {
  let socket: string;
  let tempDir: string;
  const spawned: number[] = [];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-orphan-reap-'));
    socket = path.join(tempDir, 'test.sock');
  });

  afterEach(async () => {
    await killAll(socket).catch(() => {});
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch {  }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function launchLeakingSession(name: string, agentCmd: string): Promise<number> {
    const pidFile = path.join(tempDir, `${name}.pid`);
    const cmd = `export ${TMUX_SESSION_ENV}=${name}; sh -c 'trap "" HUP; exec sleep 300' & echo $! > ${pidFile}; ${agentCmd}`;
    await createSession({ name, cmd, socket });
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await wait(50);
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    spawned.push(pid);
    return pid;
  }

  it('kills the helper an exited agent left behind, and leaves no dead session', async () => {
    const name = `orph-dead-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 0.3');
    await waitForPaneDead(name, socket, 8000);

    expect(alive(helper)).toBe(true);
    expect(markerOf(helper)).toBe(name);

    const result = await reapDeadTmuxPanes(socket, { pids: [helper] });

    expect(result.processes).toBeGreaterThanOrEqual(1);
    expect(result.processDetails.join('\n')).toContain(String(helper));
    expect(await waitForGone(helper, 6000)).toBe(true);
    expect(await hasSession(name, socket)).toBe(false);
  }, 30_000);

  it('does NOT kill the helper of a session whose agent is still running', async () => {
    const name = `orph-live-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 120');

    const result = await reapDeadTmuxPanes(socket, { pids: [helper] });

    expect(result.processDetails.join('\n')).not.toContain(String(helper));
    expect(alive(helper)).toBe(true);
    expect(await hasSession(name, socket)).toBe(true);
  }, 30_000);

  it('killSession tears the session helpers down with the session', async () => {
    const name = `orph-kill-${process.pid}`;
    const helper = await launchLeakingSession(name, 'exec sleep 120');
    expect(alive(helper)).toBe(true);

    await killSession(name, socket);

    expect(await waitForGone(helper, 6000)).toBe(true);
  }, 30_000);
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function markerOf(pid: number): string | undefined {
  if (!fs.existsSync('/proc/self/environ')) return undefined;
  try {
    return parseTmuxSessionMarker(fs.readFileSync(`/proc/${pid}/environ`, 'utf8'));
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await wait(100);
  }
  return !alive(pid);
}

async function waitForPaneDead(name: string, socket: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await runTmux({ socket, args: ['list-panes', '-t', `=${name}`, '-F', '#{pane_dead}'], throwOnError: false });
    if (res.code === 0 && res.stdout.trim().split('\n')[0] === '1') return;
    await wait(100);
  }
  throw new Error(`pane for ${name} never died within ${timeoutMs}ms`);
}
