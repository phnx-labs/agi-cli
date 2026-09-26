/**
 * The DB join behind {@link foldExecutionMachine}, against a REAL SQLite index
 * (RUSH-2479). This is the one piece of the attribution that can silently read
 * the wrong column, miss the batching chunk boundary, or throw — the pure fold
 * itself is covered by injecting a lookup, which by construction cannot catch
 * any of that.
 *
 * The row shape under test is exactly what a host dispatch writes:
 * `registerHostSession` upserts `machine: normalizeHost(task.host)` with an
 * EMPTY `file_path` (the transcript is on the peer) — see
 * `lib/hosts/session-index.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Isolate the sessions DB under a temp HOME before db.js/state.js capture the
// path at import time.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-execmachine-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { upsertSession, findSessionMachinesByIds } = await import('./db.js');
type SessionMeta = import('@phnx-labs/sessions-cli/reader').SessionMeta;

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    agent: 'claude',
    timestamp: new Date().toISOString(),
    // A host-dispatched row carries no local transcript.
    filePath: '',
    ...extra,
  };
}

describe('findSessionMachinesByIds', () => {
  it('reads back the execution host a host dispatch recorded', () => {
    upsertSession(meta('offloaded-1', { machine: 'yosemite-s0', label: '[host/yosemite-s0]' }), '');
    const out = findSessionMachinesByIds(['offloaded-1']);
    expect(out.get('offloaded-1')).toBe('yosemite-s0');
  });

  it('omits a session the index has never seen, rather than inventing one', () => {
    expect(findSessionMachinesByIds(['never-indexed']).has('never-indexed')).toBe(false);
  });

  it('returns THIS box for an ordinary local session — the upsert infers it', async () => {
    // Not a quirk to route around: `session-index.ts` documents that omitting
    // `machine` makes the upsert infer this box from the empty file path. So the
    // lookup answers for nearly every row, and it is `foldExecutionMachine`'s
    // `recorded === self` guard — not an absent row — that keeps a local session
    // from being re-attributed. The next test pins that.
    upsertSession(meta('local-1'), '');
    const { machineId } = await import('../machine-id.js');
    expect(findSessionMachinesByIds(['local-1']).get('local-1')).toBe(machineId());
  });

  it('a local row is left alone by the fold, despite resolving to a machine', async () => {
    const { foldExecutionMachine } = await import('./active.js');
    const { machineId } = await import('../machine-id.js');
    const self = machineId();
    upsertSession(meta('local-2'), '');
    const rows = [{ context: 'terminal', kind: 'claude', status: 'running', sessionId: 'local-2', machine: self }] as any[];
    foldExecutionMachine(rows, (id) => findSessionMachinesByIds([id]).get(id), self);
    expect(rows[0].machine).toBe(self);
    expect(rows[0].offloadedFrom).toBeUndefined();
  });

  it('resolves every id across the 500-per-query chunk boundary', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `bulk-${i}`);
    for (const id of ids) upsertSession(meta(id, { machine: 'yosemite-s1' }), '');
    const out = findSessionMachinesByIds(ids);
    expect(out.size).toBe(1200);
    expect(out.get('bulk-0')).toBe('yosemite-s1');
    expect(out.get('bulk-1199')).toBe('yosemite-s1');
  });

  it('is a no-op on an empty id list (never issues a query)', () => {
    expect(findSessionMachinesByIds([]).size).toBe(0);
  });

  it('drives the fold end to end: index row -> machine + offloadedFrom', async () => {
    const { foldExecutionMachine } = await import('./active.js');
    upsertSession(meta('seam-1', { machine: 'yosemite-s0' }), '');
    const rows = [{ context: 'terminal', kind: 'claude', status: 'running', sessionId: 'seam-1', machine: 'zion' }] as any[];
    foldExecutionMachine(rows, (id) => findSessionMachinesByIds([id]).get(id), 'zion');
    expect(rows[0].machine).toBe('yosemite-s0');
    expect(rows[0].offloadedFrom).toBe('zion');
  });
});
