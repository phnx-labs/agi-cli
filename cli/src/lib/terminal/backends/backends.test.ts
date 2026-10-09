import { describe, expect, it } from 'vitest';
import type { EngineContext } from '../types.js';
import { itermTabScript, itermSplitScript, itermBackend } from './iterm.js';
import { ghosttyTabScript, ghosttySplitScript, ghosttyBackend } from './ghostty.js';
import { tmuxTabArgv, tmuxSplitArgv, tmuxBackend } from './tmux.js';
import {
  vscodiumAgentBackend,
  makeVscodiumAgentBackend,
  spawnUri,
  focusTabSpecs,
  EDITOR_VARIANTS,
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
  it('tab: codium --open-url with a vscodium:// spawn URI carrying cwd + raw command (no zsh wrap)', () => {
    const argv = vscodiumAgentBackend.buildTab('/Users/me/dev', CMD);
    expect(argv.argv[0]).toBe('codium');
    expect(argv.argv[1]).toBe('--open-url');
    const url = argv.argv[2];
    expect(url.startsWith('vscodium://swarmify.swarm-ext/spawn?p=')).toBe(true);
    expect(url).not.toContain('zsh');
    const payload = payloadOf(url);
    expect(payload.cwd).toBe('/Users/me/dev');
    expect(payload.command).toBe('claude@2.1.187 --resume cad0e546');
    expect(payload.split).toBeUndefined();
  });
  it('split: carries the direction so the extension splits beside the prior pane', () => {
    expect(payloadOf(vscodiumAgentBackend.buildSplit('/d', CMD, 'right').argv[2]).split).toBe('right');
    expect(payloadOf(vscodiumAgentBackend.buildSplit('/d', CMD, 'down').argv[2]).split).toBe('down');
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
    const argv = vscodiumAgentBackend.buildTab('/d', ['ssh', 'x'], {
      agent: 'grok',
      sessionId: 'abc',
    });
    const payload = payloadOf(argv.argv[2]);
    expect(payload.agent).toBe('grok');
    expect(payload.sessionId).toBe('abc');
  });
  it('makeVscodiumAgentBackend binds a variant CLI + scheme (Cursor, VS Code)', () => {
    const cursor = makeVscodiumAgentBackend(EDITOR_VARIANTS[1]);
    expect(cursor.buildTab('/d', CMD).argv[0]).toBe('cursor');
    expect(cursor.buildTab('/d', CMD).argv[2].startsWith('cursor://')).toBe(true);
    const code = makeVscodiumAgentBackend(EDITOR_VARIANTS[2]);
    expect(code.buildTab('/d', CMD).argv[0]).toBe('code');
    expect(code.buildTab('/d', CMD).argv[2].startsWith('vscode://')).toBe(true);
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

