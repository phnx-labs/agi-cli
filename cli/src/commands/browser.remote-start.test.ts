import { describe, expect, it } from 'vitest';
import { remoteStartTaskName } from './browser.js';

describe('remoteStartTaskName', () => {
  it('reads the task from pretty JSON output', () => {
    expect(remoteStartTaskName('{\n  "ok": true,\n  "task": "a1b2c3d4"\n}')).toBe('a1b2c3d4');
  });

  it('keeps the one-line human protocol and explicit task name', () => {
    expect(remoteStartTaskName('\nabc12345\n')).toBe('abc12345');
    expect(remoteStartTaskName('{"task":"remote"}', 'named')).toBe('named');
  });

  it('does not bind an empty remote response', () => {
    expect(remoteStartTaskName('  \n')).toBeUndefined();
  });
});
