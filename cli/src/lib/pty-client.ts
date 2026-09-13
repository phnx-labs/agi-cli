/**
 * PTY Client
 *
 * Thin client that connects to the PTY sidecar server over unix socket.
 * Each call opens a connection, sends a JSON request, reads the JSON response, and closes.
 */

import * as net from 'net';
import * as fs from 'fs';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { getSocketPath, getPtyPidPath, getPtyLogPath, isPtyServerRunning } from './pty-server.js';
import { backgroundSpawnOptions } from './platform/process.js';
import { BUN_VIRTUAL_ROOT } from './cli-entry.js';

const CONNECT_TIMEOUT_MS = 5000;
const RESPONSE_TIMEOUT_MS = 30000;
const START_TIMEOUT_MS = 5000;
const IS_WINDOWS = process.platform === 'win32';

interface ServerSpawnArgs {
  bin: string;
  args: string[];
}

interface ServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** JSON response envelope from the PTY server. */
interface PtyResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Send a request to the PTY server and return the response.
 * Auto-starts the server if not running.
 */
export async function ptyRequest(action: string, id?: string, params?: Record<string, any>): Promise<PtyResponse> {
  await ensureServer();

  const req: any = { action };
  if (id) req.id = id;
  if (params) req.params = params;

  return sendRequest(req);
}

/**
 * Ensure the PTY server is running. Start it if not.
 */
