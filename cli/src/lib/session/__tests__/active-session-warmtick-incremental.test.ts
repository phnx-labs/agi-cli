import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// PHNX-3411 regression guard: the daemon's session-index warm tick must not fully re-parse a
// growing Claude session each tick. That O(session) sync burst starves `browser.sock`. A grown
// session must resume from its stored offset. Real fs, sqlite, no mocks.

const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-warmtick-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

type Discover = typeof import('../discover.js');
type DB = typeof import('../db.js');

let discover: Discover;
let db: DB;

const LIVE_PROJECTS = path.join(tmpHome, '.claude', 'projects');
const PROJECT_DIR = path.join(LIVE_PROJECTS, '-home-u-repo');

function line(obj: object): string {
  return JSON.stringify(obj);
}

function sessionFile(id: string): string {
  return path.join(PROJECT_DIR, `${id}.jsonl`);
}

function writeTranscript(id: string, events: object[]): string {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  const fp = sessionFile(id);
  fs.writeFileSync(fp, events.map(line).join('\n') + '\n', 'utf-8');
  bumpMtimeToNow(fp, 0);
  return fp;
}

function appendTranscript(id: string, events: object[]): void {
  fs.appendFileSync(sessionFile(id), events.map(line).join('\n') + '\n', 'utf-8');
}

/** Push mtime forward so an append is never read as a clock-rewind and the
 *  ledger stamp actually changes (a second write in the same wall-clock second
 *  can leave mtime identical, which reads as "unchanged" and skips). */
function bumpMtimeToNow(fp: string, plusSeconds: number): void {
  const t = Math.floor(Date.now() / 1000) + plusSeconds;
  fs.utimesSync(fp, t, t);
}

/** Age every ledger stamp past the 5s active-append debounce so a grown file
 *  re-scanned in the same test tick is NOT deferred by shouldDeferRecentAppend. */
function agePriorScans(): void {
  db.getDB().prepare('UPDATE scan_ledger SET scanned_at = ?').run(Date.now() - 60_000);
}

async function runScan(): Promise<void> {
  agePriorScans();
  await discover.discoverSessions({ agent: 'claude', all: true });
}

/** One tool-heavy assistant turn + its tool_result user turn — the shape that
 *  makes redaction (sanitizeToolEvidenceText/redactSecrets) the per-line cost. */
function toolTurn(id: string, turn: number, toolsPerTurn: number): object[] {
  const ts = new Date(Date.UTC(2026, 5, 28, 0, turn, 0)).toISOString();
  const uses = Array.from({ length: toolsPerTurn }, (_, i) => ({
    type: 'tool_use',
    id: `${id}-t${turn}-${i}`,
    name: 'Bash',
    input: { command: `echo run ${turn}-${i}; export TOKEN=sk-not-a-real-secret-${turn}${i}` },
  }));
  const results = uses.map((u) => ({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: (u as any).id, content: `ok ${turn}` }] },
  }));
  return [
    {
      type: 'assistant',
      timestamp: ts,
      uuid: `${id}-a${turn}`,
      message: { id: `${id}-m${turn}`, model: 'claude-sonnet-4-5', content: uses, usage: { input_tokens: 100, output_tokens: 20 } },
    },
    ...results,
  ];
}

function baseEvents(id: string, turns: number, toolsPerTurn: number): object[] {
  const head = [
    { type: 'user', timestamp: '2026-06-28T00:00:00.000Z', cwd: '/home/u/repo', gitBranch: 'PHNX-3411', version: '2.1.0', entrypoint: 'cli', message: { role: 'user', content: `long active session ${id}` } },
  ];
  const body: object[] = [];
  for (let t = 1; t <= turns; t++) body.push(...toolTurn(id, t, toolsPerTurn));
  return [...head, ...body];
}

beforeAll(async () => {
  db = await import('../db.js');
  discover = await import('../discover.js');
  db.getDB();
});

beforeEach(() => {
  discover.__resetClaudeScanBranchCountsForTest();
});

afterAll(() => {
  db.closeDB();
  if (REAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = REAL_HOME;
  if (REAL_USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = REAL_USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('daemon warm tick over an actively-growing Claude session (PHNX-3411)', () => {
  it('resumes from the stored offset every tick instead of a full re-parse', async () => {
    const id = 'active-hub-session';
    // A large starting transcript (a multi-hour session with many tool calls).
    const fp = writeTranscript(id, baseEvents(id, 60, 8));

    // Tick 0: the first scan is necessarily a FULL parse (no prior continuation).
    discover.__resetClaudeScanBranchCountsForTest();
    await runScan();
    let counts = discover.__claudeScanBranchCountsForTest();
    expect(counts.full, 'first scan of a new session is a full parse').toBe(1);
    expect(counts.incremental, 'first scan is not incremental').toBe(0);

    const startSize = fs.statSync(fp).size;

    // Now simulate 12 warm ticks, each with the session growing by one turn —
    // exactly the daemon's steady state for an interactive, live Claude session.
    for (let tick = 1; tick <= 12; tick++) {
      appendTranscript(id, toolTurn(id, 100 + tick, 8));
      bumpMtimeToNow(fp, tick);
      discover.__resetClaudeScanBranchCountsForTest();
      await runScan();
      counts = discover.__claudeScanBranchCountsForTest();
      expect(counts.full, `tick ${tick}: must NOT full re-parse a grown same-session file`).toBe(0);
      expect(counts.incremental, `tick ${tick}: must resume incrementally`).toBe(1);
    }

    // The file grew substantially; the invariant is that each tick paid for the
    // APPEND, not the whole transcript — which is exactly what the incremental
    // branch guarantees (per-tick reparse scope == appended bytes).
    expect(fs.statSync(fp).size).toBeGreaterThan(startSize);
  });
});
