/**
 * `term` client — thin subprocess wrapper over the standalone `term` CLI
 * (published separately as `@phnx-labs/term-cli`), the PTY engine this repo
 * used to own directly (`agents pty`, removed in PHNX-4091). `term` mirrors the
 * old `agents pty` verbs/flags/JSON shapes 1:1 (`start`, `exec`, `read`,
 * `write`, `screen`, `signal`, `resize`, `list`, `stop`, `server start|stop|
 * status`, hidden `_server`) and owns starting/reusing its own background
 * sidecar itself — this client never manages that process, it only shells out
 * to the CLI and parses one line of JSON per call.
 *
 * Resolution order:
 *   1. `$TERM_BIN` — an explicit override (a full path, or a PATH-resolvable
 *      name other than `term`). Sets the exact binary this client execs; the
 *      one legitimate use besides pointing at a real install is a test double.
 *   2. `findInPath('term')` — the ordinary PATH lookup (skips this CLI's own
 *      shims dir, same as every other native-binary resolution in this repo).
 *
 * Neither resolving is the expected state until `@phnx-labs/term-cli` is
 * published and installed — every call fails loud with
 * {@link TERM_NOT_INSTALLED_ERROR} rather than silently no-op'ing.
 */
import { execFile } from 'node:child_process';
import { findInPath } from './agent-spec/agents.js';

export const TERM_NOT_INSTALLED_ERROR =
  'The standalone `term` CLI is not installed. npm i -g @phnx-labs/term-cli';

/** JSON response envelope from `term`, mirroring the old PTY sidecar's shape. */
export interface TermResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Resolve the `term` binary to exec: `$TERM_BIN` first (exact override, used
 * by tests and by an operator pinning a specific install), else an ordinary
 * PATH lookup. Returns null when neither resolves — the caller must fail loud
 * with {@link TERM_NOT_INSTALLED_ERROR} rather than falling back to anything.
 */
export function resolveTermBin(): string | null {
  const override = process.env.TERM_BIN;
  if (override && override.trim().length > 0) return override.trim();
  return findInPath('term');
}

/** Run one `term <args>` invocation and parse the trailing JSON line from stdout. */
function runTerm(args: string[]): Promise<TermResponse> {
  return new Promise((resolve, reject) => {
    const bin = resolveTermBin();
    if (!bin) {
      reject(new Error(TERM_NOT_INSTALLED_ERROR));
      return;
    }
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      const out = stdout.toString().trim();
      if (!out) {
        reject(new Error(`term ${args[0]} produced no output: ${stderr.toString().trim() || (err ? err.message : 'unknown error')}`));
        return;
      }
      // `term` may emit progress on earlier lines; the response is the last line.
      const line = out.split('\n').pop() ?? '';
      try {
        resolve(JSON.parse(line) as TermResponse);
      } catch {
        reject(new Error(`Invalid JSON from term: ${out.slice(0, 200)}`));
      }
    });
  });
}

export interface TermStartOptions {
  rows?: number;
  cols?: number;
  shell?: string;
  cwd?: string;
}

/** `term start [-r rows] [-c cols] [-s shell] [-d cwd] --json` → the new session id. */
export function termStart(opts: TermStartOptions = {}): Promise<TermResponse> {
  const args = ['start', '--json'];
  if (opts.rows) args.push('-r', String(opts.rows));
  if (opts.cols) args.push('-c', String(opts.cols));
  if (opts.shell) args.push('-s', opts.shell);
  if (opts.cwd) args.push('-d', opts.cwd);
  return runTerm(args);
}

/** `term exec <id> <command> --json` — send a command, non-blocking. */
export function termExec(id: string, command: string): Promise<TermResponse> {
  return runTerm(['exec', id, command, '--json']);
}

/**
 * `term write <id> <input> --raw --json` — send raw bytes to the session.
 * `--raw` is load-bearing: the caller here always supplies already-literal
 * bytes (e.g. `\x1b[B\r` as real control characters from a JS string), never
 * the `pty write` CLI's `\n`/`\t`/`\e`/`\xHH` textual escape syntax, so `term`
 * must not re-interpret them.
 */
export function termWrite(id: string, input: string): Promise<TermResponse> {
  return runTerm(['write', id, input, '--raw', '--json']);
}

/** `term screen <id> --json` → `{ screen, exited, cols, rows }`. */
export function termScreen(id: string): Promise<TermResponse> {
  return runTerm(['screen', id, '--json']);
}

/** `term stop <id> --json` — end the session and clean up. */
export function termStop(id: string): Promise<TermResponse> {
  return runTerm(['stop', id, '--json']);
}
