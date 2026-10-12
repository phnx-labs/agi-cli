
import { describe, it, expect, vi } from 'vitest';
import { parseRemoteActive } from '../remote-active.js';
import { gatherRemoteAgentsJson, type SshCaptureFn } from '../../remote-agents-json.js';
import { dedupeByMachineSession } from '../active.js';

describe('parseRemoteActive', () => {
  it('tags every parsed session with the source machine', () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a' },
      { context: 'cloud', kind: 'codex', status: 'queued' },
    ]);
    const out = parseRemoteActive(stdout, 'zion').items;
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.machine === 'zion')).toBe(true);
    expect(out[0].sessionId).toBe('a');
  });

  it('rejects non-JSON (a login-shell banner leaked into stdout) as an invalid answer', () => {
    expect(parseRemoteActive('bash: agents: command not found\n', 'zion')).toEqual({ items: [], valid: false });
  });

  it('rejects a top level that is not an array as an invalid answer', () => {
    expect(parseRemoteActive(JSON.stringify({ error: 'nope' }), 'zion')).toEqual({ items: [], valid: false });
  });

  it('drops non-object entries but keeps the valid ones', () => {
    const stdout = JSON.stringify([null, 'weird', 42, { kind: 'claude', context: 'teams', status: 'idle' }]);
    const out = parseRemoteActive(stdout, 'mark').items;
    expect(out).toHaveLength(1);
    expect(out[0].machine).toBe('mark');
  });

  it('rejects empty stdout (peer produced nothing) as an invalid answer', () => {
    expect(parseRemoteActive('', 'zion')).toEqual({ items: [], valid: false });
  });
});

describe('parseRemoteActive viewingIn normalization', () => {
  it('turns a peer label back into the internal viewer shape', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: 'codium tab 3' }]), 'peer').items;
    expect(rows[0].viewingIn).toEqual({ app: 'codium', tab: 3 });
  });

  it('treats a detached peer row as having no viewer', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: 'detached' }]), 'peer').items;
    expect(rows[0].viewingIn).toBeUndefined();
  });

  it('accepts the object shape a peer on an older version emits', () => {
    const rows = parseRemoteActive(JSON.stringify([{ sessionId: 'a', viewingIn: { app: 'ghostty', tab: 2 } }]), 'peer').items;
    expect(rows[0].viewingIn).toEqual({ app: 'ghostty', tab: 2 });
  });

  it("keeps an OFFLOADED row's own machine — its execution host is a third box", () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'off', machine: 'yosemite-s0', offloadedFrom: 'zion' },
    ]);
    const out = parseRemoteActive(stdout, 'zion').items;
    expect(out[0].machine).toBe('yosemite-s0');
    expect(out[0].offloadedFrom).toBe('zion');
  });

  it('still stamps the dialed device over a peer\'s own hostname (the name we key scopes on)', () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a', machine: 'mark.local' },
    ]);
    expect(parseRemoteActive(stdout, 'mark').items[0].machine).toBe('mark');
  });

  it('still stamps the dialed peer when the row reports no machine at all', () => {
    const stdout = JSON.stringify([
      { context: 'terminal', kind: 'claude', status: 'running', sessionId: 'a' },
    ]);
    expect(parseRemoteActive(stdout, 'zion').items[0].machine).toBe('zion');
  });
});

