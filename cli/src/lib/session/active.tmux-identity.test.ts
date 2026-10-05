import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  agentKindFromName,
  shortIdFromName,
  resolveNamesToSessionIds,
  resolvePaneIdentity,
  listTmuxAgentSessions,
} from './active.js';
import type { HookSessionIndex } from './hook-sessions.js';
import { writePidSessionEntry, prunePidSessionRegistry } from './pid-registry.js';
import { isTmuxInstalled, runTmux } from '../tmux/binary.js';
import { createSession, killSession } from '../tmux/session.js';
import * as tmuxPaths from '../tmux/paths.js';

// These are pure functions — the DB dependency is injected — so no fixtures or
// tmux are needed. The name-based tier is the recovery that makes a detached
// agent findable when its durable identity records are gone.

describe('agentKindFromName / shortIdFromName (parse ag-<agent>-<shortid>)', () => {
  it('splits a plain agent name', () => {
    expect(agentKindFromName('ag-claude-2373284d')).toBe('claude');
    expect(shortIdFromName('ag-claude-2373284d')).toBe('2373284d');
  });

  it('handles a hyphenated agent kind, anchoring on the 8-hex suffix', () => {
    expect(agentKindFromName('ag-cursor-agent-abcd1234')).toBe('cursor-agent');
    expect(shortIdFromName('ag-cursor-agent-abcd1234')).toBe('abcd1234');
  });

  it('recognizes agents NOT in the ps-scan comm map (grok/kimi) — harness parity', () => {
    expect(agentKindFromName('ag-grok-af7d9ff4')).toBe('grok');
    expect(agentKindFromName('ag-kimi-1deeba96')).toBe('kimi');
  });

  it('rejects non-ag names and malformed suffixes', () => {
    expect(agentKindFromName('main')).toBeUndefined();
    expect(agentKindFromName('bash')).toBeUndefined();
    expect(shortIdFromName('ag-claude-nothex!!')).toBeUndefined();
    // suffix must be exactly 8 hex chars
    expect(agentKindFromName('ag-claude-2373284')).toBeUndefined();
    expect(agentKindFromName('ag-claude-2373284da')).toBeUndefined();
  });
});

describe('resolveNamesToSessionIds (batched short-id -> full UUID)', () => {
  it('maps each ag-* name to its full UUID via the injected resolver', () => {
    const find = (shortIds: string[]) => {
      expect(shortIds).toContain('abcd1234');
      return new Map([['abcd1234', { id: 'abcd1234-0000-0000-0000-000000000001' }]]);
    };
    const out = resolveNamesToSessionIds(
      ['ag-claude-abcd1234', 'main', 'ag-codex-ffffffff'],
      { findSessionsByShortIds: find },
    );
    expect(out.get('ag-claude-abcd1234')).toBe('abcd1234-0000-0000-0000-000000000001');
    expect(out.get('main')).toBeUndefined();
    expect(out.get('ag-codex-ffffffff')).toBeUndefined(); // not returned by the DB
  });

  it('makes exactly ONE batched call regardless of pane count (not per-pane)', () => {
    let calls = 0;
    const find = (_ids: string[]) => { calls++; return new Map<string, { id: string }>(); };
    resolveNamesToSessionIds(
      ['ag-claude-aaaaaaaa', 'ag-codex-bbbbbbbb', 'ag-codex-bbbbbbbb', 'notanagentpane'],
      { findSessionsByShortIds: find },
    );
    expect(calls).toBe(1);
  });

  it('short-circuits with no DB call when no ag-* names are present', () => {
    let calls = 0;
    const find = (_ids: string[]) => { calls++; return new Map<string, { id: string }>(); };
    const out = resolveNamesToSessionIds(['main', 'bash', 'vim'], { findSessionsByShortIds: find });
    expect(calls).toBe(0);
    expect(out.size).toBe(0);
  });
});

describe('resolvePaneIdentity — name-based recovery (the fleet fix)', () => {
  const emptyHook = (): HookSessionIndex => ({ byLaunchId: new Map(), byTerminalId: new Map(), byPid: new Map() });
  const names = new Map([['ag-claude-abcd1234', 'abcd1234-0000-0000-0000-000000000001']]);

  it('recovers a full session id from the pane name when meta AND registry are absent', () => {
    const id = resolvePaneIdentity('%5', 'ag-claude-abcd1234', null, undefined, emptyHook, names);
    expect(id).toEqual({ agent: 'claude', sessionId: 'abcd1234-0000-0000-0000-000000000001' });
  });

  it('surfaces the agent kind even when the short id is not in the DB (id-less but visible)', () => {
    const id = resolvePaneIdentity('%6', 'ag-codex-ffffffff', null, undefined, emptyHook, new Map());
    expect(id).toEqual({ agent: 'codex', sessionId: undefined });
  });

  it('a live registry entry with no id falls back to the name id', () => {
    const id = resolvePaneIdentity(
      '%7', 'ag-claude-abcd1234', null,
      { pid: 9, agent: 'claude', startedAtMs: 1 },
      emptyHook, names,
    );
    expect(id?.sessionId).toBe('abcd1234-0000-0000-0000-000000000001');
  });

  it('still drops a genuinely foreign pane (no name, no meta, no registry)', () => {
    expect(resolvePaneIdentity('%8', 'main', null, undefined, emptyHook, names)).toBeUndefined();
  });
});

