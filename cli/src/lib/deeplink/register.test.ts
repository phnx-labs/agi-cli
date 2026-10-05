import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  linuxDesktopEntry,
  macAppleScriptSource,
  macPlistBuddyCommands,
  windowsRegistryCommands,
  shQuote,
  linuxDesktopPath,
  agentsUrlSchemeStatus,
  registerAgentsUrlScheme,
  unregisterAgentsUrlScheme,
  AGENTS_URL_SCHEME,
} from './register.js';

describe('content generators', () => {
  it('linux desktop entry claims the scheme and runs the `_callback %u` verb', () => {
    const entry = linuxDesktopEntry(`'/usr/local/bin/agents'`);
    expect(entry).toContain('MimeType=x-scheme-handler/agents;');
    expect(entry).toContain(`Exec='/usr/local/bin/agents' _callback %u`);
    expect(entry).toContain('Type=Application');
  });

  it('macOS AppleScript quotes the URL as a single arg (no interpolation)', () => {
    const src = macAppleScriptSource(`'/usr/local/bin/agents'`);
    expect(src).toContain('on open location this_URL');
    expect(src).toContain('quoted form of this_URL');
    expect(src).toContain(`'/usr/local/bin/agents' _callback `);
    expect(src).not.toContain('& this_URL');
  });

  it('macOS AppleScript escapes a quote/backslash in the install path', () => {
    const src = macAppleScriptSource(`'/weird"path\\bin/agents'`);
    expect(src).toContain('\\"path');
    expect(src).toContain('\\\\bin');
  });

  it('macOS plist commands add the agents scheme', () => {
    const cmds = macPlistBuddyCommands('/tmp/x/Info.plist');
    const joined = cmds.map((c) => c.join(' ')).join('\n');
    expect(joined).toContain('CFBundleURLSchemes:0 string agents');
    expect(joined).toContain('CFBundleURLTypes array');
  });

  it('windows registry commands wire shell/open/command with the `_callback "%1"` verb', () => {
    const cmds = windowsRegistryCommands('"C:\\\\agents.exe"');
    const cmd = cmds.find((c) => c.join(' ').includes('shell\\open\\command'))!;
    expect(cmd.join(' ')).toContain('_callback "%1"');
  });

  it('shQuote neutralizes embedded single quotes', () => {
    expect(shQuote(`/a'b/agents`)).toBe(`'/a'\\''b/agents'`);
  });
});

describe('register/unregister on linux (real filesystem)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-deeplink-'));
  afterEach(() => {
    fs.rmSync(linuxDesktopPath(home), { force: true });
  });

  it('reports unregistered before, registered after, and is idempotent', () => {
    expect(agentsUrlSchemeStatus('linux', home).registered).toBe(false);

    const first = registerAgentsUrlScheme({ platform: 'linux', home });
    expect(first.registered).toBe(true);
    expect(fs.existsSync(linuxDesktopPath(home))).toBe(true);
    expect(fs.readFileSync(linuxDesktopPath(home), 'utf8')).toContain('x-scheme-handler/agents');

    const second = registerAgentsUrlScheme({ platform: 'linux', home, ifMissing: true });
    expect(second.registered).toBe(true);

    const removed = unregisterAgentsUrlScheme({ platform: 'linux', home });
    expect(removed.registered).toBe(false);
    expect(fs.existsSync(linuxDesktopPath(home))).toBe(false);
  });
});

describe('scheme constant', () => {
  it('is "agents"', () => {
    expect(AGENTS_URL_SCHEME).toBe('agents');
  });
});
