import * as fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import type { AgentId } from '../types.js';
import { composeWin32CommandLine } from '../platform/index.js';
import { getBinaryPath } from './store.js';
import { withInstallationLease } from './launch-gate.js';

export async function runNativeAccountCommand(
  agent: AgentId, label: string, args: string[], env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<{ code: number | null }> {
  return withInstallationLease(agent, label, () => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    let binary = getBinaryPath(agent, label);
    if (process.platform === 'win32' && fs.existsSync(`${binary}.cmd`)) binary += '.cmd';
    const shell = process.platform === 'win32' && binary.endsWith('.cmd');
    const child = spawn(shell ? composeWin32CommandLine(binary, args) : binary, shell ? [] : args, {
      env, stdio: 'inherit', shell,
    });
    let failure: Error | undefined;
    let termination: Promise<void> | undefined;
    const abort = () => {
      failure = signal?.reason instanceof Error ? signal.reason : new Error('Authentication was cancelled.');
      if (process.platform === 'win32' && child.pid) {
        termination = new Promise<void>((done) => {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => {
            if (error) failure = new Error(`Could not stop the native authentication process tree: ${error.message}`);
            done();
          });
        });
      } else {
        child.kill('SIGTERM');
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => { failure = error; });
    child.once('close', async (code) => {
      signal?.removeEventListener('abort', abort);
      await termination;
      if (failure) reject(failure);
      else resolve({ code });
    });
  }));
}
