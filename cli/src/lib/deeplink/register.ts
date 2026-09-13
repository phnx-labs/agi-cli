/**
 * Register the `agents://` URL scheme with the OS so a click in an artifact
 * routes to the machine-only `agents _callback <url>` verb (see url.ts +
 * commands/open.ts). Humans manage the handler with `agents setup url-scheme`.
 *
 * A browser page cannot spawn a shell; a registered URL scheme is the
 * OS-sanctioned hand-off. Each platform gets its own handler:
 *   - Linux:   a `.desktop` entry claiming `x-scheme-handler/agents`, made the
 *              default via `xdg-mime`.
 *   - macOS:   a tiny AppleScript app whose `on open location` runs the CLI;
 *              its Info.plist declares the `agents` scheme, registered with
 *              LaunchServices via `lsregister`.
 *   - Windows: `HKCU\Software\Classes\agents` shell-open-command registry keys.
 *
 * The content generators below are pure and unit-tested. The `register*` /
 * `unregister*` / `status*` functions apply them and never throw — they return a
 * {@link SchemeStatus} so callers (setup, `agents setup url-scheme register`,
 * doctor) can report without a try/catch.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentsBinPath } from '../cli-entry.js';

export const AGENTS_URL_SCHEME = 'agents';
const MAC_BUNDLE_ID = 'dev.agents.urlhandler';
const LINUX_DESKTOP_FILE = 'agents-url-handler.desktop';
const MAC_APP_NAME = 'AgentsURLHandler.app';

interface SchemeStatus {
  registered: boolean;
  platform: NodeJS.Platform;
  /** One human line: where the handler is, or why it is not registered. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Invocation resolution — the absolute command the handler runs.
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote a path so a space or metacharacter in it can never break
 * out of the handler command.
 */
export function shQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve how the OS handler should invoke this CLI, as an already-quoted
 * command prefix (without the `open <url>` suffix).
 *
 * A macOS GUI app does NOT inherit the shell PATH, so the handler must use an
 * absolute path. Prefer the `agents` shim on PATH (directly executable); fall
 * back to `<node> <entry>` for a bare JS install.
 */
function resolveAgentsInvocation(platform: NodeJS.Platform = os.platform()): string {
  const onPath = whichAgents(platform);
  if (onPath) return platform === 'win32' ? `"${onPath}"` : shQuote(onPath);
  const entry = getAgentsBinPath();
  if (platform === 'win32') return `"${process.execPath}" "${entry}"`;
  return `${shQuote(process.execPath)} ${shQuote(entry)}`;
}

function whichAgents(platform: NodeJS.Platform): string | null {
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['agents'], { encoding: 'utf8' }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure content generators (unit-tested).
// ---------------------------------------------------------------------------

/** The freedesktop `.desktop` entry that claims `x-scheme-handler/agents`. */
export function linuxDesktopEntry(invocation: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Agents URL Handler',
    'Comment=Resume an agents session from an agents:// deep link',
    `Exec=${invocation} _callback %u`,
    'Terminal=false',
    'NoDisplay=true',
    'MimeType=x-scheme-handler/agents;',
    '',
  ].join('\n');
}

/**
 * AppleScript whose `on open location` handler fires when macOS routes an
 * `agents://` URL to the app. `quoted form of` makes the URL a single safe
 * shell argument — the URL is never concatenated unquoted.
 */
export function macAppleScriptSource(invocation: string): string {
  // Escape the (already shell-quoted) invocation for an AppleScript double-quoted
  // string literal, so a `"` or `\` in the install path cannot break osacompile.
  const literal = invocation.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'on open location this_URL',
    `\tdo shell script "${literal} _callback " & quoted form of this_URL`,
    'end open location',
  ].join('\n');
}

