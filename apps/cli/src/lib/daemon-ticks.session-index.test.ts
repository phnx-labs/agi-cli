import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ActiveSession } from './session/active.js';

// RUSH-2691: the tick's only test injected a `deps.discover` seam — a mock with
// no production caller — so the real branch never evaluated and it asserted
// `3 === 3`. It passed green while the tick indexed nothing on every real box.
//
// This drives the REAL path: a real transcript on disk, the real incremental
// scanner, the real SQLite index, run from the daemon's own cwd. That last part
// is the regression: `discoverSessions()` with no options ends in a listing
// query whose cwd filter defaults to `process.cwd()` (the daemon's, `$HOME`) and
// caps at 50, so the count described "sessions whose cwd is exactly $HOME" — 0
// on a normal box, forever, no matter what the scan wrote.
//
// HOME is redirected BEFORE the session modules load because discover.ts binds
// `const HOME = os.homedir()` at import time (discover.ts:76); that is why this
// lives in its own file instead of a suite in daemon-ticks.test.ts.
//
// The `process.chdir` calls below are legal only under `pool: 'forks'`
// (vitest.config.ts) — `process.chdir()` throws in worker threads. If the pool
// ever changes, this file needs a different way to run from the daemon's cwd.

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalCwd = process.cwd();
// realpath'd — see the note in active.session-file-id.test.ts: macOS os.tmpdir()
// is a symlink, and the indexed `cwd` is stored raw but queried realpath'd, so an
// unresolved temp path makes the stored cwd and the asserted cwd differ.
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-index-warm-')));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { runActiveSessionsWarmTick, runSessionIndexWarmTick } = await import('./daemon-ticks.js');
const db = await import('./session/db.js');
const sessionCache = await import('./session/session-cache.js');

afterAll(() => {
  db.closeDB();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(testHome, { recursive: true, force: true });
});

/** Write a real Claude transcript for `id`, working in `projectCwd`. */
function writeTranscript(id: string, projectCwd: string, label?: string): void {
  fs.mkdirSync(projectCwd, { recursive: true });
  // Flatten the cwd into one dir segment. The class covers `\` and `:` as well as
  // `/` and `.` so the name stays a single valid segment on Windows, where the
  // full suite also runs (tests.yml).
  const projectDir = path.join(testHome, '.claude', 'projects', projectCwd.replace(/[/\\.:]/g, '-'));
  fs.mkdirSync(projectDir, { recursive: true });
  const events = [
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: projectCwd,
      timestamp: '2026-08-15T10:00:00.000Z',
      message: { role: 'user', content: 'index me' },
    }),
  ];
  if (label) events.push(JSON.stringify({ type: 'custom-title', customTitle: label, sessionId: id }));
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${events.join('\n')}\n`);
}

describe('runSessionIndexWarmTick (RUSH-2682, RUSH-2691)', () => {
  it('indexes a transcript whose cwd is NOT the daemon cwd, and says how many', async () => {
    const projectCwd = path.join(testHome, 'work', 'proj');
    const id = '11111111-2222-4333-8444-555555555555';
    writeTranscript(id, projectCwd);

    // Run as the daemon does: from $HOME. Pre-fix this reported indexed: 0.
    process.chdir(testHome);

    const first = await runSessionIndexWarmTick();
    expect(first.claimed, 'nothing else holds the scan claim in this test').toBe(true);
    expect(first.indexed, 'a transcript outside the daemon cwd must still count').toBeGreaterThan(0);

    // The postcondition that matters is the ROW, not the number: the session is
    // resolvable by id, which is what `sessions preview <id>` needs (RUSH-2682).
    expect(db.getSessionById(id)?.cwd).toBe(projectCwd);
  });

  it('is incremental — an unchanged transcript is not re-parsed on the next tick', async () => {
    // Self-contained on purpose: write a transcript, prove the tick parses it,
    // THEN prove the next tick reports 0. Asserting only the 0 would pass with
    // nothing on disk at all — indistinguishable from "the scanner skipped an
    // unchanged file", and unfailable in the same way as the mock seam this
    // suite replaced.
    const id = '44444444-3333-4222-8111-000000000000';
    writeTranscript(id, path.join(testHome, 'work', 'incremental'));

    const first = await runSessionIndexWarmTick();
    expect(first.indexed, 'the new transcript must be parsed first').toBeGreaterThan(0);
    expect(db.getSessionById(id)).not.toBeNull();

    const second = await runSessionIndexWarmTick();
    expect(second.claimed).toBe(true);
    expect(second.indexed, 'unchanged files must not be re-parsed').toBe(0);
  });

  it('picks up a NEW transcript on a later tick', async () => {
    const id = '99999999-8888-4777-8666-555555555555';
    writeTranscript(id, path.join(testHome, 'work', 'other'));

    const third = await runSessionIndexWarmTick();
    expect(third.indexed, 'a newly written transcript must be parsed').toBeGreaterThan(0);
    expect(db.getSessionById(id), 'the new session must be resolvable by id').not.toBeNull();
  });

  it('publishes an indexed Claude title into the canonical active-session journal', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const projectCwd = path.join(testHome, 'work', 'watch-label');
    writeTranscript(id, projectCwd, 'Remote tab title synced');

    const indexed = await runSessionIndexWarmTick();
    expect(indexed.indexed, 'the title event must reach the real index').toBeGreaterThan(0);
    expect(db.getSessionById(id)?.label).toBe('Remote tab title synced');

    const raw: ActiveSession = {
      context: 'terminal',
      kind: 'claude',
      sessionId: id,
      cwd: projectCwd,
      topic: 'index me',
      status: 'running',
    };
    await runActiveSessionsWarmTick({ gather: async () => [raw] });

    const published = sessionCache.readActiveSessionsCache('local')?.sessions.find((row) => row.sessionId === id);
    expect(published?.label).toBe('Remote tab title synced');
    const records = fs.readFileSync(sessionCache.activeSessionsJournalPath(), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const journalRow = records.flatMap((record) => record.upserts).find((row) => row.sessionId === id);
    expect(journalRow?.label).toBe('Remote tab title synced');
  });
});
