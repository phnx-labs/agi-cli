import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EngineContext, LaunchSpec } from '../types.js';
import { itermTabScript, itermSplitScript, itermBackend } from './iterm.js';
import { ghosttyTabScript, ghosttySplitScript, ghosttyBackend } from './ghostty.js';
import { tmuxTabArgv, tmuxSplitArgv, tmuxBackend } from './tmux.js';
import {
  vscodiumAgentBackend,
  makeVscodiumAgentBackend,
  spawnUri,
  focusTabSpecs,
  EDITOR_VARIANTS,
  parseSpawnAck,
  awaitSpawnAck,
  ackLandedIn,
  spawnAckRelPath,
  editorWindowFor,
  editorFolderNamed,
  storageJsonFor,

} from './vscodium-agent.js';
import { detectCurrentBackend, availableBackends, BACKENDS } from './index.js';

const CMD = ['claude@2.1.187', '--resume', 'cad0e546'];
const ctx = (env: Record<string, string>, platform: NodeJS.Platform = 'darwin'): EngineContext =>
  ({ platform, env: env as NodeJS.ProcessEnv });

describe('iterm backend', () => {
  it('tab: creates a tab in current window (or a window when none), interactive login shell + cd', () => {
    const s = itermTabScript('/Users/me/dev', CMD);
    expect(s).toContain('tell application "iTerm2"');
    expect(s).toContain('create tab with default profile command');
    expect(s).toContain('if (count of windows) is 0 then');
    expect(s).toContain('zsh -ilc');
    expect(s).toContain('/Users/me/dev');
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
  });
  it('split: right = "split vertically", down = "split horizontally"', () => {
    expect(itermSplitScript('/d', CMD, 'right')).toContain('split vertically with default profile command');
    expect(itermSplitScript('/d', CMD, 'down')).toContain('split horizontally with default profile command');
    expect(itermSplitScript('/d', CMD, 'right')).toContain('create window with default profile command');
  });
  it('buildTab/buildSplit route through osascript', () => {
    expect(itermBackend.buildTab('/d', CMD).argv[0]).toBe('osascript');
    expect(itermBackend.buildSplit('/d', CMD, 'right').argv[0]).toBe('osascript');
  });
});

describe('ghostty backend', () => {
  it('tab: native cwd + command, no cd wrapper', () => {
    const s = ghosttyTabScript('/Users/me/dev', CMD);
    expect(s).toContain('tell application "Ghostty"');
    expect(s).toContain('new surface configuration');
    expect(s).toContain('set initial working directory of cfg to "/Users/me/dev"');
    expect(s).toContain('new tab in front window with configuration cfg');
    expect(s).toContain('zsh -ilc');
    expect(s).toContain('exec claude@2.1.187 --resume cad0e546');
    expect(s).not.toContain('cd ');
  });
  it('split: splits the current surface (focused terminal of selected tab of front window)', () => {
    const right = ghosttySplitScript('/d', CMD, 'right');
    expect(right).toContain('split (focused terminal of selected tab of front window) direction right with configuration cfg');
    expect(ghosttySplitScript('/d', CMD, 'down')).toContain('direction down with configuration cfg');
    expect(right).toContain('new window with configuration cfg');
  });
});

describe('tmux backend', () => {
  it('tab: new-window with -c cwd and interactive-login-wrapped command', () => {
    expect(tmuxTabArgv('/x/y', CMD)).toEqual([
      'tmux', 'new-window', '-c', '/x/y', "zsh -ilc 'exec claude@2.1.187 --resume cad0e546'",
    ]);
  });
  it('split: -h for right (side-by-side), -v for down (stacked)', () => {
    expect(tmuxSplitArgv('/x', CMD, 'right').slice(0, 3)).toEqual(['tmux', 'split-window', '-h']);
    expect(tmuxSplitArgv('/x', CMD, 'down').slice(0, 3)).toEqual(['tmux', 'split-window', '-v']);
  });
});

const payloadOf = (url: string): any => {
  const p = new URLSearchParams(url.split('?')[1]).get('p')!;
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
};

