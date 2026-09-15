import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-previous-rows-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let db: typeof import('../db.js');
let readPreviousSessionsForWatch: typeof import('./watch.js').readPreviousSessionsForWatch;
const scope = 'test-device';
const now = Date.now();

function seed(meta: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'agent'>, exists: boolean): void {
  const filePath = path.join(tmpHome, `${meta.id}.jsonl`);
  if (exists) fs.writeFileSync(filePath, '{}\n');
  const timestamp = meta.timestamp ?? new Date(now - 2 * 60 * 60 * 1_000).toISOString();
  db.upsertSession({
    shortId: meta.id.slice(0, 8),
    timestamp,
    lastActivity: meta.lastActivity ?? timestamp,
    machine: scope,
    filePath,
    ...meta,
  } as SessionMeta, 'fixture', {
    fileMtimeMs: exists ? fs.statSync(filePath).mtimeMs : now,
    fileSize: exists ? fs.statSync(filePath).size : 0,
  });
}

beforeAll(async () => {
  db = await import('../db.js');
  ({ readPreviousSessionsForWatch } = await import('./watch.js'));
  db.getDB();
});

afterAll(() => {
  db.closeDB();
  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('readPreviousSessionsForWatch', () => {
  it('filters newer ineligible rows before applying the 50-row cap', () => {
    // Newest rows, all with a missing transcript: ineligible, and they must not
    // consume the cap ahead of the older rows that ARE readable.
    for (let i = 0; i < 60; i++) {
      const timestamp = new Date(now - i * 1_000).toISOString();
      seed({ id: `missing-${i}`, agent: 'codex', timestamp, lastActivity: timestamp }, false);
      // OpenClaw writes no parseable transcript, so it stays out of the query
      // even with a file on disk.
      seed({ id: `noclaw-${i}`, agent: 'openclaw', timestamp, lastActivity: timestamp }, true);
    }
    // Older, readable rows across two harnesses. Grok is here because the query
    // covers every transcript-writing harness (PHNX-3939) — it used to name only
    // claude/codex/muse/opencode, so a grok session never became a Previous row.
    for (let i = 0; i < 25; i++) {
      const timestamp = new Date(now - 24 * 60 * 60 * 1_000 - i * 1_000).toISOString();
      seed({ id: `eligible-codex-${i}`, agent: 'codex', timestamp, lastActivity: timestamp }, true);
      seed({ id: `eligible-grok-${i}`, agent: 'grok', timestamp, lastActivity: timestamp }, true);
    }

    const rows = readPreviousSessionsForWatch(scope);
    expect(rows).toHaveLength(50);
    expect(rows.every((row) => row.id.startsWith('eligible-'))).toBe(true);
    expect(rows.every((row) => row.filePath && fs.existsSync(row.filePath))).toBe(true);
    expect(rows.some((row) => row.agent === 'grok')).toBe(true);
  });
});
