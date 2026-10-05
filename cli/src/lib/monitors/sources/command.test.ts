import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { evaluate } from './command.js';

describe('command source evaluate', () => {
  it('returns stdout as the observation with a zero exit code', async () => {
    const obs = await evaluate({ type: 'command', command: 'echo hello-monitor' });
    expect(obs).not.toBeNull();
    expect(obs!.raw).toBe('hello-monitor');
    expect(obs!.meta?.exitCode).toBe(0);
  });

  it('flags a non-zero exit as an observation failure, not a value (PHNX-3510)', async () => {
    const obs = await evaluate({ type: 'command', command: 'exit 3' });
    expect(obs).not.toBeNull();
    expect(obs!.meta?.exitCode).toBe(3);
    expect(obs!.failed).toBe(true);
    expect(obs!.failureReason).toContain('exited 3');
  });

  it('flags a rate-limit error shape even on exit 0 (the `gh … | jq` case, PHNX-3510)', async () => {
    const obs = await evaluate({
      type: 'command',
      command: 'echo "GraphQL: API rate limit already exceeded for user ID 13007401."',
    });
    expect(obs!.meta?.exitCode).toBe(0);
    expect(obs!.failed).toBe(true);
    expect(obs!.failureReason).toBe('API rate limit exceeded');
  });

  it('does NOT flag a clean, non-error observation', async () => {
    const obs = await evaluate({ type: 'command', command: 'echo MERGED' });
    expect(obs!.failed).toBeUndefined();
  });

  it('trims trailing whitespace so identical output diffs stably', async () => {
    const a = await evaluate({ type: 'command', command: 'echo x' });
    const b = await evaluate({ type: 'command', command: 'echo x' });
    expect(a!.raw).toBe('x');
    expect(b!.raw).toBe('x');
    expect(a!.raw).toBe(b!.raw);
  });

  it('returns null when no command is set', async () => {
    expect(await evaluate({ type: 'command' })).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('kills every process of a timed-out pipeline', async () => {
    // `execFile` signalled only the shell, so the pipeline's `sleep` outlived the poll.
    const sleep = `sleep 30.${process.pid}`;
    const obs = await evaluate({ type: 'command', command: `${sleep} | cat` }, 500);
    await new Promise((r) => setTimeout(r, 300));
    expect(spawnSync('pgrep', ['-f', sleep]).status).toBe(1);
    expect(obs!.failed).toBe(true);
    expect(obs!.failureReason).toBe('timed out after 0.5s');
  });
});
