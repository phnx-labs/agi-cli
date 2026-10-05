import { execFile } from 'node:child_process';
import { findInPath } from './agent-spec/agents.js';

export const TERM_NOT_INSTALLED_ERROR =
  'The standalone `term` CLI is not installed. npm i -g @phnx-labs/term-cli';

export interface TermResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

export function resolveTermBin(): string | null {
  // The standalone term CLI owns server lifecycle; this client resolves TERM_BIN then PATH, shells out, and has no fallback sidecar.
  const override = process.env.TERM_BIN;
  if (override && override.trim().length > 0) return override.trim();
  return findInPath('term');
}

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
      // term may log before its response; its final stdout line is the JSON contract.
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

export function termStart(opts: TermStartOptions = {}): Promise<TermResponse> {
  const args = ['start', '--json'];
  if (opts.rows) args.push('-r', String(opts.rows));
  if (opts.cols) args.push('-c', String(opts.cols));
  if (opts.shell) args.push('-s', opts.shell);
  if (opts.cwd) args.push('-d', opts.cwd);
  return runTerm(args);
}

export function termExec(id: string, command: string): Promise<TermResponse> {
  return runTerm(['exec', id, command, '--json']);
}

export function termWrite(id: string, input: string): Promise<TermResponse> {
  // --raw preserves literal input bytes instead of interpreting escape sequences.
  return runTerm(['write', id, input, '--raw', '--json']);
}

export function termScreen(id: string): Promise<TermResponse> {
  return runTerm(['screen', id, '--json']);
}

export function termStop(id: string): Promise<TermResponse> {
  // stop has no JSON response, so synthesize only its process result.
  return new Promise((resolve, reject) => {
    const bin = resolveTermBin();
    if (!bin) {
      reject(new Error(TERM_NOT_INSTALLED_ERROR));
      return;
    }
    execFile(bin, ['stop', id], { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr.toString().trim() || err.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}
