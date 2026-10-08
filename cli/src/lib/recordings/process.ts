import { spawn } from 'node:child_process';

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RecordingProcessError extends Error {
  constructor(
    message: string,
    readonly result?: ProcessResult,
  ) {
    super(message);
    this.name = 'RecordingProcessError';
  }
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8');
  return next.length > MAX_OUTPUT_BYTES ? next.slice(-MAX_OUTPUT_BYTES) : next;
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationError: Error | undefined;

    const signalChild = (signal: NodeJS.Signals): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const stop = (error: Error): void => {
      if (terminationError) return;
      terminationError = error;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), 2_000);
    };
    const abort = (): void => stop(new DOMException('The operation was aborted', 'AbortError'));
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
    };
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        stop(new RecordingProcessError(
          `Command timed out after ${options.timeoutMs}ms: ${command}`,
          { exitCode: -1, stdout, stderr },
        ));
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.on('error', (error) => finishReject(error));
    child.on('close', (code) => {
      if (settled) return;
      if (terminationError) {
        finishReject(terminationError);
        return;
      }
      settled = true;
      cleanup();
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

export function processFailure(command: string, args: string[], result: ProcessResult): RecordingProcessError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new RecordingProcessError(`${command} ${args.join(' ')} failed: ${detail}`, result);
}
