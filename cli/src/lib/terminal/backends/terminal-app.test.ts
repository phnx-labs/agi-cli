import { describe, it, expect } from 'vitest';
import { terminalAppBackend, terminalAppTabScript } from './terminal-app.js';

describe('terminal-app backend', () => {
  it('is darwin-only and unavailable over SSH — osascript cannot reach the GUI login there', () => {
    expect(terminalAppBackend.isAvailable({ platform: 'linux', env: {} })).toBe(false);
    expect(
      terminalAppBackend.isAvailable({ platform: 'darwin', env: { SSH_CONNECTION: '10.0.0.1 22' } }),
    ).toBe(false);
    expect(terminalAppBackend.isAvailable({ platform: 'darwin', env: { SSH_TTY: '/dev/ttys004' } })).toBe(false);
  });

  it('cds into the working directory and execs in an interactive login shell', () => {
    const script = terminalAppTabScript('/tmp/my repo', ['agents', 'run', 'claude']);
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain('zsh -ilc');
    expect(script).toContain(String.raw`cd '\\''/tmp/my repo'\\'' && exec agents run claude`);
  });

  it('opens a window when none exists, otherwise a tab of the front window', () => {
    const script = terminalAppTabScript('/tmp', ['agents', 'run', 'claude']);
    expect(script).toContain('if (count of windows) is 0 then');
    expect(script).toContain('in front window');
  });

  it('has no scriptable split — a split request builds the tab command', () => {
    const tab = terminalAppBackend.buildTab('/tmp', ['x']);
    expect(terminalAppBackend.buildSplit('/tmp', ['x'], 'right')).toEqual(tab);
    expect(terminalAppBackend.buildSplit('/tmp', ['x'], 'down')).toEqual(tab);
  });

  it('escapes a quote in the working directory rather than breaking the script', () => {
    const script = terminalAppTabScript(`/tmp/a"b`, ['agents', 'run', 'claude']);
    expect(script).toContain('\\"');
    expect(script.split('\n').filter((l) => l.includes('do script')).length).toBe(2);
  });
});
