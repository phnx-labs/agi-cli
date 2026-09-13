/**
 * Tests for the Terminal Engine injection primitive (Gap 2).
 *
 * Two layers, no mocks:
 *   1. Pure builders (tmux argv / iTerm+Ghostty AppleScript) — asserted
 *      directly, including the macOS paths that can't execute on Linux.
 *   2. A real tmux round-trip: spawn a pane, inject through `injectIntoTerminal`,
 *      and read the pane back to prove the bytes + Enter actually landed. Skipped
 *      cleanly when tmux isn't installed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTmuxInstalled, runTmux } from '../tmux/binary.js';
import { createSession, capturePane, killAll } from '../tmux/session.js';
import type { EngineContext } from './types.js';
import {
  injectIntoTerminal,
  tmuxSendKeysArgv,
  tmuxInjectSpecs,
  itermInjectScript,
  ghosttyInjectScript,
  appleScriptInjectSpec,
  vscodiumInjectUri,
  vscodiumInjectSpec,
} from './inject.js';

const linuxCtx: EngineContext = { platform: 'linux', env: {} as NodeJS.ProcessEnv };

/** The first (only) pane id of a freshly-created single-pane session, e.g. `%3`. */
async function firstPaneId(name: string, socket: string): Promise<string> {
  const res = await runTmux({ socket, args: ['list-panes', '-t', name, '-F', '#{pane_id}'] });
  return res.stdout.trim().split('\n')[0];
}

describe('tmuxSendKeysArgv', () => {
  it('starts with tmux so the engine transport runs it locally or over SSH', () => {
    expect(tmuxSendKeysArgv('%2', 'continue', { literal: true })).toEqual([
      'tmux', 'send-keys', '-t', '%2', '-l', 'continue',
    ]);
  });

  it('positions -S <socket> before the subcommand', () => {
    expect(tmuxSendKeysArgv('%2', 'Enter', { socket: '/tmp/s.sock' })).toEqual([
      'tmux', '-S', '/tmp/s.sock', 'send-keys', '-t', '%2', 'Enter',
    ]);
  });
});

describe('tmuxInjectSpecs', () => {
  it('Ink-safe default: two specs — literal text, then a separate Enter keypress', () => {
    const specs = tmuxInjectSpecs({ backend: 'tmux', pane: '%1' }, 'go', { enter: true, combined: false });
    expect(specs).toHaveLength(2);
    expect(specs[0].argv).toEqual(['tmux', 'send-keys', '-t', '%1', '-l', 'go']);
    expect(specs[1].argv).toEqual(['tmux', 'send-keys', '-t', '%1', 'Enter']);
  });

  it('combined: one spec fusing a CR into the literal write', () => {
    const specs = tmuxInjectSpecs({ backend: 'tmux', pane: '%1' }, 'go', { enter: true, combined: true });
    expect(specs).toHaveLength(1);
    expect(specs[0].argv).toEqual(['tmux', 'send-keys', '-t', '%1', '-l', 'go\r']);
  });

  it('enter=false: just the literal text, no Enter', () => {
    const specs = tmuxInjectSpecs({ backend: 'tmux', pane: '%1' }, 'go', { enter: false, combined: false });
    expect(specs).toHaveLength(1);
    expect(specs[0].argv).toEqual(['tmux', 'send-keys', '-t', '%1', '-l', 'go']);
  });
});

