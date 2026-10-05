/** Pre-save connection test for a custom harness (PHNX-2221): runs a real minimal `agents run`
 * through the same resolution path a real run takes, so a bad URL, account or model surfaces
 * before saving. No mock or dry-run: the profile must already be on disk. */

import { spawnSync } from 'node:child_process';
import { getCliLaunch } from './cli-entry.js';

/** Why a connection test failed, when it did. `undefined` reason ⇒ it passed. */
export type ConnectionTestReason = 'auth' | 'endpoint' | 'model' | 'unknown';

/** Outcome of a harness connection test. */
export interface ConnectionTestResult {
  ok: boolean;
  /** Machine-readable failure class; absent on success. */
  reason?: ConnectionTestReason;
  /** One-line human summary (the classified cause, or a success note). */
  message?: string;
}

/** The prompt the smoke test sends — cheap, deterministic, one token of output. */
export const CONNECTION_TEST_PROMPT = 'say alive in one word';

/** Classifies a finished `agents run` smoke test from exit code and combined output. Pure. Exit
 * 0 is a pass; otherwise matched in priority order: auth rejection (401/invalid key),
 * model-not-served, transport/DNS. Anything else is `unknown`, surfaced verbatim, never swallowed. */
export function classifyConnectionOutput(exitCode: number | null, output: string): ConnectionTestResult {
  if (exitCode === 0) return { ok: true, message: 'Connection test passed.' };

  const text = output || '';
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  const detail = firstLine ? ` (${firstLine})` : '';

  if (/\b401\b|unauthor|invalid[\s_-]?(x-)?api[\s_-]?key|authentication|invalid x-api-key|missing[\s_-]?api[\s_-]?key/i.test(text)) {
    return { ok: false, reason: 'auth', message: `Authentication rejected — check the harness's account/key.${detail}` };
  }
  if (/model[^\n]{0,48}(not\s+found|not\s+exist|does\s+not\s+exist|unknown|invalid|unsupported|unavailable)|no\s+such\s+model|unknown\s+model|invalid\s+model|unrecognized\s+model/i.test(text)) {
    return { ok: false, reason: 'model', message: `The endpoint did not accept that model id.${detail}` };
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|getaddrinfo|connection\s+refused|could\s+not\s+connect|unreachable|fetch\s+failed|socket\s+hang\s+up|network\s+error|dns|certificate|self[\s-]?signed/i.test(text)) {
    return { ok: false, reason: 'endpoint', message: `The endpoint was unreachable — check the base URL.${detail}` };
  }
  return { ok: false, reason: 'unknown', message: `Run failed (exit ${exitCode ?? 'null'}).${detail}` };
}

/** Options for {@link runHarnessConnectionTest}. */
interface ConnectionTestOptions {
  /** Agent-side timeout passed to `agents run --timeout`. Default `60s`. */
  timeout?: string;
  /** Hard wall-clock cap (ms) on the child, above the agent timeout. Default 90s. */
  killAfterMs?: number;
}

/** Runs the real connection test against a saved harness, spawning the CLI via `getCliLaunch`
 * with the argv a user would type. Never throws on a failed run; a run killed by the
 * wall-clock cap (hung request) reads as `endpoint`. */
export async function runHarnessConnectionTest(name: string, opts: ConnectionTestOptions = {}): Promise<ConnectionTestResult> {
  const { command, args } = getCliLaunch([
    'run',
    name,
    CONNECTION_TEST_PROMPT,
    '--headless',
    '--timeout',
    opts.timeout ?? '60s',
  ]);
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    timeout: opts.killAfterMs ?? 90_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { ok: false, reason: 'endpoint', message: 'The request hung past the timeout — the endpoint may be unreachable or wrong.' };
  }
  if (result.error) {
    return { ok: false, reason: 'unknown', message: `Could not launch the test: ${result.error.message}` };
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return classifyConnectionOutput(result.status, output);
}
