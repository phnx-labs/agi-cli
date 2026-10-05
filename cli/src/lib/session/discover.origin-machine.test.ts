/** `queryIndexedSessions` must not clobber the EXECUTION host of an offloaded run (RUSH-2486 /
 * RUSH-2479). Dispatch rows carry `machine = <peer>` and empty `file_path`; re-deriving from the
 * path blamed THIS box (two `machine:id` keys). */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Pin this box's id and isolate the DB under a temp HOME BEFORE db.js/state.js/origin-machine.js
// capture them at import. `AGENTS_SYNC_MACHINE_ID` fixes machineId() so the fallback "this box"
// differs from the peer under test.
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
    // The dispatcher's own index row for a `--device yosemite-s0` run.
    upsertSession(meta('11111111-2222-3333-4444-555555555555', {
      machine: 'yosemite-s0',
      label: '[host/yosemite-s0]',
    }), '');
    expect(await machineOfId('11111111-2222-3333-4444-555555555555')).toBe('yosemite-s0');
  });

  it('falls back to this box for an empty-file row that recorded no machine', async () => {
    // Pre-attribution host rows carried no machine; nothing better than this box.
    upsertSession(meta('22222222-3333-4444-5555-666666666666'), '');
    expect(await machineOfId('22222222-3333-4444-5555-666666666666')).toBe('dispatcher-box');
  });

  it('derives origin from a synced-mirror path, ignoring a stale recorded value', async () => {
    // A cross-machine mirror lives at backups/<agent>/<machine>/…; the path is
    // authoritative for a real file, so the derivation still owns this case.
    const mirror = path.join(TEST_HOME, '.agents', '.history', 'backups', 'claude', 'peerbox', 'projects', 'p', 's.jsonl');
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(mirror, '{}\n');
    upsertSession(meta('33333333-4444-5555-6666-777777777777', {
      filePath: mirror,
      machine: 'dispatcher-box', // stale/wrong — the mirror path names the real origin
    }), '{}\n');
    expect(await machineOfId('33333333-4444-5555-6666-777777777777')).toBe('peerbox');
  });
});
