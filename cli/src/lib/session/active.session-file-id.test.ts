import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

// RUSH-2691: findSessionFileForKind dropped `sessionId` for non-Claude harnesses, so two
// same-harness agents in one cwd both got the last-touched transcript. `sessions preview` then
// showed the other session's digest. An unresolvable id must yield undefined.

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
// realpath'd: on macOS os.tmpdir() is a symlink, and `latestSessionFileForCwd` realpaths the cwd
// it queries (db.ts:2605) while the upsert stores it raw (db.ts:2274), so the id-less fallback
// silently finds nothing. Only the nightly macOS leg would catch it.
const testHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-active-file-id-')));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const db = await import('./db.js');
const { findSessionFileForKind } = await import('./active.js');

const CWD = path.join(testHome, 'project');
fs.mkdirSync(CWD, { recursive: true });

afterAll(() => {
  db.closeDB();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(testHome, { recursive: true, force: true });
});

beforeEach(() => {
  db.getDB().exec('DELETE FROM sessions');
});

/** Index one real transcript for `agent` in CWD and return its path. */
function indexSession(id: string, agent: string, lastActivity: string): string {
  const filePath = path.join(CWD, `${agent}-${id}.jsonl`);
  fs.writeFileSync(filePath, '{}\n');
  const meta: SessionMeta = {
    id,
    shortId: id.slice(0, 8),
    agent: agent as SessionMeta['agent'],
    timestamp: '2026-08-15T10:00:00.000Z',
    lastActivity,
    cwd: CWD,
    filePath,
    messageCount: 2,
  };
  const stat = fs.statSync(filePath);
  db.upsertSessionsBatch([{ meta, content: 'hello', scan: { fileMtimeMs: stat.mtimeMs, fileSize: stat.size } }]);
  return filePath;
}

// Activity times are relative to now: `latestSessionFileForCwd` filters on ACTIVE_SESSION_STALE_MS
// (24h), so a fixed timestamp would age out and the tests would silently lose the power to catch
// the regression.
const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

describe('findSessionFileForKind — a known id selects its OWN transcript', () => {
  it('two co-located codex sessions each resolve to their own file, not the newest', () => {
    const older = indexSession('01a00504-8bd8-79c2-aabe-54403300aefc', 'codex', minsAgo(20));
    const newer = indexSession('01a00504-8ac6-7e10-9799-da813a02c003', 'codex', minsAgo(3));

    // The bug: this returned `newer` for BOTH ids, so previewing the older
    // session rendered the newer session's transcript under its header.
    expect(findSessionFileForKind('codex', CWD, '01a00504-8bd8-79c2-aabe-54403300aefc')).toBe(older);
    expect(findSessionFileForKind('codex', CWD, '01a00504-8ac6-7e10-9799-da813a02c003')).toBe(newer);
  });

  it('an id the index has not reached yet yields undefined, NOT a co-located sibling', () => {
    const sibling = indexSession('01a00504-8ac6-7e10-9799-da813a02c003', 'codex', minsAgo(3));

    const resolved = findSessionFileForKind('codex', CWD, 'ffffffff-0000-0000-0000-000000000000');
    expect(resolved).toBeUndefined();
    expect(resolved).not.toBe(sibling);
  });

  it('a row belonging to a DIFFERENT harness is refused for that id', () => {
    // Same id indexed under grok; a live codex process claiming it is not the
    // same conversation, so returning grok's transcript would misattribute again.
    indexSession('01a00504-8ac6-7e10-9799-da813a02c003', 'grok', minsAgo(3));

    expect(findSessionFileForKind('codex', CWD, '01a00504-8ac6-7e10-9799-da813a02c003')).toBeUndefined();
  });

  it('no id still falls back to the newest in cwd — the single-session heuristic is intact', () => {
    indexSession('01a00504-8bd8-79c2-aabe-54403300aefc', 'codex', minsAgo(20));
    const newer = indexSession('01a00504-8ac6-7e10-9799-da813a02c003', 'codex', minsAgo(1));

    expect(findSessionFileForKind('codex', CWD, undefined)).toBe(newer);
  });

  it('an untracked harness still yields undefined', () => {
    expect(findSessionFileForKind('not-a-harness', CWD, '01a00504-8ac6-7e10-9799-da813a02c003')).toBeUndefined();
  });
});
