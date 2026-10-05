
import { spawnSync } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled, runTmux } from './binary.js';
import {
  assertValidSessionName,
  capturePane,
  createSession,
  ensureSessionHookRepaired,
  hasSession,
  killAll,
  killSession,
  listClients,
  listSessions,
  paneExitStatus,
  prepareSessionForResume,
  reapDeadTmuxPanes,
  reconcileSessionHooks,
  sendKeys,
  setSessionHook,
  slugifyName,
  teardownIfAgentExited,
  splitPane,
  AGENT_HOOK_SCHEMA,
  agentPaneDiedHook,
  AGENTS_TMUX_HISTORY_LIMIT,
  AGENTS_TMUX_CONFIG_SCHEMA,
  buildCreateSessionArgs,
  TmuxSessionError,
  userConfigSourceLine,
} from './session.js';

const skipReason = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(skipReason)('tmux session lifecycle', () => {
  let socket: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-test-'));
    socket = path.join(tempDir, 'srv.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch {  }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {  }
  });

  it('assertValidSessionName rejects names with dots or colons', () => {
    expect(() => assertValidSessionName('good-name_1')).not.toThrow();
    expect(() => assertValidSessionName('bad.name')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('bad:name')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('')).toThrow(TmuxSessionError);
    expect(() => assertValidSessionName('a'.repeat(65))).toThrow(TmuxSessionError);
  });

  it('slugifyName normalizes whitespace and special chars', () => {
    expect(slugifyName('hello world')).toBe('hello-world');
    expect(slugifyName('agent:claude.task')).toBe('agent-claude-task');
    expect(slugifyName('---trim---')).toBe('trim');
  });

  it('builds session creation with agents-cli server ergonomics before new-session', () => {
    const args = buildCreateSessionArgs({ name: 'ergonomic', cmd: 'sleep 30' }, '/agents/tmux-defaults.conf');
    expect(args).toEqual([
      '-f', '/agents/tmux-defaults.conf',
      'set-option', '-g', 'remain-on-exit', 'on', ';',
      'new-session', '-d', '-s', 'ergonomic', '-P', '-F', '#{pane_id}',
      '--', 'sh', '-c', 'sleep 30',
    ]);
  });

  it('keeps explicit user tmux options and mouse-copy bindings', async () => {
    const userHome = path.join(tempDir, 'home');
    fs.mkdirSync(userHome);
    fs.writeFileSync(path.join(userHome, '.tmux.conf'), [
      'set-option -g mouse off',
      'set-option -s set-clipboard external',
      'set-option -g history-limit 50000',
      'bind-key -T copy-mode MouseDragEnd1Pane send-keys -X cancel',
      'bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X cancel',
    ].join('\n'));

    await createSession({
      name: 'user-config',
      cmd: 'sleep 30',
      socket,
      env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: path.join(userHome, '.config') },
    });

    expect((await runTmux({ socket, args: ['show-options', '-gv', 'mouse'] })).stdout.trim()).toBe('off');
    expect((await runTmux({ socket, args: ['show-options', '-sv', 'set-clipboard'] })).stdout.trim()).toBe('external');
    expect((await runTmux({ socket, args: ['show-options', '-gv', 'history-limit'] })).stdout.trim()).toBe('50000');
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      const binding = (await runTmux({ socket, args: ['list-keys', '-T', table, 'MouseDragEnd1Pane'] })).stdout;
      expect(binding).toContain('cancel');
      expect(binding).not.toContain('copy-selection-no-clear');
    }
  });

  it('sources user config without quiet suppression and quotes special path bytes once', () => {
    expect(userConfigSourceLine('/tmp/user $cfg "one".conf')).toBe(
      'source-file "/tmp/user \\$cfg \\"one\\".conf"',
    );
    expect(userConfigSourceLine('/tmp/user.conf')).not.toContain('source-file -q');
  });

  it('stamps the agent identity only when the session id is genuine, so a format never shows a fabricated handle', async () => {
    const unconfiguredHome = path.join(tempDir, 'identity-home');
    fs.mkdirSync(unconfiguredHome);
    const env = {
      ...process.env,
      HOME: unconfiguredHome,
      XDG_CONFIG_HOME: path.join(unconfiguredHome, '.config'),
    };

    await createSession({
      name: 'ag-claude-real',
      cmd: 'sleep 30',
      socket,
      env,
      labels: { agent: 'claude', sessionId: 'c8c4a2c8-1111-2222-3333-444455556666' },
    });

    await createSession({
      name: 'ag-codex-fake',
      cmd: 'sleep 30',
      socket,
      env,
      labels: { agent: 'codex' },
    });

    const opt = async (session: string, option: string) =>
      (await runTmux({ socket, args: ['show-options', '-t', session, '-qv', option] })).stdout.trim();

    expect(await opt('ag-claude-real', '@ag_session_id')).toBe('c8c4a2c8-1111-2222-3333-444455556666');
    expect(await opt('ag-claude-real', '@ag_agent')).toBe('claude');

    expect(await opt('ag-codex-fake', '@ag_session_id')).toBe('');
    expect(await opt('ag-codex-fake', '@ag_agent')).toBe('codex');

    const rendered = async (session: string) =>
      (await runTmux({
        socket,
        args: ['display-message', '-t', session, '-p', '#{?#{@ag_session_id},#{@ag_session_id},no-id}'],
      })).stdout.trim();
    expect(await rendered('ag-claude-real')).toBe('c8c4a2c8-1111-2222-3333-444455556666');
    expect(await rendered('ag-codex-fake')).toBe('no-id');
  });

  it('configures mouse, OSC 52 clipboard, scrollback, and non-clearing mouse copy on its socket', async () => {
    const unconfiguredHome = path.join(tempDir, 'unconfigured-home');
    fs.mkdirSync(unconfiguredHome);
    await createSession({
      name: 'ergonomic',
      cmd: 'sleep 30',
      socket,
      env: {
        ...process.env,
        HOME: unconfiguredHome,
        XDG_CONFIG_HOME: path.join(unconfiguredHome, '.config'),
      },
    });

    expect((await runTmux({ socket, args: ['show-options', '-gv', 'mouse'] })).stdout.trim()).toBe('on');
    expect((await runTmux({ socket, args: ['show-options', '-sv', 'set-clipboard'] })).stdout.trim()).toBe('on');
    expect((await runTmux({ socket, args: ['show-options', '-gv', 'history-limit'] })).stdout.trim())
      .toBe(String(AGENTS_TMUX_HISTORY_LIMIT));

    for (const table of ['copy-mode', 'copy-mode-vi']) {
      const binding = (await runTmux({ socket, args: ['list-keys', '-T', table, 'MouseDragEnd1Pane'] })).stdout;
      expect(binding).toContain('copy-selection-no-clear');
    }
  });

  it('creates a detached session and reports it via hasSession + listSessions', async () => {
    const meta = await createSession({
      name: 'lifecycle',
      cmd: 'sleep 30',
      socket,
      source: 'cli',
    });
    expect(meta.name).toBe('lifecycle');
    expect(meta.socket).toBe(socket);

    expect(await hasSession('lifecycle', socket)).toBe(true);

    const list = await listSessions({ socket });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('lifecycle');
    expect(list[0].windows).toBe(1);
    expect(list[0].meta?.cmd).toBe('sleep 30');
  });

  it('persists the redacted metaCmd to disk while executing the real cmd (RUSH-1758)', async () => {
    const secret = 'SECRET_VALUE_XYZ789';
    const outFile = path.join(tempDir, 'ran.txt');
    const meta = await createSession({
      name: 'redact',
      cmd: `sh -c 'printf ${secret} > ${outFile}; sleep 30'`,
      metaCmd: 'exec env TOKEN=<redacted> claude',
      socket,
    });
    expect(meta.cmd).toBe('exec env TOKEN=<redacted> claude');
    expect(JSON.stringify(meta)).not.toContain(secret);

    const list = await listSessions({ socket });
    expect(list[0].meta?.cmd).toBe('exec env TOKEN=<redacted> claude');
    expect(JSON.stringify(list[0].meta)).not.toContain(secret);

    await wait(400);
    expect(fs.readFileSync(outFile, 'utf8')).toContain(secret);
  });

  it('captures live output from a running pane', async () => {
    await createSession({
      name: 'capture-test',
      cmd: 'echo MARKER_ABC123 && sleep 30',
      socket,
    });
    await wait(300);
    const screen = await capturePane({ name: 'capture-test', socket });
    expect(screen).toContain('MARKER_ABC123');
  });

  it('sendKeys delivers typed text to the active pane', async () => {
    await createSession({
      name: 'send-test',
      cmd: '/bin/sh',
      socket,
    });
    await wait(200);
    await sendKeys({ name: 'send-test', keys: 'echo TYPED_FROM_TEST', socket });
    await wait(300);
    const screen = await capturePane({ name: 'send-test', socket });
    expect(screen).toContain('TYPED_FROM_TEST');
  });

  it('shell metacharacters in --cmd survive without shell escaping bugs', async () => {
    await createSession({
      name: 'escape-test',
      cmd: `echo 'with single' && echo "with;pipe|chars" && sleep 30`,
      socket,
    });
    await wait(400);
    const screen = await capturePane({ name: 'escape-test', socket });
    expect(screen).toContain('with single');
    expect(screen).toContain('with;pipe|chars');
  });

  it('rejects duplicate session name without --replace', async () => {
    await createSession({ name: 'dup', cmd: 'sleep 30', socket });
    await expect(createSession({ name: 'dup', cmd: 'sleep 30', socket })).rejects.toThrow(/already exists/);
  });

  it('--replace kills the old session and creates a fresh one', async () => {
    const first = await createSession({ name: 'rep', cmd: 'echo FIRST && sleep 30', socket });
    const firstCreatedAt = first.createdAt;
    await wait(50);
    const second = await createSession({
      name: 'rep',
      cmd: 'echo SECOND && sleep 30',
      socket,
      replace: true,
    });
    expect(second.createdAt).toBeGreaterThan(firstCreatedAt);
    expect(second.cmd).toContain('SECOND');
    await wait(300);
    const screen = await capturePane({ name: 'rep', socket });
    expect(screen).toContain('SECOND');
    expect(screen).not.toContain('FIRST');
  });

  it('--attach-existing returns the existing session without recreating', async () => {
    const first = await createSession({ name: 'reuse', cmd: 'sleep 30', socket });
    const reused = await createSession({
      name: 'reuse',
      cmd: 'this should not run',
      socket,
      attachExisting: true,
    });
    expect(reused.createdAt).toBe(first.createdAt);
  });

  it('native resume reaps a metadata-less retained dead pane instead of attaching it', async () => {
    await runTmux({
      socket,
      args: [
        'set-option', '-g', 'remain-on-exit', 'on', ';',
        'new-session', '-d', '-s', 'legacy-dead-resume', '--', 'sh', '-c', 'exit 0',
      ],
    });

    let pane = '';
    let dead = '';
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await runTmux({
        socket,
        args: ['list-panes', '-t', 'legacy-dead-resume', '-F', '#{pane_id} #{pane_dead}'],
        throwOnError: false,
      });
      [pane = '', dead = ''] = result.stdout.trim().split(/\s+/);
      if (/^%\d+$/.test(pane) && dead === '1') break;
      await wait(50);
    }
    expect(pane).toMatch(/^%\d+$/);
    expect(dead).toBe('1');

    expect((await prepareSessionForResume('legacy-dead-resume', socket)).decision).toBe('create');
    expect(await hasSession('legacy-dead-resume', socket)).toBe(false);
  });

  it('native resume reuses a positively living existing pane', async () => {
    await createSession({ name: 'living-resume', cmd: 'sleep 30', socket });

    expect((await prepareSessionForResume('living-resume', socket)).decision).toBe('attach');
    expect(await hasSession('living-resume', socket)).toBe(true);
  });

  it('killSession is idempotent on missing sessions', async () => {
    expect(await killSession('never-existed', socket)).toBe(false);
    await createSession({ name: 'will-die', cmd: 'sleep 30', socket });
    expect(await killSession('will-die', socket)).toBe(true);
    expect(await killSession('will-die', socket)).toBe(false);
  });

  it('splitPane returns the new pane id and produces a 2-pane window', async () => {
    await createSession({ name: 'splittest', cmd: '/bin/sh', socket });
    await wait(150);
    const paneId = await splitPane({
      name: 'splittest',
      direction: 'v',
      cmd: 'echo SECOND_PANE_MARKER && sleep 30',
      socket,
    });
    expect(paneId).toMatch(/^%\d+$/);
    await wait(300);
    const screen = await capturePane({ name: `splittest`, pane: paneId, socket });
    expect(screen).toContain('SECOND_PANE_MARKER');
  });

  it('listSessions returns empty + cleans orphan meta files when server is gone', async () => {
    await createSession({ name: 'cleanme', cmd: 'sleep 30', socket });
    await killAll(socket);
    const sessions = await listSessions({ socket });
    expect(sessions).toEqual([]);
  });

  it('rejects a cwd that does not exist', async () => {
    await expect(createSession({
      name: 'bad-cwd',
      cmd: 'true',
      cwd: '/this/path/should/never/exist/anywhere',
      socket,
    })).rejects.toThrow(/cwd does not exist/);
  });

  it('createSession captures the first pane id and records it on the meta', async () => {
    const meta = await createSession({ name: 'paneid', cmd: 'sleep 30', socket });
    expect(meta.pane).toMatch(/^%\d+$/);
    const screen = await capturePane({ name: 'paneid', pane: meta.pane, socket });
    expect(typeof screen).toBe('string');
  });

  it('listClients returns [] for a detached session (no terminal attached)', async () => {
    await createSession({ name: 'noclients', cmd: 'sleep 30', socket });
    expect(await listClients(socket)).toEqual([]);
  });

  it('paneExitStatus reports the dead pane exit code once the process finishes', async () => {
    const meta = await createSession({ name: 'exitcode', cmd: 'sh -c "exit 3"', socket });
    expect(meta.pane).toBeTruthy();
    await wait(400);
    const exit = await waitForExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(true);
    expect(exit.status).toBe(3);
  });

  it('paneExitStatus reports a live pane as not dead', async () => {
    const meta = await createSession({ name: 'stillalive', cmd: 'sleep 30', socket });
    const exit = await paneExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(false);
  });

  it('a fast-failing agent leaves its error readable in the dead pane (runInTmux failure recap)', async () => {
    const meta = await createSession({
      name: 'fastfail',
      cmd: `sh -c 'echo "spawn .../codex ENOENT" >&2; exit 1'`,
      socket,
    });
    expect(meta.pane).toBeTruthy();
    await wait(400);
    const exit = await waitForExitStatus(meta.pane!, socket);
    expect(exit.dead).toBe(true);
    expect(exit.status).toBe(1);
    const screen = await waitForCapture({ name: 'fastfail', pane: meta.pane!, socket, lines: 200 }, 'ENOENT');
    expect(screen).toContain('ENOENT');
  });

  it('remain-on-exit keeps the pane around after the launched command finishes', async () => {
    await createSession({ name: 'short', cmd: 'echo BRIEF && true', socket });
    await wait(400);
    expect(await hasSession('short', socket)).toBe(true);
    const screen = await capturePane({ name: 'short', socket, lines: 10 });
    expect(screen).toContain('BRIEF');
  });

  it('teardownIfAgentExited kills a remain-on-exit husk and keeps a live pane (PHNX-3293)', async () => {
    await createSession({ name: 'husk-teardown', cmd: 'echo HUSK && true', socket });
    await wait(400);
    expect(await hasSession('husk-teardown', socket)).toBe(true);
    expect(await teardownIfAgentExited('husk-teardown', socket)).toBe('killed');
    expect(await hasSession('husk-teardown', socket)).toBe(false);

    await createSession({ name: 'live-keep', cmd: 'sleep 30', socket });
    expect(await hasSession('live-keep', socket)).toBe(true);
    expect(await teardownIfAgentExited('live-keep', socket)).toBe('kept');
    expect(await hasSession('live-keep', socket)).toBe(true);
  });

  it('setSessionHook reports whether tmux accepted the hook', async () => {
    await createSession({ name: 'hook-result', cmd: 'sleep 30', socket });
    expect(await setSessionHook('hook-result', 'pane-died', 'display-message accepted', socket)).toBe(true);
    expect(await setSessionHook('missing-session', 'pane-died', 'display-message rejected', socket)).toBe(false);
  });

  it('pane-guarded pane-died hook: exiting a user split closes only that split, agent pane survives', async () => {
    const meta = await createSession({ name: 'guardsplit', cmd: 'sleep 30', socket });
    const agentPane = meta.pane!;
    expect(agentPane).toMatch(/^%\d+$/);
    await setSessionHook(
      'guardsplit',
      'pane-died',
      agentPaneDiedHook('guardsplit', agentPane),
      socket,
    );
    const splitPaneId = await splitPane({ name: 'guardsplit', direction: 'v', cmd: '/bin/sh', socket });
    await wait(200);
    let panes = (await runTmux({ socket, args: ['list-panes', '-t', 'guardsplit', '-F', '#{pane_id}'] })).stdout.trim().split('\n');
    expect(panes).toHaveLength(2);
    await runTmux({ socket, args: ['send-keys', '-t', splitPaneId, 'exit', 'Enter'] });

    panes = await waitForPanes('guardsplit', socket, 1);
    expect(await hasSession('guardsplit', socket)).toBe(true);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toBe(`${agentPane}:0`);
  });

  it('#5a: agent pane dies with NO client attached → the whole session is torn down (no lingering husk)', async () => {
    const meta = await createSession({ name: 'ag-shutdown', cmd: 'sh -c "sleep 300"', socket });
    const agentPane = meta.pane!;
    expect(agentPane).toMatch(/^%\d+$/);
    await setSessionHook(
      'ag-shutdown',
      'pane-died',
      agentPaneDiedHook('ag-shutdown', agentPane),
      socket,
    );
    const panePid = await waitForPanePid(agentPane, socket);
    expect(panePid).toBeGreaterThan(0);
    process.kill(panePid, 'SIGKILL');
    const gone = await waitForSessionGone('ag-shutdown', socket);
    expect(gone).toBe(true);
    expect(await hasSession('ag-shutdown', socket)).toBe(false);
  });

  it('reconcileSessionHooks retrofits the guarded hook onto a session left with the OLD unconditional one', async () => {
    const meta = await createSession({ name: 'ag-reco-old', cmd: 'sleep 30', socket });
    const agentPane = meta.pane!;
    await setSessionHook('ag-reco-old', 'pane-died', 'detach-client -s =ag-reco-old', socket);

    const res = await reconcileSessionHooks(socket);
    expect(res.reconciled).toBeGreaterThanOrEqual(1);
    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-reco-old', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));

    const splitPaneId = await splitPane({ name: 'ag-reco-old', direction: 'v', cmd: '/bin/sh', socket });
    await wait(200);
    await runTmux({ socket, args: ['send-keys', '-t', splitPaneId, 'exit', 'Enter'] });
    expect(await hasSession('ag-reco-old', socket)).toBe(true);
    const panes = await waitForPanes('ag-reco-old', socket, 1);
    expect(panes).toHaveLength(1);
    expect(panes[0]).toBe(`${agentPane}:0`);
  });

  it('reconcileSessionHooks is idempotent and leaves non-run sessions alone', async () => {
    await createSession({ name: 'ag-reco-idem', cmd: 'sleep 30', socket });
    await createSession({ name: 'user-made', cmd: 'sleep 30', socket });

    const first = await reconcileSessionHooks(socket);
    expect(first.reconciled).toBeGreaterThanOrEqual(1);
    const second = await reconcileSessionHooks(socket);
    expect(second.reconciled).toBe(0);
    const r = await runTmux({ socket, args: ['show-options', '-v', '-t', 'user-made', '@ag_hook_schema'], throwOnError: false });
    expect(r.stdout.trim()).toBe('');
  });

  it('ensureSessionHookRepaired retrofits a stale hook on the ONE session named', async () => {
    await createSession({ name: 'ag-repair-one', cmd: 'sleep 30', socket });
    await setSessionHook('ag-repair-one', 'pane-died', 'detach-client -s =ag-repair-one', socket);
    const before = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-repair-one', '@ag_hook_schema'], throwOnError: false })).stdout.trim();
    expect(before).toBe('');

    await ensureSessionHookRepaired('ag-repair-one', socket);

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-repair-one', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));
  });

  it('ensureSessionHookRepaired is a no-op for a non-run (non `ag-`) session', async () => {
    await createSession({ name: 'user-made-2', cmd: 'sleep 30', socket });
    await setSessionHook('user-made-2', 'pane-died', 'detach-client -s =user-made-2', socket);

    await ensureSessionHookRepaired('user-made-2', socket);

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'user-made-2', '@ag_hook_schema'], throwOnError: false })).stdout.trim();
    expect(marker).toBe('');
  });

  it('prepareSessionForResume repairs a stale hook on the session it decides to attach', async () => {
    await createSession({ name: 'ag-resume-repair', cmd: 'sleep 30', socket });
    await setSessionHook('ag-resume-repair', 'pane-died', 'detach-client -s =ag-resume-repair', socket);

    const decision = await prepareSessionForResume('ag-resume-repair', socket);
    expect(decision.decision).toBe('attach');

    const marker = (await runTmux({ socket, args: ['show-options', '-v', '-t', 'ag-resume-repair', '@ag_hook_schema'] })).stdout.trim();
    expect(marker).toBe(String(AGENT_HOOK_SCHEMA));
  });
});