describe('itermInjectScript', () => {
  it('writes into the current session with NO activate (focus-safe) and a separate CR Enter', () => {
    const s = itermInjectScript('continue', { enter: true });
    expect(s).toContain('tell application "iTerm2"');
    expect(s).toContain('tell current session of current window');
    // Focus-safe: never activates iTerm or steals the frontmost split.
    expect(s).not.toContain('activate');
    // Ink-safe: text without a fused newline, then a SEPARATE lone CR.
    expect(s).toContain('write text "continue" newline no');
    expect(s).toContain('write text (character id 13) newline no');
    expect(s.indexOf('write text "continue"')).toBeLessThan(s.indexOf('character id 13'));
  });

  it('addresses the EXACT split by session id (tell session id …), never the frontmost', () => {
    const s = itermInjectScript('go', { session: 'ABC-123', enter: true });
    expect(s).toContain('tell session id "ABC-123"');
    expect(s).not.toContain('current session');
    expect(s).not.toContain('activate');
  });

  it('combined fuses text+Enter into one auto-newline write (plain shells / REPLs)', () => {
    const s = itermInjectScript('go', { enter: true, combined: true });
    expect(s).toContain('write text "go"');
    expect(s).not.toContain('newline no');
    expect(s).not.toContain('character id 13');
  });

  it('omits the Return event when enter is false (text only, no newline)', () => {
    const s = itermInjectScript('partial', { enter: false });
    expect(s).toContain('write text "partial" newline no');
    expect(s).not.toContain('character id 13');
  });

  it('escapes quotes in the injected text via the engine appleScriptStr', () => {
    expect(itermInjectScript('say "hi"', { enter: false })).toContain('write text "say \\"hi\\"" newline no');
  });
});

describe('vscodiumInjectUri', () => {
  it('builds a base64url /inject URL whose decoded payload carries id + text + flags', () => {
    const uri = vscodiumInjectUri('vscodium', 'sess-uuid', 'continue', { enter: true, combined: false });
    expect(uri.startsWith('vscodium://swarmify.swarm-ext/inject?p=')).toBe(true);
    const p = uri.split('p=')[1];
    // base64url alphabet only — survives VS Code's single percent-decode of uri.query.
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(payload).toEqual({ terminalId: 'sess-uuid', text: 'continue', enter: true, combined: false });
  });

  it('round-trips a text containing & and = untouched (the reason for base64url)', () => {
    const uri = vscodiumInjectUri('cursor', 't1', 'echo a && b = c', { enter: true, combined: false });
    const payload = JSON.parse(Buffer.from(uri.split('p=')[1], 'base64url').toString('utf8'));
    expect(payload.text).toBe('echo a && b = c');
  });
});

describe('vscodiumInjectSpec', () => {
  it('invokes the editor CLI with --open-url and the inject URI', () => {
    const spec = vscodiumInjectSpec(
      { backend: 'vscodium', terminalId: 't1', cli: 'codium', scheme: 'vscodium' },
      'hi',
      { enter: true, combined: false },
    );
    expect(spec.argv[0]).toBe('codium');
    expect(spec.argv[1]).toBe('--open-url');
    expect(spec.argv[2].startsWith('vscodium://swarmify.swarm-ext/inject?p=')).toBe(true);
  });
});

describe('ghosttyInjectScript', () => {
  it('raises the ghostty process and keystrokes text + separate Return', () => {
    const s = ghosttyInjectScript('continue', { enter: true });
    expect(s).toContain('tell process "ghostty"');
    expect(s).toContain('set frontmost to true');
    expect(s).toContain('keystroke "continue"');
    expect(s).toContain('key code 36');
  });

  it('raises a specific window by title when given one', () => {
    const s = ghosttyInjectScript('go', { window: 'RUSH-1415', enter: true });
    expect(s).toContain('AXRaise');
    expect(s).toContain('title contains "RUSH-1415"');
  });
});

describe('appleScriptInjectSpec', () => {
  it('wraps the iterm write-text script as an osascript spec', () => {
    const spec = appleScriptInjectSpec({ backend: 'iterm' }, 'hi', true);
    expect(spec.argv[0]).toBe('osascript');
    expect(spec.argv[1]).toBe('-e');
    expect(spec.argv[2]).toContain('write text "hi"');
  });

  it('wraps the ghostty keystroke script as an osascript spec (coarse path)', () => {
    const spec = appleScriptInjectSpec({ backend: 'ghostty' }, 'hi', true);
    expect(spec.argv[0]).toBe('osascript');
    expect(spec.argv[2]).toContain('keystroke "hi"');
  });
});

