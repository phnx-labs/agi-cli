import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { isTmuxVersionSupported, runTmux, TmuxUnavailableError } from './binary.js';

describe('isTmuxVersionSupported', () => {
  it('accepts tmux 3.2 and newer, including patch suffixes', () => {
    expect(isTmuxVersionSupported('tmux 3.2')).toBe(true);
    expect(isTmuxVersionSupported('tmux 3.3a')).toBe(true);
    expect(isTmuxVersionSupported('tmux 3.6a')).toBe(true);
    expect(isTmuxVersionSupported('tmux 4.0')).toBe(true);
  });

  it('rejects older, missing, and unparseable versions', () => {
    expect(isTmuxVersionSupported('tmux 3.1c')).toBe(false);
    expect(isTmuxVersionSupported('tmux 2.9')).toBe(false);
    expect(isTmuxVersionSupported('tmux unknown')).toBe(false);
    expect(isTmuxVersionSupported(null)).toBe(false);
  });
});

describe('runTmux timeoutMs', () => {
  it('kills the child and rejects when a tmux command hangs past the timeout', async () => {
    const socket = path.join(os.tmpdir(), `agents-cli-tmux-timeout-${process.pid}.sock`);
    try {
      await runTmux({ socket, args: ['new-session', '-d', '-s', 'timeout-probe'], throwOnError: false, timeoutMs: 5000 });
      await expect(
        runTmux({ socket, args: ['wait-for', 'never-signaled'], throwOnError: false, timeoutMs: 300 }),
      ).rejects.toThrow(/timed out/);
    } catch (e) {
      if (e instanceof TmuxUnavailableError) return;
      throw e;
    } finally {
      try { await runTmux({ socket, args: ['kill-server'], throwOnError: false, timeoutMs: 2000 }); } catch {  }
    }
  });
});
