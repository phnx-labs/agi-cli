
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-originmachine-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'dispatcher-box';

const { upsertSession, closeDB } = await import('./db.js');
const { queryIndexedSessions } = await import('./discover.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    filePath: '',
    ...extra,
  };
}

async function machineOfId(id: string): Promise<string | undefined> {
  const rows = await queryIndexedSessions({ all: true });
  return rows.find((r) => r.id === id)?.machine;
}

describe('queryIndexedSessions origin-machine attribution', () => {
  it('keeps the execution host an offloaded (empty-file) row recorded', async () => {
    upsertSession(meta('11111111-2222-3333-4444-555555555555', {
      machine: 'yosemite-s0',
      label: '[host/yosemite-s0]',
    }), '');
    expect(await machineOfId('11111111-2222-3333-4444-555555555555')).toBe('yosemite-s0');
  });

  it('falls back to this box for an empty-file row that recorded no machine', async () => {
    upsertSession(meta('22222222-3333-4444-5555-666666666666'), '');
    expect(await machineOfId('22222222-3333-4444-5555-666666666666')).toBe('dispatcher-box');
  });

  it('derives origin from a synced-mirror path, ignoring a stale recorded value', async () => {
    const mirror = path.join(TEST_HOME, '.agents', '.history', 'backups', 'claude', 'peerbox', 'projects', 'p', 's.jsonl');
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(mirror, '{}\n');
    upsertSession(meta('33333333-4444-5555-6666-777777777777', {
      filePath: mirror,
      machine: 'dispatcher-box',
    }), '{}\n');
    expect(await machineOfId('33333333-4444-5555-6666-777777777777')).toBe('peerbox');
  });
});