async function ensureServer(): Promise<void> {
  if (isPtyServerRunning()) return;

  // Find the entry point to spawn the server
  const { bin, args } = getServerSpawnArgs();

  const logPath = getPtyLogPath();
  let logFd: number;
  try {
    logFd = fs.openSync(logPath, 'a');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error([
      'PTY server failed to start before spawning.',
      `Spawned: ${formatCommand({ bin, args })}`,
      `Log: ${logPath}`,
      `Log open error: ${message}`,
    ].join('\n'));
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(bin, args, {
      stdio: ['ignore', logFd, logFd],
      ...backgroundSpawnOptions({ fdStdio: true }),
    });
  } finally {
    fs.closeSync(logFd);
  }
  let childExit: ServerExit | undefined;
  let childError: Error | undefined;
  let lastReadinessError: Error | undefined;

  child.once('exit', (code, signal) => {
    childExit = { code, signal };
  });
  child.once('error', (err) => {
    childError = err;
  });
  child.unref();

  // Wait for the server to become reachable. On Unix the socket file appearing is
  // a cheap readiness signal; on Windows the named pipe is not a filesystem object
  // (fs.existsSync always returns false), so we just attempt the ping directly.
  const socketPath = getSocketPath();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (IS_WINDOWS || fs.existsSync(socketPath)) {
      // Verify we can connect
      try {
        await sendRequest({ action: 'ping' });
        return;
      } catch (err) {
        lastReadinessError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (childError || childExit) break;
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error(buildPtyStartFailureMessage({
    timeoutMs: START_TIMEOUT_MS,
    spawn: { bin, args },
    exit: childExit,
    spawnError: childError,
    lastReadinessError,
    logPath,
  }));
}

export function getServerSpawnArgs(
  options: {
    isStandaloneExecutable?: boolean;
    /** Physical binary path (test seam). Defaults to `process.execPath`. */
    execPath?: string;
    /** Locate a real `node` (test seam). Defaults to `which/where node`. */
    resolveNode?: () => string | undefined;
    /** File-existence check (test seam). Defaults to `fs.existsSync`. */
    fileExists?: (p: string) => boolean;
  } = {},
): ServerSpawnArgs {
  const isStandaloneExecutable = options.isStandaloneExecutable
    ?? isBunStandaloneExecutable();
  if (isStandaloneExecutable) {
    // A Bun `--compile` standalone binary cannot `require()` a native addon, so
    // running the PTY sidecar AS this binary fails to load node-pty's pty.node
    // (fatal on macOS; see #315). Prefer a real `node` running the dist/index.js
    // that ships beside the binary — there node-pty loads from the on-disk
    // prebuild. We can't do `<binary> dist/index.js` (the standalone misparses a
    // script arg as a subcommand), so a genuine `node` is required. Fall back to
    // the binary itself only when no node / no dist is found (a bare standalone
    // install with no Node — PTY may then be unavailable, but nothing else can
    // load the addon anyway).
    const node = (options.resolveNode ?? resolveNodeExecutable)();
    const exists = options.fileExists ?? fs.existsSync;
    const execPath = options.execPath ?? process.execPath;
    if (node) {
      try {
        const distIndex = path.join(path.dirname(execPath), '..', 'index.js');
        if (exists(distIndex)) {
          return { bin: node, args: [distIndex, 'pty', '_server'] };
        }
      } catch {}
    }
    return { bin: process.execPath, args: ['pty', '_server'] };
  }

  // Prefer the dist/index.js from the same installation as this code.
  // This avoids version mismatch when a globally installed `agents` is older.
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const distIndex = path.join(__dirname, '..', 'index.js');
    if (fs.existsSync(distIndex)) {
      return { bin: process.execPath, args: [distIndex, 'pty', '_server'] };
    }
  } catch {}

  // Fallback: use the globally installed agents command. `which` is Unix-only;
  // Windows uses `where`, which can return multiple lines — take the first.
  try {
    const lookup = IS_WINDOWS ? 'where agents' : 'which agents';
    const agentsBin = execSync(lookup, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (agentsBin) {
      return { bin: agentsBin, args: ['pty', '_server'] };
    }
  } catch {}

  return { bin: 'agents', args: ['pty', '_server'] };
}

export function isBunStandaloneExecutable(moduleUrl: string = import.meta.url): boolean {
  return BUN_VIRTUAL_ROOT.test(moduleUrl);
}

/**
 * Locate a real `node` on PATH for running the sidecar's dist/index.js from a
 * Bun standalone binary (which cannot itself load native addons). Returns
 * undefined when no node is found — the caller then falls back to the binary.
 */
function resolveNodeExecutable(): string | undefined {
  try {
    const lookup = IS_WINDOWS ? 'where node' : 'which node';
    const node = execSync(lookup, { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (node && fs.existsSync(node)) return node;
  } catch {}
  return undefined;
}

export function readRecentLogLines(logPath: string, maxLines = 20): string[] {
  try {
    if (!fs.existsSync(logPath)) return [];
    return fs.readFileSync(logPath, 'utf-8')
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .slice(-maxLines);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`Unable to read PTY server log: ${message}`];
  }
}

export function buildPtyStartFailureMessage(details: {
  timeoutMs: number;
  spawn: ServerSpawnArgs;
  exit?: ServerExit;
  spawnError?: Error;
  lastReadinessError?: Error;
  logPath: string;
}): string {
  const lines = [
    `PTY server failed to start within ${Math.round(details.timeoutMs / 1000)} seconds.`,
    `Spawned: ${formatCommand(details.spawn)}`,
  ];
  if (details.spawnError) {
    lines.push(`Spawn error: ${details.spawnError.message}`);
  }
  if (details.exit) {
    const reason = details.exit.signal
      ? `signal ${details.exit.signal}`
      : `code ${details.exit.code ?? 'unknown'}`;
    lines.push(`PTY server process exited with ${reason} before listening.`);
  }
  if (details.lastReadinessError) {
    lines.push(`Last readiness error: ${details.lastReadinessError.message}`);
  }
  lines.push(`Log: ${details.logPath}`);

  const logLines = readRecentLogLines(details.logPath);
  if (logLines.length > 0) {
    lines.push('Recent PTY server log:');
    lines.push(...logLines.map(line => `  ${line}`));
  } else {
    lines.push('No PTY server log output was written.');
  }

  return lines.join('\n');
}

function formatCommand(spawnArgs: ServerSpawnArgs): string {
  return [spawnArgs.bin, ...spawnArgs.args].map((part) => JSON.stringify(part)).join(' ');
}

/**
 * Send a JSON request over the unix socket and return the parsed response.
 */
function sendRequest(req: any): Promise<PtyResponse> {
  return new Promise((resolve, reject) => {
    const socketPath = getSocketPath();

    // On Unix a missing socket file means the server isn't up — fail fast with a
    // clear message. On Windows the named pipe isn't a filesystem object, so we
    // skip the probe and let createConnection surface ENOENT/connection errors.
    if (!IS_WINDOWS && !fs.existsSync(socketPath)) {
      reject(new Error('PTY server socket not found. Is the server running?'));
      return;
    }

    const conn = net.createConnection({ path: socketPath });
    let data = '';
    let settled = false;

    const connectTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error('Connection to PTY server timed out'));
      }
    }, CONNECT_TIMEOUT_MS);

    const responseTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        reject(new Error('PTY server response timed out'));
      }
    }, RESPONSE_TIMEOUT_MS);

    conn.on('connect', () => {
      clearTimeout(connectTimeout);
      conn.write(JSON.stringify(req) + '\n');
    });

    conn.on('data', (chunk) => {
      data += chunk.toString();
      const nlIndex = data.indexOf('\n');
      if (nlIndex !== -1) {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          clearTimeout(responseTimeout);
          try {
            resolve(JSON.parse(data.slice(0, nlIndex)));
          } catch (err) {
            reject(new Error(`Invalid JSON from PTY server: ${data.slice(0, 200)}`));
          }
        }
        conn.end();
      }
    });

    conn.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(responseTimeout);
        reject(new Error(`PTY server connection error: ${err.message}`));
      }
    });

    conn.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        clearTimeout(responseTimeout);
        if (data.trim()) {
          try {
            resolve(JSON.parse(data.trim()));
          } catch {
            reject(new Error('PTY server closed connection with invalid response'));
          }
        } else {
          reject(new Error('PTY server closed connection without response'));
        }
      }
    });
  });
}

/**
 * Parse escape sequences in user input strings.
 * Handles: \n \r \t \e \xHH \\
 */
export function unescapeInput(input: string): string {
  return input.replace(/\\(n|r|t|e|\\|x[0-9a-fA-F]{2})/g, (match, seq) => {
    switch (seq) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'e': return '\x1b';
      case '\\': return '\\';
      default:
        // \xHH
        if (seq.startsWith('x')) {
          return String.fromCharCode(parseInt(seq.slice(1), 16));
        }
        return match;
    }
  });
}