describe('gatherRemoteActive — surfaces skipped/discoveryFailed instead of dropping them', () => {
  it('forwards skipped peer names and a false discoveryFailed on a partial sweep', async () => {
    vi.resetModules();
    vi.doMock('../../remote-agents-json.js', () => ({
      gatherRemoteAgentsJson: vi.fn(async () => ({
        items: [],
        deviceCount: 2,
        skipped: ['yosemite-s0'],
        parseFailed: [],
        discoveryFailed: false,
      })),
    }));
    const { gatherRemoteActive } = await import('../remote-active.js');
    const result = await gatherRemoteActive();
    expect(result.deviceCount).toBe(2);
    expect(result.skipped).toEqual(['yosemite-s0']);
    expect(result.discoveryFailed).toBe(false);
    vi.doUnmock('../../remote-agents-json.js');
    vi.resetModules();
  });

  it('forwards discoveryFailed when the device list itself could not be loaded', async () => {
    vi.resetModules();
    vi.doMock('../../remote-agents-json.js', () => ({
      gatherRemoteAgentsJson: vi.fn(async () => ({
        items: [],
        deviceCount: 0,
        skipped: [],
        parseFailed: [],
        discoveryFailed: true,
      })),
    }));
    const { gatherRemoteActive } = await import('../remote-active.js');
    const result = await gatherRemoteActive();
    expect(result.discoveryFailed).toBe(true);
    vi.doUnmock('../../remote-agents-json.js');
    vi.resetModules();
  });
});

describe('gatherRemoteActive — earlyExit is opt-in, default all-settle', () => {
  it('forwards earlyExit when the caller opts in (detach/stop unique live id)', async () => {
    vi.resetModules();
    const gatherRemoteAgentsJson = vi.fn(async () => ({
      items: [],
      deviceCount: 1,
      skipped: [],
      parseFailed: [],
      discoveryFailed: false,
    }));
    vi.doMock('../../remote-agents-json.js', () => ({ gatherRemoteAgentsJson }));
    const { gatherRemoteActive } = await import('../remote-active.js');
    const isDefinitive = () => true;
    await gatherRemoteActive(undefined, { earlyExit: { isDefinitive } });
    expect(gatherRemoteAgentsJson).toHaveBeenCalledWith(
      expect.objectContaining({ earlyExit: { isDefinitive } }),
    );
    vi.doUnmock('../../remote-agents-json.js');
    vi.resetModules();
  });

  it('omits earlyExit by default so --active / browse stay all-settle', async () => {
    vi.resetModules();
    const gatherRemoteAgentsJson = vi.fn(async () => ({
      items: [],
      deviceCount: 1,
      skipped: [],
      parseFailed: [],
      discoveryFailed: false,
    }));
    vi.doMock('../../remote-agents-json.js', () => ({ gatherRemoteAgentsJson }));
    const { gatherRemoteActive } = await import('../remote-active.js');
    await gatherRemoteActive();
    const arg = gatherRemoteAgentsJson.mock.calls[0]?.[0] as { earlyExit?: unknown };
    expect(arg.earlyExit).toBeUndefined();
    vi.doUnmock('../../remote-agents-json.js');
    vi.resetModules();
  });
});

describe('gatherRemoteAgentsJson + parseRemoteActive — a garbled exit-0 peer is not an answer', () => {
  it('keeps the shim of a peer that printed a banner or an object, drops it only for a peer that answered', async () => {
    const BANNER = 'tester@banner.example.com';
    const OBJECT = 'tester@object.example.com';
    const EMPTY = 'tester@empty.example.com';
    const stdout: Record<string, string> = { [BANNER]: 'Welcome to Ubuntu\n[]', [OBJECT]: '{}', [EMPTY]: '[]' };
    const capture: SshCaptureFn = (target) => Promise.resolve({ code: 0, stdout: stdout[target] });
    const result = await gatherRemoteAgentsJson({ args: ['sessions', '--active', '--json'], noFanoutEnv: 'X', hosts: [BANNER, OBJECT, EMPTY], quiet: true, parse: parseRemoteActive }, { capture });
    expect(result.answered).toHaveLength(1);
    expect(result.parseFailed).toHaveLength(2);
    const shims = result.parseFailed.concat(result.answered).map((machine, i) => ({ context: 'terminal' as const, kind: 'claude', status: 'unknown' as const, sessionId: `s${i}`, machine, offloadedFrom: 'zion' }));
    expect(dedupeByMachineSession(shims, result.answered).map(s => s.sessionId)).toEqual(['s0', 's1']);
  });
});
