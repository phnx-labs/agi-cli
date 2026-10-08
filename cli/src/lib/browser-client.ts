
import { spawn } from 'node:child_process';
import { realpathSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { findInPath } from './agent-spec/agents.js';

const INSTALL_HINT = 'npm i -g @phnx-labs/browser-cli';

export const BROWSER_CONTEXT_FD = 3;

export class BrowserClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BrowserClientError';
  }
}

export function isBrowserClientError(err: unknown): err is BrowserClientError {
  return err instanceof BrowserClientError;
}

let cachedBin: string | undefined;

function browserEntrypoint(bin: string): string {
  if (!/\.(cmd|ps1)$/i.test(bin)) return bin;
  const launcher = path.join(path.dirname(bin), 'node_modules', '@phnx-labs', 'browser-cli', 'bin', 'browser.cjs');
  return existsSync(launcher) ? launcher : bin;
}

export function isStandaloneBrowser(bin: string): boolean {
  let real = browserEntrypoint(bin);
  try { real = realpathSync(real); } catch {  }
  return !/\.(cmd|ps1)$/i.test(real) && !real.endsWith(path.join('dist', 'browser.js'));
}

export function resolveBrowserBin(): string {
  if (cachedBin) return cachedBin;
  const explicit = process.env.BROWSER_BIN?.trim();
  const resolved = explicit && explicit.length > 0 ? (isStandaloneBrowser(explicit) ? explicit : null) : findInPath('browser', { accept: isStandaloneBrowser });
  if (!resolved) {
    throw new BrowserClientError(
      'BROWSER_BIN_MISSING',
      'The standalone `browser` CLI was not found. Install it with:\n' +
        `  ${INSTALL_HINT}\n` +
        'or run `agents setup browser` / `agents clis install browser`, or point $BROWSER_BIN at its executable.',
    );
  }
  cachedBin = browserEntrypoint(resolved);
  return cachedBin;
}

export function browserInstalled(): boolean {
  try {
    resolveBrowserBin();
    return true;
  } catch {
    return false;
  }
}

export function invocation(bin: string): { command: string; prefix: string[] } {
  if (/\.[mc]?js$/.test(bin)) return { command: process.execPath, prefix: [bin] };
  return { command: bin, prefix: [] };
}

interface RunBrowserOptions {
  argv: string[];
  context: unknown;
  capture?: boolean;
}

interface RunBrowserResult {
  exitCode: number;
  stdout: string;
}

export async function runBrowser(opts: RunBrowserOptions): Promise<RunBrowserResult> {
  const bin = resolveBrowserBin();
  const { command, prefix } = invocation(bin);

  const child = spawn(command, [...prefix, ...opts.argv], {
    stdio: ['inherit', opts.capture ? 'pipe' : 'inherit', 'inherit', 'pipe'],
    env: {
      ...process.env,
      BROWSER_CONTEXT_FD: String(BROWSER_CONTEXT_FD),
    },
  });

  const contextPipe = child.stdio[BROWSER_CONTEXT_FD] as NodeJS.WritableStream | null;

  if (contextPipe) {
    contextPipe.on('error', () => {});
    contextPipe.end(JSON.stringify(opts.context) + '\n');
  }

  let stdout = '';
  if (opts.capture && child.stdout) {
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      reject(new BrowserClientError('BROWSER_SPAWN_FAILED', `Could not run \`${bin}\`: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      if (code == null) return resolve(signal ? 128 + (osSignalNumber(signal) ?? 0) : 1);
      resolve(code);
    });
  });

  return { exitCode, stdout };
}

function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGPIPE: 13, SIGTERM: 15,
  };
  return table[signal];
}

export function _resetBrowserClientForTest(): void {
  cachedBin = undefined;
}
