import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProfileRuntimeDir } from './profiles.js';
import { discoverBrowserWsUrl, registerPipeTransport, type BrowserDiscovery } from './cdp.js';
import { readAndResolveBundleEnv, bundleExists } from '../secrets-client.js';
import { writeProfileRuntime, readProfileRuntime } from './runtime-state.js';
import type { ChromeOptions } from './types.js';
import type { Readable, Writable } from 'stream';

import type { BrowserType } from './types.js';

// Windows install roots. Resolve from the environment (fall back to the usual
// defaults) so per-user installs under %LOCALAPPDATA% and 64-bit Program Files
// are found, not just the hardcoded x86 path. Only the `win32` entries below use
// these; on other platforms they compute unused placeholder strings.
const WIN_PROGRAMFILES = process.env.ProgramFiles || 'C:\\Program Files';
const WIN_PROGRAMFILES_X86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const WIN_LOCALAPPDATA = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;

const BROWSER_PATHS: Record<string, Record<BrowserType, string[]>> = {
  darwin: {
    chrome: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    comet: ['/Applications/Comet.app/Contents/MacOS/Comet'],
    chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    arc: ['/Applications/Arc.app/Contents/MacOS/Arc'],
    custom: [],
  },
  linux: {
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
    comet: [],
    chromium: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    brave: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    edge: ['/usr/bin/microsoft-edge'],
    // Arc has no Linux build (macOS + Windows only).
    arc: [],
    custom: [],
  },
  win32: {
    chrome: [
      `${WIN_PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${WIN_PROGRAMFILES_X86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${WIN_LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    comet: [
      `${WIN_PROGRAMFILES}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${WIN_PROGRAMFILES_X86}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${WIN_LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
    ],
    chromium: [
      `${WIN_LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`,
    ],
    brave: [
      `${WIN_PROGRAMFILES}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${WIN_PROGRAMFILES_X86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${WIN_LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ],
    edge: [
      `${WIN_PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${WIN_PROGRAMFILES_X86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${WIN_LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    // Arc ships a Windows build, but its install path is not yet verified here;
    // leave unlisted (undetected) rather than guess a path that false-positives.
    arc: [],
    custom: [],
  },
};


/**
 * On Debian/Ubuntu the canonical launchers under `/usr/bin`
 * (`brave-browser`, `google-chrome`, `chromium`) are not the browser ELF —
 * they're `#!/bin/bash` wrapper scripts (the upstream Chromium wrapper) that,
 * as their final step, run the real binary as a NON-exec child:
 *
 *     exec < /dev/null
 *     exec > >(exec cat)
 *     exec 2> >(exec cat >&2)
 *     "$HERE/brave" "$@" || true
 *
 * That breaks `launchBrowser`'s `--remote-debugging-pipe` transport two ways:
 * the std-fd sanitization (and the extra `cat` process-substitution children)
 * disturbs the inherited CDP pipe on fd 3/4, and the pid we record is the
 * wrapper's, not the browser's. The symptom is `read ECONNRESET` /
 * `CDP connection closed` right after spawn (issue #229).
 *
 * Follow the wrapper to the ELF it execs. The wrapper sets
 * `HERE="dirname(readlink -f "$0")"` and invokes `"$HERE/<name>"`, so we
 * resolve the script path, scan for that invocation line, and join the two.
 * Returns the original path untouched when it's already an ELF, when it's not
 * a resolvable wrapper, or on any non-Linux platform.
 */
function readsAsShebangScript(binaryPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(binaryPath, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    // ELF binaries start with 0x7f 'E'; shebang scripts with '#!'.
    return head[0] === 0x23 && head[1] === 0x21;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * True when `binaryPath` is a shebang script rather than a native browser
 * executable. The Linux distro launchers (`/usr/bin/brave-browser`, …) are such
 * scripts; `launchBrowser` can't drive one over `--remote-debugging-pipe` (see
 * resolveBrowserBinary). `profiles doctor` uses this to flag a profile whose
 * binary resolves to a wrapper we couldn't unwrap. Shebang scripts are a
 * Linux/Unix concept — returns false on Windows/macOS app bundles.
 */
export function isLauncherScript(binaryPath: string): boolean {
  if (os.platform() === 'win32') return false;
  return readsAsShebangScript(binaryPath);
}

export function resolveBrowserBinary(binaryPath: string): string {
  if (os.platform() !== 'linux') return binaryPath;
  // Only shebang scripts need unwrapping; a real ELF passes straight through.
  if (!readsAsShebangScript(binaryPath)) return binaryPath;

  let script: string;
  let realScriptPath: string;
  try {
    realScriptPath = fs.realpathSync(binaryPath);
    script = fs.readFileSync(realScriptPath, 'utf8');
  } catch {
    return binaryPath;
  }
  // Match the Chromium wrapper's launch line: `"$HERE/<name>" "$@"`, optionally
  // prefixed with `exec -a "$0"`. The captured name is the real ELF, sitting in
  // the same directory as the resolved wrapper.
  const match = script.match(/"\$HERE\/([A-Za-z0-9._-]+)"\s+"\$@"/);
  if (!match) return binaryPath;
  const realBinary = path.join(path.dirname(realScriptPath), match[1]);
  return fs.existsSync(realBinary) ? realBinary : binaryPath;
}

export function findBrowserPath(browserType: BrowserType, customBinary?: string): string {
  if (customBinary) {
    if (!fs.existsSync(customBinary)) {
      throw new Error(`Custom binary not found: ${customBinary}`);
    }
    return resolveBrowserBinary(customBinary);
  }

  if (browserType === 'custom') {
    throw new Error('browser: custom requires a binary path in the profile');
  }

  const platform = os.platform();
  const platformPaths = BROWSER_PATHS[platform];
  if (!platformPaths) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const candidates = platformPaths[browserType] || [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return resolveBrowserBinary(p);
    }
  }

  if (browserType === 'comet' && platform === 'linux') {
    throw new Error('Browser "comet" is not available on Linux (Comet ships macOS and Windows builds only). Use chrome, chromium, brave, or edge on this platform.');
  }
  if (browserType === 'arc' && platform === 'linux') {
    throw new Error('Browser "arc" is not available on Linux (Arc ships macOS and Windows builds only). Use chrome, chromium, brave, or edge on this platform.');
  }
  throw new Error(`Browser "${browserType}" not found. Install it first.`);
}

// Per-platform Chromium-family priority list for "no --profile" auto-pick.
// Order is: most-likely-installed-and-stable first. Safari and Firefox are
// intentionally excluded — they don't speak the Chrome DevTools Protocol the
// way cdp.ts expects, so they'd need separate drivers.
const DEFAULT_BROWSER_PRIORITY: Record<string, BrowserType[]> = {
  // macOS: Chrome leads (>70% of dev machines), then the rest of the family.
  // Arc is last: it's in maintenance mode and needs a blank tab to drive, so it
  // shouldn't win auto-pick over a mainstream browser.
  darwin: ['chrome', 'brave', 'edge', 'chromium', 'comet', 'arc'],
  // Linux: Chrome/Chromium first (apt/snap), then Brave/Edge if present.
  linux: ['chrome', 'chromium', 'brave', 'edge'],
  // Windows: Edge is preinstalled on every supported build, so it's the
  // reliable always-there default.
  win32: ['edge', 'chrome', 'brave', 'comet'],
};

/**
 * Walk the per-platform priority list and return the first browser that's
 * actually installed on disk. Returns null if none of them are present.
 *
 * This is the auto-pick the `agents browser start` command uses when the user
 * doesn't pass `--profile`. The intent matches "use whatever's preinstalled,"
 * but constrained to Chromium-family binaries so CDP works without a new
 * driver layer.
 */
export function findFirstInstalledBrowser(
  platform: string = os.platform()
): { browserType: BrowserType; binary: string } | null {
  const priority = DEFAULT_BROWSER_PRIORITY[platform];
  if (!priority) return null;
  const platformPaths = BROWSER_PATHS[platform];
  if (!platformPaths) return null;
  for (const browserType of priority) {
    const candidates = platformPaths[browserType] || [];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        return { browserType, binary: resolveBrowserBinary(p) };
      }
    }
  }
  return null;
}

/**
 * List every installed Chromium-family browser on this machine, in the platform
 * priority order. Used by `agents setup browser` to offer a pick when more than
 * one is present. Returns [] if none are installed.
 */
export function listInstalledBrowsers(
  platform: string = os.platform()
): { browserType: BrowserType; binary: string }[] {
  const priority = DEFAULT_BROWSER_PRIORITY[platform];
  const platformPaths = BROWSER_PATHS[platform];
  if (!priority || !platformPaths) return [];
  const found: { browserType: BrowserType; binary: string }[] = [];
  for (const browserType of priority) {
    const candidates = platformPaths[browserType] || [];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        found.push({ browserType, binary: resolveBrowserBinary(p) });
        break; // one install path per browser type is enough
      }
    }
  }
  return found;
}

export interface LaunchResult {
  pid: number;
  port: number;
  wsUrl: string;
}

/**
 * Resolve a browser-profile secrets bundle into an env map for the child, or an
 * EMPTY map when the bundle is absent, locked, or otherwise unreadable — never a
 * throw and never a prompt. Injecting profile secrets on launch is a BACKGROUND
 * read (the agent is spawning the browser, not a human at a Touch ID sheet), so
 * the read is `agentOnly` (SEC-13: never pop biometry on its own): a `never`/no-ACL
 * or broker-held bundle resolves silently; a locked `hold`/`always` bundle throws,
 * and we swallow it so the launch proceeds without those secrets (an agent that
 * needs them can `agents secrets unlock <bundle>`). Exported so the no-prompt
 * behavior is testable on the real keychain path without spawning a browser.
 */
export async function resolveProfileSecretsEnv(secrets?: string): Promise<Record<string, string>> {
  if (!secrets || !(await bundleExists(secrets))) return {};
  try {
    const { env } = await readAndResolveBundleEnv(secrets, { caller: 'browser profile', agentOnly: true });
    return env;
  } catch {
    // Bundle locked or failed to resolve — launch without secrets (no prompt).
    return {};
  }
}

export async function launchBrowser(
  profileName: string,
  browserType: BrowserType,
  port: number,
  options: ChromeOptions = {},
  secrets?: string,
  customBinary?: string,
  // `electron: true` distinguishes Notion / VS Code-style apps from
  // regular Chrome — purely informational, stored in meta.json so the
  // orphan reaper and `agents browser status` can label processes.
  isElectron: boolean = false
): Promise<LaunchResult> {
  const browserPath = findBrowserPath(browserType, customBinary);

  // A profile discovered from the browser's OWN store (PHNX-4042) launches on
  // that store — the owner's real user-data dir and profile directory — so the
  // window agents open is the window the owner uses. Its Preferences are the
  // owner's and are never rewritten. Anything else runs under a managed dir.
  const ownerStore = options.userDataDir !== undefined;
  const runtimeDir = getProfileRuntimeDir(profileName);
  const userDataDir = options.userDataDir ?? path.join(runtimeDir, 'chrome-data');
  if (!ownerStore) {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Pre-launch Preferences pass: first-launch profile-name stamp, plus (for
    // real browsers, not Electron apps) the session-cookie persistence pin.
    // Electron apps manage their own storage and don't read Chromium's
    // `session.*` prefs, so they get the name stamp only.
    ensureProfilePreferences(userDataDir, profileName, !isElectron);
  }
  // The owner's store is attached over a TCP port rather than the daemon's
  // private pipe: the instance outlives any one daemon and must stay reachable
  // (and verifiable by the ownership guard) after a daemon restart.
  const transport: 'pipe' | 'port' = ownerStore ? 'port' : 'pipe';

  // Chromium on macOS coordinates instances via the SingletonLock file
  // *inside* each user-data-dir. Direct binary spawn with a fresh
  // --user-data-dir creates a fully independent process — the user's
  // normal browser (running under their default user-data-dir) and our
  // sandboxed one coexist as two real processes.
  //
  // These are TWO dock tiles, not one. Measured on macOS 26 (zion, 2026-09-04):
  // a second Comet spawned this way registers its OWN LaunchServices ASN, so
  // `lsappinfo list` reports two `ai.perplexity.comet` entries and the Dock shows
  // two Comet icons — one of them the logged-out sandbox. The Dock does NOT
  // collapse same-bundle processes into one tile. Spawning a rival window is
  // exactly the failure PHNX-3967 set out to end, which is why an attach-only
  // profile never reaches this launcher (see connectLocal / isAttachOnlyProfile).

  const viewport = options.viewport ?? { width: 1512, height: 982 };
  const args = [
    transport === 'pipe' ? '--remote-debugging-pipe' : `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    ...(options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : []),
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // First-run + default-browser modals block automation: when targetFilter
    // matches by URL, the onboarding page (`chrome://welcome/`) isn't a
    // match and start fails with "no page target". Suppress them.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DefaultBrowserSetting,ChromeWhatsNewUI',
    '--disable-crash-reporter',
    // Suppress navigator.webdriver = true, which Chromium sets whenever a
    // remote-debugging transport is active. That property is the loudest
    // signal Cloudflare Turnstile, hCaptcha, and similar checks read.
    '--disable-blink-features=AutomationControlled',
    // Companion to `session.restore_on_startup: 1` (see
    // ensureProfilePreferences): the pref keeps session cookies alive across
    // restarts, but on its own it would also reopen last session's tabs at
    // startup. Suppressing the startup window leaves restore nothing to fill —
    // cookies survive, no ghost tabs — and the task flow creates its own tab
    // over CDP anyway. Electron apps need their window to appear (the CDP
    // driver binds to it), so they skip the flag.
    ...(isElectron || ownerStore ? [] : ['--no-startup-window']),
    ...(options.headless ? ['--headless=new'] : []),
    `--window-size=${viewport.width},${viewport.height}`,
    ...(viewport.x !== undefined && viewport.y !== undefined
      ? [`--window-position=${viewport.x},${viewport.y}`]
      : []),
    ...(options.args || []),
  ];

  // Profile secrets: agentOnly (SEC-13) — a locked bundle resolves to an empty map
  // (launch proceeds without them), never a Touch ID prompt. See resolveProfileSecretsEnv.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(await resolveProfileSecretsEnv(secrets)) };

  const child = spawn(browserPath, args, {
    detached: true,
    stdio: transport === 'pipe' ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    env,
  });
  child.unref();
  child.stdout?.resume();
  child.stderr?.resume();

  const pid = child.pid!;
  let wsUrl: string;
  if (transport === 'pipe') {
    const writePipe = child.stdio[3] as Writable | null;
    const readPipe = child.stdio[4] as Readable | null;
    if (!writePipe || !readPipe) {
      throw new Error('Chrome failed to expose CDP pipe file descriptors');
    }
    wsUrl = registerPipeTransport({ read: readPipe, write: writePipe });
  } else {
    wsUrl = (await waitForDevToolsPort(port, profileName, pid)).wsUrl;
  }

  writeProfileRuntime(profileName, {
    pid,
    command: path.basename(browserPath),
    userDataDir,
    kind: isElectron ? 'electron' : 'browser',
  });

  return { pid, port: transport === 'pipe' ? 0 : port, wsUrl };
}

/**
 * Poll the DevTools endpoint of a browser just launched with
 * `--remote-debugging-port` until it answers, or fail loud naming the pid.
 * Chromium binds the port only after its profile has loaded, which on a real
 * signed-in store takes a few seconds.
 */
async function waitForDevToolsPort(
  port: number,
  profileName: string,
  pid: number,
  timeoutMs = 20_000,
): Promise<BrowserDiscovery> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      return await discoverBrowserWsUrl(port, 'localhost', profileName);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Browser for profile "${profileName}" (pid ${pid}) did not serve the DevTools protocol on ` +
      `port ${port} within ${Math.round(timeoutMs / 1000)}s: ${lastError}`,
  );
}

export async function attachToChrome(port: number): Promise<string> {
  const { wsUrl } = await discoverBrowserWsUrl(port);
  return wsUrl;
}

export function killChrome(pid: number): void {
  if (process.platform === 'win32') {
    // On Windows `process.kill(pid, 'SIGINT')` maps to TerminateProcess — a
    // hard kill that skips Chromium's on-exit profile flush (leaving a dirty
    // "Chrome didn't shut down correctly" state). Ask taskkill for a graceful
    // stop first (no /F → posts WM_CLOSE), and only force-kill the tree if that
    // fails or the process is still around.
    try {
      execFileSync('taskkill', ['/pid', String(pid)], { stdio: 'ignore', windowsHide: true });
    } catch {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      } catch {
        // Process already dead
      }
    }
    return;
  }
  try {
    process.kill(pid, 'SIGINT');
  } catch {
    // Process already dead
  }
}

export function getRunningChromeInfo(
  profileName: string
): { pid: number; port: number } | null {
  // Delegate to runtime-state, which auto-cleans stale files and verifies
  // the live pid still runs the command we recorded — so a recycled pid
  // doesn't masquerade as our browser.
  const rt = readProfileRuntime(profileName);
  if (!rt) return null;
  if (rt.port === undefined) return null;
  return { pid: rt.pid, port: rt.port };
}

/**
 * Prepare `<userDataDir>/Default/Preferences` before launch.
 *
 * Two concerns, one write:
 *  - First launch (file absent): stamp the agents-cli profile name so
 *    Chromium's UI shows "<profile>" instead of its default "Person 1".
 *    Cosmetic; existing files keep whatever Chrome wrote in the meantime.
 *  - Every launch (when `persistSessionCookies`): pin
 *    `session.restore_on_startup: 1` ("continue where you left off").
 *    Chromium purges memory-only session cookies at startup UNLESS this
 *    preference says the session will be restored — it keys the purge off
 *    the pref, not off tabs actually reopening. Sites like idealista issue
 *    login cookies with `expires=-1`, so without this every browser restart
 *    silently logs the profile out. The visible tab-restore side effect is
 *    suppressed separately via `--no-startup-window` (see launchBrowser).
 *
 * Runs only while the browser is down (called before spawn), so Chromium
 * can't overwrite the patch on exit. Best-effort: a malformed existing file
 * is left untouched (Chromium recovers its own state better than we can),
 * and any I/O hiccup is silently ignored.
 */
export function ensureProfilePreferences(
  userDataDir: string,
  profileName: string,
  persistSessionCookies: boolean
): void {
  const defaultDir = path.join(userDataDir, 'Default');
  const prefsPath = path.join(defaultDir, 'Preferences');

  let prefs: Record<string, any> | undefined;
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    if (typeof prefs !== 'object' || prefs === null) return; // not ours to fix
  } catch (err: any) {
    if (err?.code !== 'ENOENT') return; // unreadable/malformed: leave alone
  }

  const firstLaunch = prefs === undefined;
  if (firstLaunch) prefs = { profile: { name: profileName } };

  let dirty = firstLaunch;
  if (persistSessionCookies && prefs!.session?.restore_on_startup !== 1) {
    prefs!.session = { ...prefs!.session, restore_on_startup: 1 };
    dirty = true;
  }
  if (!dirty) return;

  try {
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch { /* not critical */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is a TCP port currently bound? `lsof` on POSIX, `netstat -ano` on Windows
 * (lsof doesn't exist there). Returns false on any tooling error so port
 * allocation degrades to "assume free" rather than throwing.
 *
 * Exported as the canonical cross-platform probe — `findFreeProfilePort`
 * (profiles.ts) must use this rather than shelling out to lsof directly,
 * or every port scans as free on Windows.
 */
export function isPortInUse(port: number): boolean {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      // Lines look like: "  TCP    0.0.0.0:9200    0.0.0.0:0    LISTENING    1234"
      return out.split('\n').some((line) => {
        const f = line.trim().split(/\s+/);
        return f[0] === 'TCP' && f[3] === 'LISTENING' && !!f[1]?.endsWith(`:${port}`);
      });
    } catch {
      return false;
    }
  }
  try {
    execFileSync('lsof', ['-i', `:${port}`], { stdio: 'ignore' });
    return true; // lsof found a binding
  } catch {
    return false; // nothing on the port
  }
}

export function allocatePort(): number {
  const base = 9200;
  const max = 9300;

  for (let port = base; port < max; port++) {
    if (!isPortInUse(port)) {
      return port;
    }
  }

  throw new Error('No available ports in range 9200-9300');
}

/**
 * Read the `--user-data-dir` a running browser process was launched with, by
 * inspecting its command line (PHNX-3967). This is the ownership signal the
 * attach-only guard uses to tell the credentialed canonical browser apart from a
 * foreign port-squatter serving CDP on the same port (e.g. a logged-out
 * `/tmp/...` Comet). Returns null when the pid is gone, exposes no
 * `--user-data-dir`, or the platform probe fails.
 *
 * POSIX: `ps -ww -o command=` (full, un-truncated argv). Windows: the
 * `CommandLine` from `Win32_Process` via PowerShell. The value is captured up to
 * the next ` --<flag>` (or end of line) so a data dir that itself contains a
 * space is not truncated at the space.
 */
export function getProcessUserDataDir(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  let cmdline = '';
  try {
    if (process.platform === 'win32') {
      cmdline = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } else {
      cmdline = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }
  } catch {
    return null;
  }
  return parseUserDataDirFromCommandLine(cmdline);
}

/**
 * Extract the `--user-data-dir` value from a browser command line. Handles both
 * `--user-data-dir=<path>` and `--user-data-dir <path>` and stops the value at
 * the next ` --<flag>` so a path containing spaces survives. Exported for unit
 * testing without a live process.
 */
export function parseUserDataDirFromCommandLine(cmdline: string): string | null {
  const line = cmdline.replace(/\r?\n/g, ' ').trim();
  const m = line.match(/--user-data-dir[=\s]+(.*?)(?=\s--[A-Za-z]|$)/);
  if (!m) return null;
  const value = m[1].trim().replace(/^["']|["']$/g, '');
  return value.length > 0 ? value : null;
}

export interface PortOccupant {
  pid: number;
  command: string;
}

/**
 * Identify the process listening on a TCP port. Returns null when nothing is bound.
 * Used for clearer error messages when a profile's configured port is taken by a
 * non-debug process (e.g. Comet running without --remote-debugging-port).
 * `lsof` on POSIX; `netstat -ano` + `tasklist` on Windows.
 */
export function getPortOccupant(port: number): PortOccupant | null {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let pid = 0;
      for (const line of out.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f[0] === 'TCP' && f[3] === 'LISTENING' && f[1]?.endsWith(`:${port}`)) {
          pid = parseInt(f[4], 10) || 0;
          break;
        }
      }
      if (!pid) return null;
      let command = 'unknown';
      try {
        // tasklist CSV row: "image.exe","1234","Console","1","12,345 K"
        const tl = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const m = tl.match(/^"([^"]+)"/);
        if (m) command = m[1];
      } catch { /* keep 'unknown' */ }
      return { pid, command };
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pid = 0;
    let command = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = parseInt(line.slice(1), 10) || 0;
      else if (line.startsWith('c') && !command) command = line.slice(1);
    }
    if (!pid) return null;
    return { pid, command: command || 'unknown' };
  } catch {
    return null;
  }
}
