import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process.spawn so runAcp never launches a real harness; we only assert the env it is
// handed. The stub never speaks ACP, so runAcp rejects at the handshake, after the spawn call has
// already happened.
const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: spawnMock }));

// buildExecEnv is the canonical env-builder that injects the per-account
// setup-token on a worker. Stub it to a sentinel so we can prove runAcp routes
// through it instead of handing the harness a raw process.env.
const buildExecEnvMock = vi.fn(() => ({ SENTINEL_INJECTED_ENV: '1', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test' } as NodeJS.ProcessEnv));
vi.mock('../exec.js', () => ({ buildExecEnv: buildExecEnvMock }));

function makeFakeChild(): EventEmitter & { stdin: unknown; stdout: unknown } {
  const child = new EventEmitter() as EventEmitter & { stdin: unknown; stdout: unknown };
  // Minimal duplex-ish stubs; the ndjson stream wraps these but no bytes flow.
  const { Readable, Writable } = require('node:stream');
  child.stdin = new Writable({ write(_c: unknown, _e: unknown, cb: () => void) { cb(); } });
  child.stdout = new Readable({ read() { /* never emits */ } });
  return child;
}

describe('runAcp injects the built exec env (PHNX-3681)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    buildExecEnvMock.mockClear();
    spawnMock.mockImplementation(() => makeFakeChild());
  });
  afterEach(() => vi.clearAllTimers());

  it('spawns the harness with buildExecEnv output, not a raw process.env', async () => {
    const { runAcp } = await import('./client.js');
    // The handshake will never complete against the fake child; race it against a
    // short timer so the test does not hang, then inspect the spawn call.
    await Promise.race([
      runAcp({ agent: 'claude', prompt: 'hi', cwd: '/tmp', mode: 'edit' }).catch(() => undefined),
      new Promise(resolve => setTimeout(resolve, 150)),
    ]);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(buildExecEnvMock).toHaveBeenCalledTimes(1);
    // The agent/cwd/mode flow into the env-builder so device-role gating applies.
    expect(buildExecEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', cwd: '/tmp', mode: 'edit', interactive: true }),
    );
    const passedEnv = spawnMock.mock.calls[0]![2].env;
    expect(passedEnv.SENTINEL_INJECTED_ENV).toBe('1');
    expect(passedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat-test');
    expect(passedEnv).not.toBe(process.env);
  });
});
