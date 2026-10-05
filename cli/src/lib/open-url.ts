/** The one place deciding WHERE a URL or file is shown to the human. The configured `agents
 * browser` profile holds the fleet's logins; the OS handler has none. Don't add a raw `open`.
 * Never throws: failures degrade to the OS handler (one stderr line), else `via: 'none'`. */
import { spawn } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** Where a "show the human this" call actually landed. */
type ShowOutcome =
  | { via: 'profile'; profile: string; tabId?: string }
  | { via: 'os'; command: string }
  | { via: 'none'; reason: string };

interface ShowOptions {
  /** Force the OS default handler, ignoring `browser.viewer`: a programmatic escape hatch for
   * callers that must use the user's own browser. No CLI flag by design; the user control is
   * `agents config set browser.viewer os`. */
  osBrowser?: boolean;
  /** Explicit profile override, ahead of `browser.viewer`. */
  profile?: string;
  /** Injected opener so the OS branch is testable without spawning anything. */
  spawnOpen?: (cmd: string, args: string[]) => boolean;
}

/** Extensions a CDP tab renders at least as well as the OS app. Deliberately narrow: for
 * .png/.jpg/.webp/.pdf/.webm (sessions-list.ts EXT_KIND) Preview and QuickTime are better, and a
 * browser tab is a downgrade. */
const BROWSER_RENDERABLE = new Set(['.html', '.htm', '.svg', '.xhtml']);

async function osOpen(
  target: string,
  spawnOpen?: (cmd: string, args: string[]) => boolean,
): Promise<ShowOutcome> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ? // `start` treats a lone quoted first argument as the window TITLE, so the
          // empty title placeholder is required before the target. The three copies
          // of this that predated the seam disagreed on it ('' vs '""').
          [['cmd', ['/c', 'start', '', target]]]
        : [
            ['xdg-open', [target]],
            ['gnome-open', [target]],
          ];

  for (const [cmd, args] of candidates) {
    if (spawnOpen) {
      if (spawnOpen(cmd, args)) return { via: 'os', command: cmd };
      continue;
    }
    if (await trySpawn(cmd, args)) return { via: 'os', command: cmd };
  }
  return { via: 'none', reason: 'no working OS opener on this platform' };
}

/** Launches a detached opener and reports whether it started. A bare detached `spawn` can't tell
 * success from a missing `xdg-open`, but `spawnSync` would block `devices lease`'s key prompt.
 * Race `spawn` against `error` (ENOENT); unref on success so the opener outlives us. */
export function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => done(false));
      child.on('spawn', () => {
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

/** Decides the viewer for this call; the one place the policy lives (exported for its test). Every
 * fall back to the OS handler prints one stderr line naming why: a silent downgrade hid the
 * original bug, where a configured profile was ignored. */
export async function resolveViewer(opts: ShowOptions = {}): Promise<'os' | { profile: string }> {
  if (opts.osBrowser) return 'os';

  const { getConfigValue } = await import('./device-config.js');
  // A configured viewer, else the profile agents drive (`browser.profile`), so a configured
  // machine stops leaking pages to the OS handler. Keys are shared with the standalone `browser`
  // CLI; agents-cli resolves the NAME only (suitability is the engine's, PHNX-4101).
  const name =
    opts.profile
    ?? ((getConfigValue('browser.viewer').value as string | undefined) || undefined)
    ?? ((getConfigValue('browser.profile').value as string | undefined) || undefined);

  if (!name || name === 'os') return 'os';
  return { profile: name };
}

/** Show a URL to the human at this machine. Never throws. */
export async function showUrl(url: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  const viewer = await resolveViewer(opts);
  if (viewer === 'os') return osOpen(url, opts.spawnOpen);

  // Delegate to the standalone `browser show`, which opens the URL in the viewer profile and owns
  // its service lifecycle and suitability fallbacks. If the engine is missing or the call fails,
  // degrade to the OS handler with one stderr line.
  try {
    const { browserInstalled, runBrowser } = await import('./browser-client.js');
    if (!browserInstalled()) {
      console.error(`[viewer] the standalone browser CLI is not installed — using the OS browser.`);
      return osOpen(url, opts.spawnOpen);
    }
    const { buildBrowserContext } = await import('./browser/context.js');
    const { exitCode } = await runBrowser({
      argv: ['show', url, '--profile', viewer.profile],
      context: await buildBrowserContext(),
    });
    if (exitCode === 0) return { via: 'profile', profile: viewer.profile };
    console.error(`[viewer] ${viewer.profile}: browser show exited ${exitCode} — using the OS browser.`);
  } catch (err) {
    console.error(
      `[viewer] ${viewer.profile}: ${err instanceof Error ? err.message : String(err)} — using the OS browser.`,
    );
  }
  return osOpen(url, opts.spawnOpen);
}

/** Shows a local file. Browser-renderable kinds go through {@link showUrl}; others go to the OS
 * default APP, the right viewer for a screenshot or recording. */
export async function showFile(filePath: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  if (!BROWSER_RENDERABLE.has(path.extname(filePath).toLowerCase())) {
    return osOpen(filePath, opts.spawnOpen);
  }
  return showUrl(pathToFileURL(filePath).href, opts);
}
