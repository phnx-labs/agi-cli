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
      timeout: 15_000,
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

describe('session_remote_preview_cache schema migration', () => {
  it('adds last_caller_revision to a DB that already created the table WITHOUT it, preserving the existing row', () => {
    const script = [
      "const Database = (await import('./src/lib/sqlite.ts')).default;",
      "const path = await import('node:path');",
      "const fs = await import('node:fs');",
      "const os = await import('node:os');",
      // Simulate the OLD schema (this table shipped once already, before this
      // column existed) in a fresh sqlite file at the exact path db.ts's
      // getDB() will open.
      "const stateDir = path.join(os.homedir(), '.agents', '.history', 'sessions');",
      "fs.mkdirSync(stateDir, { recursive: true });",
      "const dbPath = path.join(stateDir, 'sessions.db');",
      "const raw = new Database(dbPath);",
      "raw.exec(`CREATE TABLE session_remote_preview_cache (",
      "  device TEXT NOT NULL, session_id TEXT NOT NULL, schema_version INTEGER NOT NULL,",
      "  fetched_at INTEGER NOT NULL, ok INTEGER NOT NULL, envelope_json TEXT,",
      "  envelope_bytes INTEGER NOT NULL DEFAULT 0, failure_reason TEXT,",
      "  consecutive_failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,",
      "  PRIMARY KEY (device, session_id, schema_version)",
      ")`);",
      "raw.prepare(`INSERT INTO session_remote_preview_cache",
      "  (device, session_id, schema_version, fetched_at, ok, envelope_json, envelope_bytes, consecutive_failures, next_attempt_at)",
      "  VALUES ('zion', 'old-row', 1, 500, 1, '{\"preview\":{\"firstUser\":\"pre-migration\"}}', 40, 0, 0)`).run();",
      "raw.close();",
      // Now open through the real module — it must self-heal the missing
      // column rather than throwing "no such column: last_caller_revision".
      "const db = await import('./src/lib/session/db.ts');",
      "const oldRow = db.readRemotePreviewCache('zion', 'old-row');",
      "db.writeRemotePreviewCallerRevision('zion', 'old-row', 'rev-after-migration');",
      "const afterRevisionWrite = db.readRemotePreviewCache('zion', 'old-row');",
      "db.closeDB();",
      "process.stdout.write(JSON.stringify({ oldRow, afterRevisionWrite }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { oldRow, afterRevisionWrite } = JSON.parse(result.stdout);
    // The pre-migration row's content survived untouched.
    expect(oldRow).toMatchObject({ ok: true, envelope: { preview: { firstUser: 'pre-migration' } } });
    expect(oldRow.lastCallerRevision).toBeUndefined();
    // The new column is writable/readable post-migration.
    expect(afterRevisionWrite.lastCallerRevision).toBe('rev-after-migration');
  });
});

describe('getRemoteSessionPreview (remote-preview-cache.ts)', () => {
  it('serves a fresh cache hit with zero fetches within the TTL', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const okEnvelope = { schemaVersion: 1, session: { machine: 'zion', id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, preview: { firstUser: 'request' }, details: { sourceRevision: 'rev-1' } };",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: okEnvelope }; } };",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const first = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps);",
      "const second = await cache.getRemoteSessionPreview(id, 'zion', { now: 1500 }, deps);", // within TTL
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, first: first.cache, second: second.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, first, second } = JSON.parse(result.stdout);
    expect(calls).toBe(1); // one real fetch total across both calls
    expect(first).toMatchObject({ source: 'live', state: 'fresh' });
    expect(second).toMatchObject({ source: 'cache', state: 'fresh' });
  });

  it('a matching --revision (the caller\'s OWN last-observed cursor, not the envelope\'s) serves the cache with zero SSH indefinitely, past the TTL', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'request' }, details: { sourceRevision: '2026-01-01T00:00:00.000Z' } } }; } };",
      // First call ever with revision '42' -- no prior recorded caller
      // revision to compare against, so this fetches once and then records
      // '42' as the observed caller revision.
      "const first = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000, revision: '42' }, deps);",
      // Same caller revision '42' again, WAY past the 45s TTL: must be a pure
      // cache hit against the caller-revision column, not the envelope's own
      // ISO sourceRevision (which the caller's '42' could never match).
      "const second = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 + 999_999, revision: '42' }, deps);",
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, first: first.cache, second: second.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, first, second } = JSON.parse(result.stdout);
    expect(calls).toBe(1); // only the first call actually fetched
    expect(first).toMatchObject({ source: 'live', state: 'fresh' });
    expect(second).toMatchObject({ source: 'cache', state: 'fresh', stale: false });
  });

  it('a DIFFERENT --revision than last observed triggers exactly one bounded refetch even far past the TTL', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'request' }, details: { sourceRevision: 'rev-' + calls } } }; } };",
      "await cache.getRemoteSessionPreview(id, 'zion', { now: 1000, revision: '1' }, deps);",
      "const changed = await cache.getRemoteSessionPreview(id, 'zion', { now: 1000 + 999_999, revision: '2' }, deps);",
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
      "const kimiId = 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const deps = { fetchEnvelope: async () => { calls++; return { ok: true, envelope: { schemaVersion: 1, session: { machine: 'zion', id: kimiId }, preview: { firstUser: 'request' } } }; } };",
      "const shortId = await cache.getRemoteSessionPreview('d3470b57', 'zion', {}, deps);",
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

  it('two genuinely concurrent requests for the same (device, id) coalesce onto ONE SSH attempt, not a serial redial', () => {
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "let calls = 0;",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      // A real, human-observable delay on the fake transport so the two
      // requests below are DEFINITELY still in flight together, not
      // accidentally serialized by the event loop.
      "const deps = { fetchEnvelope: async () => { calls++; await new Promise(r => setTimeout(r, 300)); return { ok: true, envelope: { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'request' } } }; } };",
      "const [a, b] = await Promise.all([",
      "  cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps),",
      "  cache.getRemoteSessionPreview(id, 'zion', { now: 1000 }, deps),",
      "]);",
      "const db = await import('./src/lib/session/db.ts'); db.closeDB();",
      "process.stdout.write(JSON.stringify({ calls, a: a.cache, b: b.cache }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { calls, a, b } = JSON.parse(result.stdout);
    expect(calls).toBe(1); // the lease coalesced the second request onto the first's in-flight fetch
    expect(a.state).toBe('fresh');
    expect(b.state).toBe('fresh');
  });

  it('an oversized live response is never passed through as fresh and never cached — falls back to a stale copy when one exists', () => {
    const script = [
      "const db0 = await import('./src/lib/session/db.ts');",
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      // Seed a real prior good cache entry so the oversized-response case has
      // a stale copy to fall back to.
      "db0.writeRemotePreviewCacheSuccess('zion', id, { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'good copy' } }, 100);",
      "const huge = { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'x'.repeat(db0.REMOTE_PREVIEW_ENVELOPE_MAX_BYTES + 1) } };",
      "const deps = { fetchEnvelope: async () => ({ ok: true, envelope: huge }) };",
      "const result = await cache.getRemoteSessionPreview(id, 'zion', { now: 999_999, refresh: true }, deps);",
      "const cachedAfter = db0.readRemotePreviewCache('zion', id);",
      "db0.closeDB();",
      "process.stdout.write(JSON.stringify({ cache: result.cache, envelope: result.envelope, cachedAfterIsOriginal: cachedAfter?.envelope?.preview?.firstUser === 'good copy' }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.cache.state).toBe('stale-error');
    expect(parsed.cache.reason).toMatch(/bounded-cache limit/);
    // The oversized blob is never handed back as if it were the fresh result.
    expect(parsed.envelope?.preview?.firstUser).toBe('good copy');
    // The durable cache still holds the ORIGINAL good copy, not the oversized one.
    expect(parsed.cachedAfterIsOriginal).toBe(true);
  });

  it('refuses to cache (and to treat as fresh) a peer response with the wrong session id or wrong schemaVersion', () => {
    // Two DISTINCT session ids so the second call's own negative backoff
    // (from the first call's validation failure) can never absorb it --
    // each sub-case must independently exercise its own validation branch.
    const script = [
      "const cache = await import('./src/lib/session/remote-preview-cache.ts');",
      "const idA = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const idB = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';",
      "const wrongId = { fetchEnvelope: async () => ({ ok: true, envelope: { schemaVersion: 1, session: { machine: 'zion', id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' } } }) };",
      "const wrongSchema = { fetchEnvelope: async () => ({ ok: true, envelope: { schemaVersion: 2, session: { machine: 'zion', id: idB } } }) };",
      "const a = await cache.getRemoteSessionPreview(idA, 'zion', { now: 1000 }, wrongId);",
      "const b = await cache.getRemoteSessionPreview(idB, 'zion', { now: 1000 }, wrongSchema);",
      "const db = await import('./src/lib/session/db.ts');",
      "const stillCachedA = db.readRemotePreviewCache('zion', idA);",
      "const stillCachedB = db.readRemotePreviewCache('zion', idB);",
      "db.closeDB();",
      "process.stdout.write(JSON.stringify({ a: a.cache, b: b.cache, stillCachedA: stillCachedA ?? null, stillCachedB: stillCachedB ?? null }));",
    ].join(' ');
    const result = runScript(script);
    expect(result.status, result.stderr).toBe(0);
    const { a, b, stillCachedA, stillCachedB } = JSON.parse(result.stdout);
    expect(a.state).toBe('no-cache-error');
    expect(a.reason).toMatch(/different or missing session ID/);
    expect(b.state).toBe('no-cache-error');
    expect(b.reason).toMatch(/schema/i);
    // Neither invalid response was ever persisted as a successful entry.
    expect(stillCachedA?.ok ?? false).toBe(false);
    expect(stillCachedB?.ok ?? false).toBe(false);
  });

  it('coalesces failed explicit refreshes while retaining the last good copy and its cursor', () => {
    const result = runScript(`
      const db = await import('./src/lib/session/db.ts');
      const cache = await import('./src/lib/session/remote-preview-cache.ts');
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      db.writeRemotePreviewCacheSuccess('zion', id, { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'kept' } }, 100, '42');
      let calls = 0;
      const deps = { fetchEnvelope: async () => { calls++; await new Promise(r => setTimeout(r, 100)); return { ok: false, reason: 'unreachable' }; } };
      const outcomes = await Promise.all([1,2].map(() => cache.getRemoteSessionPreview(id, 'zion', { now: 1000, refresh: true, revision: '42' }, deps)));
      const next = await cache.getRemoteSessionPreview(id, 'zion', { now: 1100, revision: '42' }, deps);
      db.closeDB();
      process.stdout.write(JSON.stringify({ calls, outcomes, next }));
    `);
    expect(result.status, result.stderr).toBe(0);
    const { calls, outcomes, next } = JSON.parse(result.stdout);
    expect(calls).toBe(1);
    for (const outcome of [...outcomes, next]) {
      expect(outcome.cache.state).toBe('stale-offline');
      expect(outcome.envelope.preview.firstUser).toBe('kept');
    }
  });

  it('requires a consistent owner and actual detail payload, with bounded validation errors', () => {
    const result = runScript(`
      const cache = await import('./src/lib/session/remote-preview-cache.ts');
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const envelopes = [
        { schemaVersion: 1, session: { id }, preview: {} },
        { schemaVersion: 1, session: { id, machine: 'zion' }, cache: { device: 'elsewhere' }, preview: {} },
        { schemaVersion: 1, session: { id, machine: 'zion' } },
        { schemaVersion: 'x'.repeat(1000000), session: { id, machine: 'zion' }, preview: {} },
        ...[
          { request: { text: 42 } },
          { messages: [{ role: ['assistant'], text: 'hello' }] },
          { timeline: { steps: 'bad' } },
          { timeline: { steps: [{ mix: { run: 'one' } }] } },
          { files: { changes: [{ edits: 1.5 }] } },
        ].map(details => ({ schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'hello' }, details })),
        { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'hello', artifacts: [{ path: 42 }] } },
      ];
      const outcomes = [];
      for (const envelope of envelopes) outcomes.push(await cache.getRemoteSessionPreview(id, 'zion', { refresh: true }, { fetchEnvelope: async () => ({ ok: true, envelope }) }));
      (await import('./src/lib/session/db.ts')).closeDB();
      process.stdout.write(JSON.stringify(outcomes));
    `);
    expect(result.status, result.stderr).toBe(0);
    for (const outcome of JSON.parse(result.stdout)) {
      expect(outcome.cache.state).toBe('no-cache-error');
      expect(outcome.cache.reason.length).toBeLessThan(200);
      expect(outcome.envelope).toBeUndefined();
    }
  });


  it('bounds initial SQLite contention and preserves live details when persistence is busy', () => {
    const result = runScript(`
      const { spawn } = await import('node:child_process');
      const { once } = await import('node:events');
      const path = await import('node:path');
      const os = await import('node:os');
      const db = await import('./src/lib/session/db.ts');
      const cache = await import('./src/lib/session/remote-preview-cache.ts');
      const dbPath = path.join(os.homedir(), '.agents', '.history', 'sessions', 'sessions.db');
      db.getDB().exec('DROP TABLE session_remote_preview_cache'); db.closeDB();
      async function holdWriteLock() {
        const code = "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]); d.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); process.stdin.once('data',()=>{d.exec('ROLLBACK');d.close();process.exit(0)}); setTimeout(()=>process.exit(2),5000).unref();";
        const child = spawn(process.execPath, ['--no-warnings', '-e', code, dbPath], { stdio: ['pipe','pipe','pipe'] });
        await once(child.stdout, 'data');
        return child;
      }
      const lock = await holdWriteLock();
      let initialFailed = false;
      const started = Date.now();
      try { db.withSessionDBTimeout(100, () => {}); } catch { initialFailed = true; }
      const initialMs = Date.now() - started;
      const exited = once(lock, 'exit'); lock.stdin.write('release'); await exited;
      db.getDB();
      const before = db.getDB().prepare('PRAGMA busy_timeout').get().timeout;
      let writeLock;
      const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const outcome = await cache.getRemoteSessionPreview(id, 'zion', {}, { fetchEnvelope: async () => {
        writeLock = await holdWriteLock();
        return { ok: true, envelope: { schemaVersion: 1, session: { id, machine: 'zion' }, preview: { firstUser: 'still readable' } } };
      }});
      const after = db.getDB().prepare('PRAGMA busy_timeout').get().timeout;
      const done = once(writeLock, 'exit'); writeLock.stdin.write('release'); await done;
      db.closeDB();
      process.stdout.write(JSON.stringify({ initialFailed, initialMs, before, after, outcome }));
    `);
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.initialFailed).toBe(true);
    expect(data.initialMs).toBeLessThan(1500);
    expect(data.before).toBe(30_000);
    expect(data.after).toBe(data.before);
    expect(data.outcome.envelope.preview.firstUser).toBe('still readable');
    expect(data.outcome.cache.reason).toContain('could not be saved');
  });

  it('rejects a daemon projection after transcript bytes change', () => {
    const result = runScript(`
      const db = await import('./src/lib/session/db.ts');
      db.writeSessionTimeline({ id: 'stamp-check', fileMtimeMs: 100, fileSize: 200, timeline: { state: {}, request: { text: 'old' }, timeline: { steps: [] } } });
      const match = db.readSessionTimelineAny('stamp-check', { fileMtimeMs: 100, fileSize: 200 });
      const changed = db.readSessionTimelineAny('stamp-check', { fileMtimeMs: 101, fileSize: 201 });
      db.closeDB(); process.stdout.write(JSON.stringify({ match, changed: changed ?? null }));
    `);
    expect(result.status, result.stderr).toBe(0);
    const { match, changed } = JSON.parse(result.stdout);
    expect(match.request.text).toBe('old');
    expect(changed).toBeNull();
  });
});