/** PlistBuddy commands that add the `agents` URL type to a compiled app's Info.plist. */
export function macPlistBuddyCommands(plistPath: string): string[][] {
  const b = ['/usr/libexec/PlistBuddy', '-c'];
  return [
    [...b, 'Add :CFBundleIdentifier string ' + MAC_BUNDLE_ID, plistPath],
    [...b, 'Add :CFBundleURLTypes array', plistPath],
    [...b, 'Add :CFBundleURLTypes:0 dict', plistPath],
    [...b, 'Add :CFBundleURLTypes:0:CFBundleURLName string ' + MAC_BUNDLE_ID, plistPath],
    [...b, 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array', plistPath],
    [...b, `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${AGENTS_URL_SCHEME}`, plistPath],
  ];
}

/** `reg add` argv lists that register the scheme under HKCU on Windows. */
export function windowsRegistryCommands(invocation: string): string[][] {
  const base = 'HKCU\\Software\\Classes\\agents';
  return [
    ['add', base, '/ve', '/d', 'URL:agents Protocol', '/f'],
    ['add', base, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${base}\\shell\\open\\command`, '/ve', '/d', `${invocation} _callback "%1"`, '/f'],
  ];
}

// ---------------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------------

export function linuxDesktopPath(home = os.homedir()): string {
  return path.join(home, '.local', 'share', 'applications', LINUX_DESKTOP_FILE);
}

function macAppPath(home = os.homedir()): string {
  return path.join(home, 'Applications', MAC_APP_NAME);
}

// ---------------------------------------------------------------------------
// Status.
// ---------------------------------------------------------------------------

/** Whether the handler artifact exists on disk (a cheap, side-effect-free check). */
export function agentsUrlSchemeStatus(platform: NodeJS.Platform = os.platform(), home = os.homedir()): SchemeStatus {
  if (platform === 'linux') {
    const p = linuxDesktopPath(home);
    return fs.existsSync(p)
      ? { registered: true, platform, detail: `handler: ${p}` }
      : { registered: false, platform, detail: `no handler (${p}) — run: agents setup url-scheme register` };
  }
  if (platform === 'darwin') {
    const p = macAppPath(home);
    return fs.existsSync(p)
      ? { registered: true, platform, detail: `handler: ${p}` }
      : { registered: false, platform, detail: `no handler (${p}) — run: agents setup url-scheme register` };
  }
  if (platform === 'win32') {
    const ok = windowsSchemeRegistered();
    return ok
      ? { registered: true, platform, detail: 'handler: HKCU\\Software\\Classes\\agents' }
      : { registered: false, platform, detail: 'no handler — run: agents setup url-scheme register' };
  }
  return { registered: false, platform, detail: `unsupported platform: ${platform}` };
}

function windowsSchemeRegistered(): boolean {
  try {
    execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\agents\\shell\\open\\command'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Register / unregister (side-effecting, never throw).
// ---------------------------------------------------------------------------

interface RegisterOptions {
  platform?: NodeJS.Platform;
  home?: string;
  /** Skip if already present (used by best-effort callers like setup). */
  ifMissing?: boolean;
}

export function registerAgentsUrlScheme(opts: RegisterOptions = {}): SchemeStatus {
  const platform = opts.platform ?? os.platform();
  const home = opts.home ?? os.homedir();
  if (opts.ifMissing && agentsUrlSchemeStatus(platform, home).registered) {
    return agentsUrlSchemeStatus(platform, home);
  }
  try {
    if (platform === 'linux') return registerLinux(home);
    if (platform === 'darwin') return registerMac(home);
    if (platform === 'win32') return registerWindows(platform);
    return { registered: false, platform, detail: `unsupported platform: ${platform}` };
  } catch (err) {
    return { registered: false, platform, detail: `registration failed: ${(err as Error).message}` };
  }
}

export function unregisterAgentsUrlScheme(opts: { platform?: NodeJS.Platform; home?: string } = {}): SchemeStatus {
  const platform = opts.platform ?? os.platform();
  const home = opts.home ?? os.homedir();
  try {
    if (platform === 'linux') {
      fs.rmSync(linuxDesktopPath(home), { force: true });
      run('update-desktop-database', [path.dirname(linuxDesktopPath(home))], true);
      return { registered: false, platform, detail: 'handler removed' };
    }
    if (platform === 'darwin') {
      fs.rmSync(macAppPath(home), { recursive: true, force: true });
      return { registered: false, platform, detail: 'handler removed' };
    }
    if (platform === 'win32') {
      run('reg', ['delete', 'HKCU\\Software\\Classes\\agents', '/f'], true);
      return { registered: false, platform, detail: 'handler removed' };
    }
    return { registered: false, platform, detail: `unsupported platform: ${platform}` };
  } catch (err) {
    return { registered: agentsUrlSchemeStatus(platform, home).registered, platform, detail: `removal failed: ${(err as Error).message}` };
  }
}

function registerLinux(home: string): SchemeStatus {
  const invocation = resolveAgentsInvocation('linux');
  const dest = linuxDesktopPath(home);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, linuxDesktopEntry(invocation), 'utf8');
  // Make it the default handler for the scheme; best-effort DB refresh.
  run('xdg-mime', ['default', LINUX_DESKTOP_FILE, 'x-scheme-handler/agents'], true);
  run('update-desktop-database', [path.dirname(dest)], true);
  return { registered: true, platform: 'linux', detail: `handler: ${dest}` };
}

function registerMac(home: string): SchemeStatus {
  const invocation = resolveAgentsInvocation('darwin');
  const app = macAppPath(home);
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.rmSync(app, { recursive: true, force: true });

  // Compile the AppleScript into an .app, then inject the URL scheme into its plist.
  const scriptFile = path.join(os.tmpdir(), `agents-url-handler-${process.pid}.applescript`);
  fs.writeFileSync(scriptFile, macAppleScriptSource(invocation), 'utf8');
  try {
    run('osacompile', ['-o', app, scriptFile], false);
  } finally {
    fs.rmSync(scriptFile, { force: true });
  }
  const plist = path.join(app, 'Contents', 'Info.plist');
  // Non-optional: if the URL type is not written, the scheme is never claimed —
  // registerAgentsUrlScheme must report failure, not a false "registered".
  for (const cmd of macPlistBuddyCommands(plist)) run(cmd[0], cmd.slice(1), false);
  // Register with LaunchServices so the scheme resolves without a reboot.
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  run(lsregister, ['-f', app], true);
  return { registered: true, platform: 'darwin', detail: `handler: ${app}` };
}

function registerWindows(platform: NodeJS.Platform): SchemeStatus {
  const invocation = resolveAgentsInvocation('win32');
  for (const args of windowsRegistryCommands(invocation)) run('reg', args, false);
  return { registered: true, platform, detail: 'handler: HKCU\\Software\\Classes\\agents' };
}

/** Run a helper command. `optional` swallows failures (best-effort DB refreshes). */
function run(cmd: string, args: string[], optional: boolean): void {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
  } catch (err) {
    if (!optional) throw err;
  }
}
