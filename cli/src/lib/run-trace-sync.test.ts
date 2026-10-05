import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { shouldAutoSyncTraces, fireTraceSyncInBackground } from './run-trace-sync.js';

const savedStateDir = process.env.AGENTS_STATE_DIR;
const savedNoSync = process.env.AGENTS_NO_TRACE_SYNC;
let dir: string;

function signIn() {
  fs.writeFileSync(path.join(dir, 'phoenix-session.json'), JSON.stringify({ access_token: 't' }));
}
function markSyncedBefore() {
  fs.writeFileSync(path.join(dir, 'traces-sync.json'), JSON.stringify({ lastSyncMtime: 1 }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-sync-gate-'));
  process.env.AGENTS_STATE_DIR = dir;
  delete process.env.AGENTS_NO_TRACE_SYNC;
});

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.AGENTS_STATE_DIR;
  else process.env.AGENTS_STATE_DIR = savedStateDir;
  if (savedNoSync === undefined) delete process.env.AGENTS_NO_TRACE_SYNC;
  else process.env.AGENTS_NO_TRACE_SYNC = savedNoSync;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shouldAutoSyncTraces — run-exit auto-sync policy (PHNX-3628)', () => {
  test('signed in AND already synced once → fires', () => {
    signIn();
    markSyncedBefore();
    expect(shouldAutoSyncTraces(false)).toBe(true);
  });

  test('never synced before → does NOT fire (never opted into the store)', () => {
    signIn();
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });

  test('not signed in → does NOT fire even if a stale ledger exists', () => {
    markSyncedBefore();
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });

  test('--no-trace-sync (disabled=true) wins over an otherwise-eligible run', () => {
    signIn();
    markSyncedBefore();
    expect(shouldAutoSyncTraces(true)).toBe(false);
  });

  test('AGENTS_NO_TRACE_SYNC=1 wins over an otherwise-eligible run', () => {
    signIn();
    markSyncedBefore();
    process.env.AGENTS_NO_TRACE_SYNC = '1';
    expect(shouldAutoSyncTraces(false)).toBe(false);
  });
});

describe('fireTraceSyncInBackground — important-post trigger (PHNX-3698)', () => {
  test('no-op (no spawn, no throw) when not signed in', () => {
    expect(() => fireTraceSyncInBackground()).not.toThrow();
  });

  test('no-op when disabled, even if otherwise eligible', () => {
    signIn();
    markSyncedBefore();
    expect(() => fireTraceSyncInBackground({ disabled: true })).not.toThrow();
  });

  test('no-op when AGENTS_NO_TRACE_SYNC=1, even if otherwise eligible', () => {
    signIn();
    markSyncedBefore();
    process.env.AGENTS_NO_TRACE_SYNC = '1';
    expect(() => fireTraceSyncInBackground()).not.toThrow();
  });
});
