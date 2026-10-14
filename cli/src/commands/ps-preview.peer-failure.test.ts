import { afterAll, describe, expect, it } from 'vitest';

process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const { upsertSession, closeDB } = await import('../lib/session/db.js');
const { upsertDevice } = await import('../lib/devices/registry.js');
const { renderSessionPreview } = await import('./ps.js');

afterAll(() => {
  closeDB();
  delete process.env.AGENTS_SYNC_MACHINE_ID;
  process.exitCode = 0;
});

describe.skipIf(process.platform === 'win32')('agents ps preview on a peer-owned session (PHNX-4387)', () => {
  it('exits nonzero when the hop to the owning peer fails', async () => {
    await upsertDevice('dead-peer', {
      platform: 'linux',
      address: { via: 'tailscale', dnsName: 'dead-peer.phnx4387.invalid' },
      auth: { method: 'key' },
    });
    const id = '4387aaaa-1111-4222-8333-444444444444';
    upsertSession(
      {
        id,
        shortId: id.slice(0, 8),
        agent: 'claude',
        timestamp: new Date().toISOString(),
        filePath: `/home/someone/.claude/projects/p/${id}.jsonl`,
        machine: 'dead-peer',
      },
      '{}\n',
    );

    const errors: string[] = [];
    const { error } = console;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      process.exitCode = 0;
      await renderSessionPreview(id, { json: true });
    } finally {
      console.error = error;
    }

    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('is on dead-peer, but that device is not reachable');
  }, 60_000);
});