describe('injectIntoTerminal — macOS backends off-darwin', () => {
  it('does not execute where the app is unavailable, but returns the spec it would run', async () => {
    const res = await injectIntoTerminal({ backend: 'iterm' }, 'continue', { ctx: linuxCtx });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not available');
    expect(res.specs?.[0].argv[0]).toBe('osascript');
  });

  it('dryRun returns the spec without touching the OS on any platform', async () => {
    const res = await injectIntoTerminal({ backend: 'ghostty', window: 'w1' }, 'hi', { dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.writes).toBe(2);
    expect(res.specs?.[0].argv.join(' ')).toContain('keystroke "hi"');
  });

  it('ghostty write-count tracks enter alone (its coarse script ignores combined)', async () => {
    // The keystroke path always emits keystroke + a separate Return, so combined
    // does NOT fuse it — the count must stay 2, not collapse to 1.
    const combined = await injectIntoTerminal({ backend: 'ghostty' }, 'hi', { dryRun: true, combined: true });
    expect(combined.writes).toBe(2);
    const noEnter = await injectIntoTerminal({ backend: 'ghostty' }, 'hi', { dryRun: true, enter: false });
    expect(noEnter.writes).toBe(1);
  });
});

describe('injectIntoTerminal — vscodium routing', () => {
  it('dryRun returns the editor-CLI --open-url spec and the Ink-safe two-write count', async () => {
    const res = await injectIntoTerminal(
      { backend: 'vscodium', terminalId: 't1', cli: 'codium', scheme: 'vscodium' },
      'continue',
      { dryRun: true },
    );
    expect(res.ok).toBe(true);
    expect(res.backend).toBe('vscodium');
    expect(res.writes).toBe(2);
    expect(res.specs?.[0].argv[0]).toBe('codium');
    expect(res.specs?.[0].argv[1]).toBe('--open-url');
    expect(res.specs?.[0].argv[2]).toContain('swarmify.swarm-ext/inject');
  });

  it('combined collapses to a single write on the extension side', async () => {
    const res = await injectIntoTerminal(
      { backend: 'vscodium', terminalId: 't1', cli: 'cursor', scheme: 'cursor' },
      'ls',
      { dryRun: true, combined: true },
    );
    expect(res.writes).toBe(1);
  });
});

const skipReason = isTmuxInstalled() ? null : 'tmux not installed';

describe.skipIf(skipReason)('injectIntoTerminal — real tmux round-trip', () => {
  let socket: string;
  let tempDir: string;
  const name = 'inject-e2e';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-inject-test-'));
    socket = path.join(tempDir, 'srv.sock');
  });

  afterEach(async () => {
    try { await killAll(socket); } catch { /* best-effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* gone */ }
  });

  it('delivers text + Enter so a shell actually runs the injected command', async () => {
    // A pane running an interactive shell — the exact shape a stalled agent sits in.
    await createSession({ name, socket, cmd: 'sh', cwd: tempDir });
    const pane = await firstPaneId(name, socket);

    const marker = path.join(tempDir, 'ran.txt');
    const res = await injectIntoTerminal({ backend: 'tmux', pane, socket }, `touch ${marker}`);
    expect(res.ok).toBe(true);
    expect(res.backend).toBe('tmux');
    // Ink-safe default: literal text write, then a separate Enter write.
    expect(res.writes).toBe(2);

    // Poll for the side effect — proof the Enter actually submitted the line.
    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
      if (fs.existsSync(marker)) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(landed).toBe(true);
  });

  it('injects visible text into the pane (cat echoes it back)', async () => {
    await createSession({ name, socket, cmd: 'cat', cwd: tempDir });
    const pane = await firstPaneId(name, socket);

    const res = await injectIntoTerminal({ backend: 'tmux', pane, socket }, 'continue-please', { enter: false });
    expect(res.ok).toBe(true);

    let seen = '';
    for (let i = 0; i < 40; i++) {
      seen = await capturePane({ name, socket });
      if (seen.includes('continue-please')) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain('continue-please');
  });

  it('combined mode fuses text+CR into a single write that still submits', async () => {
    await createSession({ name, socket, cmd: 'sh', cwd: tempDir });
    const pane = await firstPaneId(name, socket);

    const marker = path.join(tempDir, 'combined.txt');
    const res = await injectIntoTerminal({ backend: 'tmux', pane, socket }, `touch ${marker}`, { combined: true });
    expect(res.ok).toBe(true);
    expect(res.writes).toBe(1);

    let landed = false;
    for (let i = 0; i < 40 && !landed; i++) {
      if (fs.existsSync(marker)) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(landed).toBe(true);
  });
});
