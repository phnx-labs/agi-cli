import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// End-to-end proof of RUSH-2271: an archived routine transcript under
// <runsDir>/<job>/<run>/sessions/claude/projects/ is indexed as origin='routine' with its routine
// name and run id. Real fs, sqlite, no mocks. The archiver half is covered by runner.test.ts.

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-routine-origin-e2e-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('../discover.js');
type DB = typeof import('../db.js');
type State = typeof import('../../state.js');
type Versions = typeof import('../../installations/versions.js');

let discover: Discover;
let db: DB;
let state: State;
let versions: Versions;

beforeAll(async () => {
  db = await import('../db.js');
  discover = await import('../discover.js');
  state = await import('../../state.js');
  versions = await import('../../installations/versions.js');
  db.getDB(); // create schema
});

afterAll(() => {
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** A minimal but real Claude transcript (parseable by readClaudeMeta). */
function claudeTranscript(id: string): string {
  return [
    { type: 'user', timestamp: '2026-08-05T00:00:00.000Z', cwd: '/home/u/repo', version: '2.1.0', entrypoint: 'cli', message: { role: 'user', content: `run job ${id}` } },
    { type: 'assistant', timestamp: '2026-08-05T00:01:00.000Z', uuid: `${id}-a1`, message: { id: `${id}-m1`, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
}

describe('RUSH-2271 routine archive → origin=routine (e2e)', () => {
  it('indexes an archived Claude routine transcript as origin=routine linked to its run', async () => {
    const jobName = 'nightly-scan';
    const runId = '2026-08-05T00-00-00-000Z';
    const sessionId = 'routine-sess-2271';

    const transcript = claudeTranscript(sessionId);

    // The original still lives in the per-version CLAUDE_CONFIG_DIR home (origin='cli'); the
    // archive is a copy. The routine-archive scan runs after it within one discoverSessions pass,
    // so origin='routine' must win deterministically.
    const versionHomeProjects = path.join(
      versions.getVersionHomePath('claude', '2.1.0'), '.claude', 'projects', '-home-u-repo',
    );
    fs.mkdirSync(versionHomeProjects, { recursive: true });
    fs.writeFileSync(path.join(versionHomeProjects, `${sessionId}.jsonl`), transcript, 'utf-8');

    // Exactly what archiveRoutineTranscripts writes: the run's own sessions tree.
    const archiveDir = path.join(
      state.getRunsDir(), jobName, runId, 'sessions', 'claude', 'projects', '-home-u-repo',
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, `${sessionId}.jsonl`), transcript, 'utf-8');

    await discover.discoverSessions({ agent: 'claude', all: true });

    const row = db.getSessionById(sessionId);
    expect(row, 'the archived routine transcript was indexed').not.toBeNull();
    expect(row!.origin).toBe('routine');
    expect(row!.routineName).toBe(jobName);
    expect(row!.routineRunId).toBe(runId);
  });
});
