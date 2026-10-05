// Opening follows configured viewer policy; detached spawn races spawn/error, and browser failure falls back visibly to the OS.
import { spawn } from 'child_process';
import * as path from 'path';
import { pathToFileURL } from 'url';

type ShowOutcome =
  | { via: 'profile'; profile: string; tabId?: string }
  | { via: 'os'; command: string }
  | { via: 'none'; reason: string };

interface ShowOptions {
  osBrowser?: boolean;
  profile?: string;
  spawnOpen?: (cmd: string, args: string[]) => boolean;
}

const BROWSER_RENDERABLE = new Set(['.html', '.htm', '.svg', '.xhtml']);

async function osOpen(
  target: string,
  spawnOpen?: (cmd: string, args: string[]) => boolean,
): Promise<ShowOutcome> {
  const candidates: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [target]]]
      : process.platform === 'win32'
        ?
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

export async function resolveViewer(opts: ShowOptions = {}): Promise<'os' | { profile: string }> {
  if (opts.osBrowser) return 'os';

  const { getConfigValue } = await import('./device-config.js');
  const name =
    opts.profile
    ?? ((getConfigValue('browser.viewer').value as string | undefined) || undefined)
    ?? ((getConfigValue('browser.profile').value as string | undefined) || undefined);

  if (!name || name === 'os') return 'os';
  return { profile: name };
}

export async function showUrl(url: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  const viewer = await resolveViewer(opts);
  if (viewer === 'os') return osOpen(url, opts.spawnOpen);

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

export async function showFile(filePath: string, opts: ShowOptions = {}): Promise<ShowOutcome> {
  if (!BROWSER_RENDERABLE.has(path.extname(filePath).toLowerCase())) {
    return osOpen(filePath, opts.spawnOpen);
  }
  return showUrl(pathToFileURL(filePath).href, opts);
}