describe.skipIf(skipReason)('reapDeadTmuxPanes', () => {
  let socket: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-tmux-reap-'));
    socket = path.join(tempDir, 'test.sock');
  });

  afterEach(async () => {
    await killAll(socket).catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty result when no server is running', async () => {
    const result = await reapDeadTmuxPanes(socket);
    expect(result.reaped).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  it('reaps a session whose only pane is dead', async () => {
    const { name } = await createSession({ name: 'dead-reap-test', cmd: 'true', socket });
    const pane = (
      await runTmux({ socket, args: ['list-panes', '-t', `=${name}`, '-F', '#{pane_id}'], throwOnError: false })
    ).stdout.trim().split('\n')[0];
    await waitForExitStatus(pane, socket, 8000);

    const result = await reapDeadTmuxPanes(socket);
    expect(result.reaped).toBeGreaterThanOrEqual(1);
    expect(result.sessions).toContain(name);
    expect(await hasSession(name, socket)).toBe(false);
  });

  it('does NOT reap a session with a live pane', async () => {
    const { name } = await createSession({ name: 'alive-reap-test', cmd: 'sleep 60', socket });

    const result = await reapDeadTmuxPanes(socket);
    expect(result.sessions).not.toContain(name);
    expect(await hasSession(name, socket)).toBe(true);
  });
});