describe('vscodium-agent backend', () => {
  const cliName = (argv: string[]): string => argv[0].split('/').pop()!;

  it('tab: raises the cwd window, then sends the spawn URI carrying cwd + raw command (no zsh wrap)', () => {
    const [raise, open] = vscodiumAgentBackend.buildTab('/Users/me/dev', CMD) as LaunchSpec[];
    expect(cliName(raise.argv)).toBe('codium');
    expect(raise.argv.slice(1)).toEqual(['/Users/me/dev']);
    expect(cliName(open.argv)).toBe('codium');
    expect(open.argv[1]).toBe('--open-url');
    const url = open.argv[2];
    expect(url.startsWith('vscodium://swarmify.swarm-ext/spawn?p=')).toBe(true);
    expect(url).not.toContain('zsh');
    const payload = payloadOf(url);
    expect(payload.cwd).toBe('/Users/me/dev');
    expect(payload.command).toBe('claude@2.1.187 --resume cad0e546');
    expect(payload.split).toBeUndefined();
  });
  it('split: raises the cwd window and carries the direction so the extension splits beside the prior pane', () => {
    const [raise, right] = vscodiumAgentBackend.buildSplit('/d', CMD, 'right') as LaunchSpec[];
    expect(raise.argv.slice(1)).toEqual(['/d']);
    expect(payloadOf(right.argv[2]).split).toBe('right');
    expect(payloadOf((vscodiumAgentBackend.buildSplit('/d', CMD, 'down') as LaunchSpec[])[1].argv[2]).split).toBe('down');
  });
  it('spawnUri survives &, spaces, and = in cwd + command (base64url payload, URL-safe)', () => {
    const url = spawnUri('vscodium', '/Users/me/my project', ['claude', '--resume', 'a b&c=d']);
    const query = url.split('?')[1];
    expect(query.startsWith('p=')).toBe(true);
    expect(/^p=[A-Za-z0-9_-]+$/.test(query)).toBe(true);
    const payload = payloadOf(url);
    expect(payload.cwd).toBe('/Users/me/my project');
    expect(payload.command).toBe('claude --resume a b&c=d');
  });
  it('spawnUri carries agent + sessionId meta for remote-attach chip stamping (#2478)', () => {
    const url = spawnUri(
      'vscodium',
      '/Users/me/dev',
      ['ssh', '-tt', 'yosemite-s0', 'tmux attach -t ag'],
      undefined,
      { agent: 'claude', sessionId: '115db661-1079-4e6b-846c-ce9aa05494f8', title: 'CC - restore' },
    );
    const payload = payloadOf(url);
    expect(payload.agent).toBe('claude');
    expect(payload.sessionId).toBe('115db661-1079-4e6b-846c-ce9aa05494f8');
    expect(payload.title).toBe('CC - restore');
    expect(payload.command).toContain('ssh');
  });
  it('buildTab forwards meta into the spawn URI', () => {
    const [, open] = vscodiumAgentBackend.buildTab('/d', ['ssh', 'x'], {
      agent: 'grok',
      sessionId: 'abc',
    }) as LaunchSpec[];
    const payload = payloadOf(open.argv[2]);
    expect(payload.agent).toBe('grok');
    expect(payload.sessionId).toBe('abc');
  });
  it('makeVscodiumAgentBackend binds a variant CLI + scheme (Cursor, VS Code)', () => {
    const variant = { cli: 'cursor', scheme: 'cursor', app: '/nonexistent/Cursor.app', label: 'Cursor' };
    const [raise, open] = makeVscodiumAgentBackend(variant).buildTab('/d', CMD) as LaunchSpec[];
    expect(raise.argv).toEqual(['cursor', '/d']);
    expect(open.argv[0]).toBe('cursor');
    expect(open.argv[2].startsWith('cursor://')).toBe(true);
  });
  it('raises the session project window (not the cwd) and carries nonce + project in the payload', () => {
    const [raise, open] = vscodiumAgentBackend.buildTab('/Users/me/agents', CMD, {
      sessionId: 'b64b7320', project: '/Users/me/src/svatlas', nonce: 'n-1',
    }) as LaunchSpec[];
    expect(raise.argv.slice(1)).toEqual(['/Users/me/src/svatlas']);
    const payload = payloadOf(open.argv[2]);
    expect(payload.project).toBe('/Users/me/src/svatlas');
    expect(payload.nonce).toBe('n-1');
    expect(payload.cwd).toBe('/Users/me/agents');
  });
  it('is darwin-only (VSCodium.app presence checked at runtime)', () => {
    expect(vscodiumAgentBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
  });
});

describe('availability + detection', () => {
  it('tmux is available iff $TMUX is set (any platform)', () => {
    expect(tmuxBackend.isAvailable(ctx({ TMUX: '/tmp/x,1,0' }, 'linux'))).toBe(true);
    expect(tmuxBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
  });
  it('iTerm/Ghostty are darwin-only (app-presence checked at runtime)', () => {
    expect(itermBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
    expect(ghosttyBackend.isAvailable(ctx({}, 'linux'))).toBe(false);
  });
  it('detectCurrentBackend prefers tmux, then TERM_PROGRAM', () => {
    expect(detectCurrentBackend(ctx({ TMUX: 'x', TERM_PROGRAM: 'iTerm.app' }))).toBe('tmux');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'iTerm.app' }))).toBe('iterm');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'ghostty' }))).toBe('ghostty');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'Apple_Terminal' }))).toBe('terminal');
    expect(detectCurrentBackend(ctx({ TERM_PROGRAM: 'WarpTerminal' }))).toBeNull();
  });
  it('availableBackends on linux with tmux = [tmux] only', () => {
    const a = availableBackends(ctx({ TMUX: 'x' }, 'linux'));
    expect(a.map((b) => b.id)).toEqual(['tmux']);
  });
  it('registry has every backend', () => {
    expect(Object.keys(BACKENDS).sort()).toEqual(['ghostty', 'iterm', 'terminal', 'tmux', 'vscodium-agent']);
  });
  it('Terminal.app is last, so the available-backend floor never outranks a chosen terminal', () => {
    expect(Object.keys(BACKENDS).at(-1)).toBe('terminal');
  });
});

