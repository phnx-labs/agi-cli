import { describe, it, expect } from 'vitest';
import { codexSandboxPreflight } from './exec.js';
import type { UsernsStatus } from './linux-userns.js';

const BLOCKED: UsernsStatus = {
  state: 'blocked',
  reason: 'the kernel denied creating an unprivileged user namespace (kernel.apparmor_restrict_unprivileged_userns=1)',
};
const OK: UsernsStatus = { state: 'ok' };

function base() {
  return {
    agent: 'codex' as const,
    platform: 'linux' as NodeJS.Platform,
    interactive: false,
    mode: 'auto' as const,
    userns: BLOCKED,
    machine: 'yosemite-m1',
  };
}

describe('codexSandboxPreflight', () => {
  it('blocks a headless codex workspace-write run on a userns-restricted Linux box', () => {
    const msg = codexSandboxPreflight(base());
    expect(msg).not.toBeNull();
    expect(msg).toContain('bwrap: setting up uid map: Permission denied');
    expect(msg).toContain('yosemite-m1');
    expect(msg).toContain('PHNX-3285');
    expect(msg).toContain('apparmor_restrict_unprivileged_userns=0');
    expect(msg).toContain('--mode skip');
  });

  it('blocks edit and plan too — codex uses bwrap for every sandboxed mode', () => {
    expect(codexSandboxPreflight({ ...base(), mode: 'edit' })).not.toBeNull();
    expect(codexSandboxPreflight({ ...base(), mode: 'plan' })).not.toBeNull();
  });

  it('does NOT block skip mode — codex --dangerously-bypass uses no bwrap', () => {
    expect(codexSandboxPreflight({ ...base(), mode: 'skip' })).toBeNull();
  });

  it('does NOT block an interactive run — the TUI surfaces the error itself', () => {
    expect(codexSandboxPreflight({ ...base(), interactive: true })).toBeNull();
  });

  it('does NOT block when the box can create a user namespace', () => {
    expect(codexSandboxPreflight({ ...base(), userns: OK })).toBeNull();
    expect(codexSandboxPreflight({ ...base(), userns: { state: 'unknown' } })).toBeNull();
  });

  it('does NOT block non-codex harnesses — only codex ships a userns sandbox', () => {
    expect(codexSandboxPreflight({ ...base(), agent: 'claude' })).toBeNull();
    expect(codexSandboxPreflight({ ...base(), agent: 'grok' })).toBeNull();
    expect(codexSandboxPreflight({ ...base(), agent: 'kimi' })).toBeNull();
  });

  it('does NOT block on macOS/Windows — no bwrap/userns sandbox there', () => {
    expect(codexSandboxPreflight({ ...base(), platform: 'darwin' })).toBeNull();
    expect(codexSandboxPreflight({ ...base(), platform: 'win32' })).toBeNull();
  });
});