function wait(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForPanePid(pane: string, socket: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await runTmux({ socket, args: ['display-message', '-pt', pane, '-p', '#{pane_pid}'], throwOnError: false });
    const pid = parseInt(r.stdout.trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return pid; } catch {  }
    }
    if (Date.now() >= deadline) return 0;
    await wait(50);
  }
}

async function waitForSessionGone(
  name: string,
  socket: string,
  timeoutMs = 20000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await hasSession(name, socket))) return true;
    if (Date.now() >= deadline) return false;
    await wait(50);
  }
}

async function waitForPanes(
  name: string,
  socket: string,
  expected: number,
  timeoutMs = 20000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let panes: string[] = [];
  for (;;) {
    panes = (await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}:#{pane_dead}'] }))
      .stdout.trim().split('\n').filter(Boolean);
    if (panes.length === expected || Date.now() >= deadline) return panes;
    await wait(50);
  }
}

async function waitForExitStatus(
  pane: string,
  socket: string,
  timeoutMs = 5000,
): Promise<Awaited<ReturnType<typeof paneExitStatus>>> {
  const deadline = Date.now() + timeoutMs;
  let exit: Awaited<ReturnType<typeof paneExitStatus>> = { found: false, dead: false };
  for (;;) {
    exit = await paneExitStatus(pane, socket);
    if ((exit.dead && exit.status !== undefined) || Date.now() >= deadline) return exit;
    await wait(50);
  }
}