describe('focusTabSpecs — raise the owning window, then focus the tab in it', () => {
  const variant = { cli: 'codium', scheme: 'vscodium', app: '/nonexistent/VSCodium.app', label: 'VSCodium' };

  it('opens the window folder first, then sends /focus with the terminal id', () => {
    const [raise, focus] = focusTabSpecs(variant, '/Users/me/src/agents', 'cl-1791445191278-7');
    expect(raise.argv).toEqual(['codium', '/Users/me/src/agents']);
    expect(focus.argv).toEqual(['codium', '--open-url', 'vscodium://swarmify.swarm-ext/focus?terminalId=cl-1791445191278-7']);
  });

  it('encodes a terminal id that is not URL-safe', () => {
    const [, focus] = focusTabSpecs(variant, '/d', 'a b&c');
    expect(focus.argv[2]).toBe('vscodium://swarmify.swarm-ext/focus?terminalId=a%20b%26c');
  });
});


describe('spawn ack — the contract agi-ext writes back for a /spawn nonce', () => {
  const fixture = fs.readFileSync(new URL('./testdata/spawn-ack.json', import.meta.url), 'utf8');
  const full = JSON.parse(fixture);

  it('lives at ~/.swarmify/agents/spawn-acks/<nonce>.json', () => {
    expect(spawnAckRelPath(full.nonce)).toBe(`.swarmify/agents/spawn-acks/${full.nonce}.json`);
  });
  it('reads the shared fixture field for field', () => {
    expect(parseSpawnAck(fixture, full.nonce)).toEqual({ ...full, reason: undefined });
    for (const status of ['opened', 'focused-existing', 'wrong-window', 'failed']) {
      expect(parseSpawnAck(JSON.stringify({ ...full, status }), full.nonce)?.status).toBe(status);
    }
  });
  it('carries the extension\'s reason for a failed ack', () => {
    expect(parseSpawnAck(JSON.stringify({ ...full, status: 'failed', reason: "the tab's shell did not start" }), full.nonce)?.reason)
      .toBe("the tab's shell did not start");
  });
  it('treats the extension\'s nulls as absent', () => {
    const ack = parseSpawnAck(JSON.stringify({ ...full, status: 'wrong-window', terminalId: null, title: null, sessionId: null, pid: null, workspaceName: null }), full.nonce)!;
    expect(ack).toMatchObject({ status: 'wrong-window', terminalId: undefined, title: undefined, pid: undefined, workspaceName: undefined });
  });
  it('rejects an ack for another nonce, an unknown status, or broken JSON', () => {
    expect(parseSpawnAck(fixture, 'other')).toBeUndefined();
    expect(parseSpawnAck(JSON.stringify({ ...full, status: 'done' }), full.nonce)).toBeUndefined();
    expect(parseSpawnAck('{"nonce":', full.nonce)).toBeUndefined();
  });
  it('waits for an ack file that appears after the request, and gives up at the deadline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-ack-'));
    const file = path.join(dir, 'ack.json');
    const read = () => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } };
    setTimeout(() => fs.writeFileSync(file, fixture), 300);
    expect((await awaitSpawnAck(full.nonce, read, 3000))?.title).toBe(full.title);
    const started = Date.now();
    expect(await awaitSpawnAck('n-9', read, 400)).toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });
  it('counts a landing only in a window that holds the project folder', () => {
    const ack = parseSpawnAck(fixture, full.nonce)!;
    expect(ackLandedIn(ack, '/Users/dev/src/projB')).toBe(true);
    expect(ackLandedIn(ack, '/Users/dev/src/projB/.agents/worktrees/x')).toBe(true);
    expect(ackLandedIn({ ...ack, windowFolders: ['/Users/dev/src/projA'] }, '/Users/dev/src/projB')).toBe(false);
    expect(ackLandedIn({ ...ack, windowFolders: ['/Users/dev/src/proj'] }, '/Users/dev/src/projB')).toBe(false);
    expect(ackLandedIn({ ...ack, status: 'wrong-window' }, '/Users/dev/src/projB')).toBe(false);
    expect(ackLandedIn({ ...ack, status: 'failed' }, '/Users/dev/src/projB')).toBe(false);
  });
});