/** RUSH-2192: pins that listTmuxAgentSessions forwards terminalId; removing `terminalId:
 * liveEntry?.terminalId` from the tmux ActiveSession push must fail this test. Real tmux, real
 * by-pid entry, socket redirected. */
const tmuxSkip = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(tmuxSkip)('listTmuxAgentSessions forwards terminalId (RUSH-2192)', () => {
  const SHORT = 'af7d9ff4';
  const SESS = `ag-grok-${SHORT}`;
  const TERMINAL_ID = 'GK-mid2-test-rush2192';
  const SESSION_ID = '019fd1e3-8859-7f03-a47c-49d64653b404';
  // High fake pid range reserved for tests — but isPidAlive needs a LIVE pid, so
  // we bind the registry entry to the pane's real sleep pid after create.
  let tempDir: string;
  let socket: string;
  let paneId: string;
  let panePid: number;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-termid-'));
    socket = path.join(tempDir, 'server.sock');
    await runTmux({
      socket,
      args: ['new-session', '-d', '-s', SESS, 'sleep', '120'],
    });
    const listed = await runTmux({
      socket,
      args: ['list-panes', '-a', '-F', '#{pane_id}:#{pane_pid}:#{session_name}'],
    });
    const line = listed.stdout.split('\n').filter(Boolean)[0];
    const [pane, pidRaw, name] = line.split(':');
    expect(name).toBe(SESS);
    paneId = pane;
    panePid = parseInt(pidRaw, 10);
    expect(paneId).toMatch(/^%/);
    expect(panePid).toBeGreaterThan(0);

    // Point listTmuxAgentSessions at our throwaway server (not the fleet socket).
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);

    writePidSessionEntry({
      pid: panePid,
      agent: 'grok',
      sessionId: SESSION_ID,
      startedAtMs: Date.now() - 60_000,
      terminalId: TERMINAL_ID,
      launchId: 'LID-mid2-test-rush2192',
      tmuxPane: paneId,
      cwd: tempDir,
    });
  });

  afterEach(async () => {
    socketSpy?.mockRestore();
    prunePidSessionRegistry((pid) => pid !== panePid);
    await runTmux({ socket, args: ['kill-server'], throwOnError: false });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('surfaces terminalId on the tmux ActiveSession row from the by-pid entry', async () => {
    const rows = await listTmuxAgentSessions();
    const mine = rows.find((r) => r.sessionId === SESSION_ID || r.kind === 'grok');
    expect(mine, `expected a grok row; got ${JSON.stringify(rows.map((r) => ({ kind: r.kind, sessionId: r.sessionId, terminalId: r.terminalId })))}`).toBeDefined();
    // This is the Factory join key. Dropping `terminalId: liveEntry?.terminalId`
    // from listTmuxAgentSessions makes this assertion fail.
    expect(mine!.terminalId).toBe(TERMINAL_ID);
    expect(mine!.kind).toBe('grok');
    expect(mine!.host).toBe('tmux');
  });
});

describe.skipIf(tmuxSkip)('listTmuxAgentSessions retained dead panes', () => {
  const SESSION_ID = '019fd3da-a1a7-7610-821c-336bd47eeed9';
  const SESS = 'ag-codex-c1f3d813';
  let tempDir: string;
  let socket: string;
  let socketSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-dead-pane-'));
    socket = path.join(tempDir, 'server.sock');
    socketSpy = vi.spyOn(tmuxPaths, 'getDefaultSocketPath').mockReturnValue(socket);
  });

  afterEach(async () => {
    socketSpy?.mockRestore();
    await killSession(SESS, socket).catch(() => {});
    await runTmux({ socket, args: ['kill-server'], throwOnError: false });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a remain-on-exit pane as closed rather than attachable/live', async () => {
    const meta = await createSession({
      name: SESS,
      cmd: 'sh -c "exit 0"',
      socket,
      labels: { agent: 'codex', sessionId: SESSION_ID },
    });
    expect(meta.pane).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 250));
    const rows = await listTmuxAgentSessions();
    const row = rows.find(candidate => candidate.sessionId === SESSION_ID);
    expect(row).toBeDefined();
    expect(row!.status).toBe('closed');
  });
});