async function waitForCapture(
  opts: Parameters<typeof capturePane>[0],
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let screen = '';
  for (;;) {
    screen = await capturePane(opts);
    if (screen.includes(needle) || Date.now() >= deadline) return screen;
    await wait(50);
  }
}

describe('already-running server reconcile (RUSH-3066)', () => {
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reconcile-'));

  it('configures a server that was ALREADY running before agents-cli touched it', async () => {
    if (!isTmuxInstalled()) return;
    const dir = mk();
    const socket = path.join(dir, 's.sock');
    try {
      spawnSync('tmux', ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'preexisting'], { encoding: 'utf-8' });
      const before = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', 'mouse'], { encoding: 'utf-8' });
      expect(before.stdout.trim()).toBe('off');

      await createSession({ name: 'agent-1', socket, cmd: 'sleep 30' });

      const mouse = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', 'mouse'], { encoding: 'utf-8' });
      const hist = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', 'history-limit'], { encoding: 'utf-8' });
      const stamp = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', '@ag_tmux_config_schema'], { encoding: 'utf-8' });
      expect(mouse.stdout.trim()).toBe('on');
      expect(hist.stdout.trim()).toBe(String(AGENTS_TMUX_HISTORY_LIMIT));
      expect(stamp.stdout.trim()).toBe(String(AGENTS_TMUX_CONFIG_SCHEMA));
    } finally {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf-8' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconciles on the attachExisting path too', async () => {
    if (!isTmuxInstalled()) return;
    const dir = mk();
    const socket = path.join(dir, 's.sock');
    try {
      spawnSync('tmux', ['-f', '/dev/null', '-S', socket, 'new-session', '-d', '-s', 'legacy'], { encoding: 'utf-8' });
      await createSession({ name: 'legacy', socket, attachExisting: true });
      const mouse = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', 'mouse'], { encoding: 'utf-8' });
      const stamp = spawnSync('tmux', ['-S', socket, 'show-options', '-gv', '@ag_tmux_config_schema'], { encoding: 'utf-8' });
      expect(mouse.stdout.trim()).toBe('on');
      expect(stamp.stdout.trim()).toBe(String(AGENTS_TMUX_CONFIG_SCHEMA));
    } finally {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf-8' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not source the user config twice on a cold start', async () => {
    if (!isTmuxInstalled()) return;
    const dir = mk();
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const marker = path.join(dir, 'sourced.log');
    fs.writeFileSync(path.join(home, '.tmux.conf'), `run-shell "echo x >> ${marker}"\n`);
    const socket = path.join(dir, 's.sock');
    try {
      await createSession({ name: 'cold', socket, cmd: 'sleep 30', env: { ...process.env, HOME: home } });
      await new Promise((r) => setTimeout(r, 400));
      const fired = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').trim().split('\n').length : 0;
      expect(fired).toBeLessThanOrEqual(1);
    } finally {
      spawnSync('tmux', ['-S', socket, 'kill-server'], { encoding: 'utf-8' });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
