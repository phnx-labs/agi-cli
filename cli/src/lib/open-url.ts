/**
 * The one place that decides WHERE a URL or file is shown to the human.
 *
 * Two browsers exist on a machine like this: the OS default handler, and the
 * profile `agents browser` drives. They are not interchangeable. The configured
 * profile is where the fleet's logins accumulate — `agents browser profiles
 * logins` lists them — so a page opened there is a page the user is already
 * signed in for, and a login acquired there is inherited by every later agent.
 * The OS handler has none of that.
 *
 * Before this seam existed, `agents browser navigate` honoured the configured
 * profile and nothing else did: `devices lease`, `feedback`, and
 * the browser-session artifact opener each shelled straight to `open`/`xdg-open`,
 * so every one of them landed in whatever the OS handler happened to be. This
 * module replaces all of those call sites; do not add a new raw `open`.
 *
 * Never throws. A viewer that cannot be reached degrades to the OS handler with
 * one stderr line naming the reason, and a total failure returns `via: 'none'`
 * so the caller can print the URL rather than silently doing nothing.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** Where a "show the human this" call actually landed. */
type ShowOutcome =
  | { via: 'profile'; profile: string; tabId?: string }
  | { via: 'os'; command: string }
  | { via: 'none'; reason: string };

interface ShowOptions {
  /**
   * Force the OS default handler, ignoring `browser.viewer`. This is the
   * The programmatic escape hatch, for a caller that must use the user's own
   * browser regardless of configuration. There is deliberately no CLI flag for
   * it: `agents config set browser.viewer os` is the user-facing control.
   */
  osBrowser?: boolean;
  /** Explicit profile override, ahead of `browser.viewer`. */
  profile?: string;
  /** Injected opener so the OS branch is testable without spawning anything. */
  spawnOpen?: (cmd: string, args: string[]) => boolean;
}

/**
 * Extensions a CDP tab renders at least as well as the OS default app.
 *
 * Deliberately narrow. `sessions-list.ts` EXT_KIND covers .png/.jpg/.webp/.pdf/
 * .webm, and for those Preview and QuickTime are the better viewer — routing a
 * screenshot into a browser tab is a downgrade, not a fix.
 */
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

/**
 * Launch a detached opener and report whether it actually started.
 *
 * Detection without blocking, which is the whole trick here. A bare detached
 * `spawn` cannot tell success from "xdg-open is not installed" — it does not
 * throw for a missing binary, it emits `error` asynchronously — so the failure
 * branches of every caller were dead. But `spawnSync` is not the answer either:
 * it waits for the child's whole lifetime, and `devices lease` opens a console
 * and then immediately prompts for a pasted key, so a blocking open would stall
 * that prompt behind the browser.
 *
 * Racing `spawn` against `error` gives both: Node emits `spawn` as soon as the
 * child is successfully created (measured: 1ms, and it does NOT wait for exit),
 * and `error` for ENOENT. We unref on success so the opener outlives us.
 */
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

/**
 * Decide the viewer for this call. Exported for its own test — this is the one
 * place the policy lives.
 *
 * Every fall back to the OS handler prints one stderr line naming why. A silent
 * downgrade here is what made the original bug invisible for so long: the user
 * had configured a profile and had no way to see that it was being ignored.
 */
export async function resolveViewer(opts: ShowOptions = {}): Promise<'os' | { profile: string }> {
  if (opts.osBrowser) return 'os';

  const { getConfigValue } = await import('./device-config.js');
  // A configured viewer, else the profile agents drive (`browser.profile`) — the
  // whole point is that a machine with a configured browser stops leaking pages
  // to the OS handler. Both keys are shared with the standalone `browser` CLI,
  // whose `show` verb applies exactly this precedence itself; agents-cli resolves
  // the NAME only to decide viewer-vs-OS, then delegates suitability (Arc/Firefox/
  // launchable-here) to the engine (PHNX-4101).
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

  // Delegate to the standalone `browser show`, which opens the URL in the viewer
  // profile (or `browser.viewer`/`browser.profile`) and owns its own service
  // lifecycle and viewer-suitability fallbacks. When the engine is not installed,
  // or the call fails, degrade to the OS handler with one stderr line.
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

/**
 * Show a local file. Browser-renderable kinds go through {@link showUrl}; every
 * other kind goes to the OS default APP, which for a screenshot or a recording
 * is the right viewer.
 */
export async function showFile(filePath: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  if (!BROWSER_RENDERABLE.has(path.extname(filePath).toLowerCase())) {
    return osOpen(filePath, opts.spawnOpen);
  }
  return showUrl(pathToFileURL(filePath).href, opts);
}
