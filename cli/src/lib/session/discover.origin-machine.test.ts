/**
 * `queryIndexedSessions` must not clobber the EXECUTION host an offloaded run
 * recorded (RUSH-2486 / RUSH-2479 criterion 2).
 *
 * A host dispatch (`agents run --device <peer>`) upserts an index row on the
 * DISPATCHER with `machine = <peer>` and an EMPTY `file_path` (the transcript is
 * on the peer — `registerHostSession`, `lib/hosts/session-index.ts`). The read
 * path re-derived `machine` from the transcript path for every row, and
 * `machineForSessionFile('')` falls back to THIS box — so the dispatcher's own
 * pool row was re-attributed to itself (`<dispatcher>`), while the executing
 * peer's fan-out row keeps `<peer>`. Two `machine:id` keys survive
 * `mergeLocalFirst`, and `agents sessions <id>` read as "ambiguous (2 sessions)".
 *
 * The origin-from-path derivation must stay the source for live-home files and
 * synced mirrors, whose recorded machine already equals it — only the empty-file
 * case must keep the recorded execution host.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Pin this box's id and isolate the DB under a temp HOME BEFORE db.js/state.js/
// origin-machine.js capture them at import time (same hermetic pattern as
// hosts/session-index.test.ts). `AGENTS_SYNC_MACHINE_ID` fixes machineId() so
// the "this box" the derivation falls back to is a known value, distinct from
// the peer under test.
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
