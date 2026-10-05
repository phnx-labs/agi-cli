import { describe, it, expect } from 'vitest';
import { isManagedSessionFile } from './discover.js';

describe('isManagedSessionFile — composite (single-DB) sessions (RUSH-2357)', () => {
  it('classifies a composite OpenCode path as managed even though it sits in the XDG data dir', () => {
    const composite = '/home/u/.local/share/opencode/opencode.db#ses_02410a2c3ffeRumGfUNRgtB1Xk';
    expect(isManagedSessionFile(composite)).toBe(true);
  });

  it('still treats a plain per-install dotfile transcript as unmanaged', () => {
    const dotfile = '/home/u/.codex/sessions/2026/07/30/rollout-abc.jsonl';
    expect(isManagedSessionFile(dotfile)).toBe(false);
  });

  it('is keyed off the composite FORM, not the harness name — any single-DB path qualifies', () => {
    const future = '/var/data/futureharness/store.sqlite#conv_123';
    expect(isManagedSessionFile(future)).toBe(true);
  });
});
