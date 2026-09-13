/**
 * Real-SQLite tests for the PHNX-3999 requester-side remote preview cache:
 * the durable `session_remote_preview_cache` table in `db.ts`, and the
 * orchestration (`getRemoteSessionPreview` in `remote-preview-cache.ts`) that
 * decides fresh-cache-hit / revision-driven refetch / negative-backoff /
 * explicit-refresh without ever touching a real SSH peer. The network
 * boundary (`fetchPeerPreviewEnvelope`) is injected as a counting fake so
 * these tests exercise the real cache/backoff/revision state machine against
 * a real on-disk DB, per this repo's "no mocking the DB" convention — only the
 * network hop (unavailable in this sandbox) is faked, matching the DI pattern
 * already used elsewhere in `sessions.ts` (`FleetResolveDeps`).
 *
 * Each test runs in its own subprocess with HOME pointed at a fresh temp dir,
 * matching `session-preview-cache.test.ts`'s pattern: `getDB()` is a
 * process-wide singleton, so isolation across tests requires a fresh process,
 * not just a fresh temp dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function runScript(script: string): { status: number | null; stdout: string; stderr: string } {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-remote-preview-cache-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

describe('session_remote_preview_cache (db.ts)', () => {
  it('round-trips a successful envelope and resets backoff on a later success', () => {
    const script = [
      "const db = await import('./src/lib/session/db.ts');",
      "db.writeRemotePreviewCacheSuccess('zion', 'abc-1', { preview: { firstUser: 'hi' } }, 1000);",
      "const hit = db.readRemotePreviewCache('zion', 'abc-1');",
      "db.writeRemotePreviewCacheFailure('zion', 'abc-1', 'peer down', (n) => 1000 * n, 2000);",
      "const afterFailure = db.readRemotePreviewCache('zion', 'abc-1');",
      "db.writeRemotePreviewCacheSuccess('zion', 'abc-1', { preview: { firstUser: 'hi again' } }, 3000);",
      "const afterRecovery = db.readRemotePreviewCache('zion', 'abc-1');",
      "db.closeDB();",
      "process.stdout.write(JSON.stringify({ hit, afterFailure, afterRecovery }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { hit, afterFailure, afterRecovery } = JSON.parse(result.stdout);
    expect(hit).toMatchObject({ ok: true, fetchedAt: 1000, envelope: { preview: { firstUser: 'hi' } }, consecutiveFailures: 0 });
    // A failure keeps the prior good envelope (degrade to stale, never to empty).
    expect(afterFailure).toMatchObject({ ok: true, envelope: { preview: { firstUser: 'hi' } }, consecutiveFailures: 1, failureReason: 'peer down' });
    expect(afterFailure.nextAttemptAt).toBeGreaterThan(2000);
    // A later success replaces the payload and resets backoff.
    expect(afterRecovery).toMatchObject({ ok: true, envelope: { preview: { firstUser: 'hi again' } }, consecutiveFailures: 0, nextAttemptAt: 0 });
  });

  it('refuses to persist an envelope over the per-row byte cap, without erroring', () => {
    const script = [
      "const db = await import('./src/lib/session/db.ts');",
      "const oversized = { preview: { blob: 'x'.repeat(db.REMOTE_PREVIEW_ENVELOPE_MAX_BYTES + 1) } };",
      "db.writeRemotePreviewCacheSuccess('zion', 'big-1', oversized, 1000);",
      "const row = db.readRemotePreviewCache('zion', 'big-1');",
      "db.closeDB(); process.stdout.write(JSON.stringify({ row: row ?? null }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).row).toBeNull();
  });

  it('bounds total cache bytes across rows, evicting oldest first, independent of the row-count cap', () => {
    const ROWS = 40; // 40 x ~480 KiB (each just under the per-row cap) > the 16 MiB total budget
    const script = [
      "const db = await import('./src/lib/session/db.ts');",
      `const chunk = 'x'.repeat(480 * 1024);`,
      `for (let i = 0; i < ${ROWS}; i++) {`,
      "  db.writeRemotePreviewCacheSuccess('zion', 'row-' + i, { preview: { blob: chunk } }, 1000 + i);",
      "}",
      "const present = [];",
      `for (let i = 0; i < ${ROWS}; i++) { if (db.readRemotePreviewCache('zion', 'row-' + i)) present.push(i); }`,
      "db.closeDB(); process.stdout.write(JSON.stringify({ present }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { present } = JSON.parse(result.stdout);
    // Newest row must survive; the oldest were evicted to respect the total-byte budget
    // (40 rows at ~480 KiB each is ~19 MiB, over the 16 MiB budget, while every
    // individual row is comfortably under the 500-row and per-row-byte caps).
    expect(present).toContain(ROWS - 1);
    expect(present.length).toBeLessThan(ROWS);
    expect(present).not.toContain(0);
  });
});

describe('getRemoteSessionPreview (remote-preview-cache.ts)', () => {
  it('serves a fresh cache hit with zero fetches, and a revision match bypasses the TTL with zero fetches', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const okEnvelope = { session: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, details: { sourceRevision: 'rev-1' } };",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: okEnvelope }; } };",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const first = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps);",
      "const second = await cache.getRemoteSessionPreview(id, 'zion', { now: 1500 }, deps);", // within TTL
      "const thirdPastTtl = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 + 999_999, revision: 'rev-1' }, deps);", // revision match, way past TTL
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, first: first.cache, second: second.cache, third: thirdPastTtl.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, first, second, third } = JSON.parse(result.stdout);
    expect(calls).toBe(1); // one real fetch total across all three calls
    expect(first).toMatchObject({ source: 'live', state: 'fresh' });
    expect(second).toMatchObject({ source: 'cache', state: 'fresh' });
    expect(third).toMatchObject({ source: 'cache', state: 'fresh', stale: false });
  });

  it('a revision mismatch triggers exactly one bounded refetch even far past the TTL', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: { session: { id }, details: { sourceRevision: 'rev-' + calls } } }; } };",
      "await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps);",
      "const changed = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 + 999_999, revision: 'stale-revision' }, deps);",
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, changed: changed.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, changed } = JSON.parse(result.stdout);
    expect(calls).toBe(2);
    expect(changed).toMatchObject({ source: 'live', state: 'fresh' });
  });

  it('applies negative backoff after a failure and serves the explicit no-cache-offline outcome with zero further fetches', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: false, reason: 'unreachable' }; } };",
      "const first = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps);",
      "const secondSoonAfter = await cache.getRemoteSessionPreview(id, 'zion', { now: 1500 }, deps);", // inside backoff window
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, first: first.cache, second: secondSoonAfter.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, first, second } = JSON.parse(result.stdout);
    expect(calls).toBe(1); // the backoff window absorbed the second call
    expect(first.state).toBe('no-cache-offline');
    expect(second.state).toBe('no-cache-offline');
  });

  it('--refresh bypasses both the freshness window and backoff for exactly one bounded attempt', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: false, reason: 'unreachable' }; } };",
      "await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps);", // first failure, sets backoff
      "await cache.getRemoteSessionPreview(id, 'zion', { now: 1001, refresh: true }, deps);", // explicit refresh, ignores backoff
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).calls).toBe(2);
  });

  it('rejects a non-complete id (short id / label) with zero DB writes and zero fetches, but accepts a kimi/rush session_<uuid> id', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: { session: {} } }; } };",
      "const shortId = await cache.getRemoteSessionPreview('d3470b57', 'zion', {}, deps);",
      "const kimiId = 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const kimi = await cache.getRemoteSessionPreview(kimiId, 'zion', { now: 1000 }, deps);",
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, shortIdState: shortId.cache.state, kimiState: kimi.cache.state }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, shortIdState, kimiState } = JSON.parse(result.stdout);
    expect(shortIdState).toBe('invalid-id');
    expect(kimiState).toBe('fresh');
    expect(calls).toBe(1); // only the accepted kimi-shaped id actually fetched
  });
});