describe('editorWindowFor — which window `codium <x>` must raise for a project folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-windows-'));
  const ws = path.join(dir, 'Workspaces', '1791504977807', 'workspace.json');
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  fs.writeFileSync(ws, JSON.stringify({ folders: [{ path: '/Users/me/src/agents-cli' }, { path: '/Users/me/src/agi-menu' }] }));
  const storage = path.join(dir, 'storage.json');
  fs.writeFileSync(storage, JSON.stringify({
    windowsState: {
      lastActiveWindow: { folder: 'file:///Users/me/src/agents' },
      openedWindows: [
        { folder: null, workspaceIdentifier: { id: 'x', configURIPath: `file://${ws}` } },
        { folder: 'file:///Users/me/src/agents' },
        { folder: 'file:///Users/me/src/sv%20atlas' },
      ],
    },
  }));

  it('raises the multi-root workspace window through its workspace file', () => {
    expect(editorWindowFor('/Users/me/src/agents-cli', storage)).toBe(ws);
    expect(editorWindowFor('/Users/me/src/agents-cli/.agents/worktrees/x', storage)).toBe(ws);
  });
  it('raises a single-folder window by its folder (URI-decoded)', () => {
    expect(editorWindowFor('/Users/me/src/agents', storage)).toBe('/Users/me/src/agents');
    expect(editorWindowFor('/Users/me/src/sv atlas', storage)).toBe('/Users/me/src/sv atlas');
  });
  it('finds the one open root named after a peer session project (resolver rows carry no path)', () => {
    expect(editorFolderNamed('agents-cli', storage)).toBe('/Users/me/src/agents-cli');
    expect(editorFolderNamed('sv atlas', storage)).toBe('/Users/me/src/sv atlas');
    expect(editorFolderNamed('svatlas', storage)).toBeUndefined();
  });
  it('reads a portable editor\'s window state from VSCODE_PORTABLE', () => {
    const variant = EDITOR_VARIANTS[0];
    expect(storageJsonFor(variant, { VSCODE_PORTABLE: '/p' })).toBe('/p/user-data/User/globalStorage/storage.json');
    expect(storageJsonFor(variant, {})).toBe(path.join(os.homedir(), 'Library', 'Application Support', 'VSCodium', 'User', 'globalStorage', 'storage.json'));
  });
  it('falls back to the folder itself when no open window holds it, or the state is unreadable', () => {
    expect(editorWindowFor('/Users/me/src/agents-dashboard', storage)).toBe('/Users/me/src/agents-dashboard');
    expect(editorWindowFor('/Users/me/src/agents', path.join(dir, 'missing.json'))).toBe('/Users/me/src/agents');
  });
});
